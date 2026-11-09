/**
 * KAITO の人格設定ファイルの読み書き（サーバー側だけ）。
 * - 基本設定 KAITO.md は読むだけ（サーバーが書き換えることはない。GitHub への反映は利用者の明示的な操作のみ）
 * - 個人設定はユーザー専用のデータ領域の KAITO.local.md に、基本設定から変更した項目だけを保存する
 * - 認証情報らしき文字列を含む設定は保存しない
 * - ログに設定の本文は出さない
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildGreetingInstructions,
  buildInstructions,
  completePersona,
  DEFAULT_PERSONA,
  diffPersona,
  findSecrets,
  mergePersona,
  parsePersonaMarkdown,
  type PersonaIssue,
  type PersonaOverrides,
  type PersonaSections,
  type PersonaView,
  renderPersonaMarkdown,
  SYSTEM_RULES,
  validatePersona,
} from '../shared/persona.js';

export const LOCAL_PERSONA_NOTE =
  'KAITO の個人設定（このパソコンだけに保存。Git 管理外）。基本設定 KAITO.md から変更した項目だけが入っています。';

export interface PersonaPaths {
  base: string;
  local: string;
}

/**
 * 既定の保存場所。基本設定は personal-voice-assistant/KAITO.md、
 * 個人設定はユーザー専用のデータ領域（記憶と同じ場所。ZIP を展開し直しても消えない）。
 */
export function defaultPersonaPaths(appDir: string, dataDir: string): PersonaPaths {
  return { base: path.join(appDir, 'KAITO.md'), local: path.join(dataDir, 'KAITO.local.md') };
}

/**
 * 以前の版の保存場所（personal-voice-assistant/local/KAITO.local.md）から個人設定を引き継ぐ。
 * 新しい場所にまだ無いときだけコピーする（元のファイルは消さない・既存を上書きしない）。
 */
export function migrateLegacyPersona(appDir: string, paths: PersonaPaths): boolean {
  const legacy = path.join(appDir, 'local', 'KAITO.local.md');
  if (!existsSync(legacy) || existsSync(paths.local) || path.resolve(legacy) === path.resolve(paths.local)) return false;
  try {
    mkdirSync(path.dirname(paths.local), { recursive: true });
    copyFileSync(legacy, paths.local);
    return true;
  } catch {
    return false;
  }
}

export class PersonaError extends Error {
  constructor(readonly issues: PersonaIssue[]) {
    super(issues.map((i) => i.message).join(' '));
  }
}

function readText(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

export function loadPersona(paths: PersonaPaths): PersonaView {
  const warnings: string[] = [];
  const baseText = readText(paths.base);
  let base: PersonaSections = DEFAULT_PERSONA;
  let baseSource: PersonaView['baseSource'] = 'builtin';
  if (baseText !== null) {
    const parsed = parsePersonaMarkdown(baseText);
    if (Object.keys(parsed.sections).length > 0) {
      base = completePersona(parsed.sections);
      baseSource = 'file';
    } else warnings.push('KAITO.md に項目が見つからないため、内蔵の初期設定を使っています。');
  } else warnings.push('KAITO.md が見つからないため、内蔵の初期設定を使っています。');

  let overrides: PersonaOverrides = {};
  const localText = readText(paths.local);
  if (localText !== null) {
    const parsed = parsePersonaMarkdown(localText);
    const problems = [...validatePersona(parsed.sections, base), ...findSecrets(parsed.sections)];
    if (problems.length) warnings.push(`個人設定に問題があるため使っていません：${problems.map((p) => p.message).join(' ')}`);
    else overrides = diffPersona(base, parsed.sections);
  }
  return { base, baseSource, overrides, effective: mergePersona(base, overrides), systemRules: SYSTEM_RULES, warnings, localPath: paths.local };
}

/** 次の会話で使う指示文と挨拶 */
export function sessionPersona(paths: PersonaPaths): { instructions: string; greetingInstructions: string | null } {
  const v = loadPersona(paths);
  return { instructions: buildInstructions(v.effective), greetingInstructions: buildGreetingInstructions(v.effective.greeting) };
}

/** 画面で編集した内容（全項目または一部）を個人設定として保存する。基本設定と同じ項目は保存しない */
export function savePersona(paths: PersonaPaths, edited: PersonaOverrides): PersonaView {
  const { base } = loadPersona(paths);
  const problems = [...validatePersona(edited, base), ...findSecrets(edited)];
  if (problems.length) throw new PersonaError(problems);
  writeLocal(paths, diffPersona(base, edited));
  return loadPersona(paths);
}

/** Markdown を取り込む（見出しがある項目だけ。既存の個人設定に上書き） */
export function importPersona(paths: PersonaPaths, markdown: string): { view: PersonaView; imported: string[]; ignored: string[] } {
  const parsed = parsePersonaMarkdown(markdown);
  const keys = Object.keys(parsed.sections);
  if (keys.length === 0) throw new PersonaError([{ key: null, message: '取り込める項目（## 役割 などの見出し）が見つかりませんでした。' }]);
  const current = loadPersona(paths);
  const view = savePersona(paths, { ...current.effective, ...parsed.sections });
  return { view, imported: keys, ignored: parsed.unknownHeadings };
}

/** 初期状態に戻す（全部、または指定した項目だけ個人設定から外す） */
export function resetPersona(paths: PersonaPaths, keys?: string[]): PersonaView {
  if (!keys) {
    rmSync(paths.local, { force: true });
    return loadPersona(paths);
  }
  const { overrides } = loadPersona(paths);
  for (const k of keys) delete (overrides as Record<string, string>)[k];
  writeLocal(paths, overrides);
  return loadPersona(paths);
}

function writeLocal(paths: PersonaPaths, overrides: PersonaOverrides): void {
  if (Object.keys(overrides).length === 0) {
    rmSync(paths.local, { force: true });
    return;
  }
  mkdirSync(path.dirname(paths.local), { recursive: true });
  const tmp = `${paths.local}.tmp`;
  writeFileSync(tmp, renderPersonaMarkdown(overrides, { title: 'KAITO 個人設定', note: LOCAL_PERSONA_NOTE }), 'utf8');
  renameSync(tmp, paths.local); // 途中で止まっても壊れたファイルを残さない
}
