import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildGreetingInstructions,
  buildInstructions,
  DEFAULT_PERSONA,
  findPersonalInfo,
  findSecrets,
  normalizeGreeting,
  parsePersonaMarkdown,
  PERSONA_KEYS,
  renderPersonaMarkdown,
} from '../shared/persona.ts';
import { importPersona, loadPersona, PersonaError, resetPersona, savePersona, sessionPersona, type PersonaPaths } from '../server/persona.ts';

const APP = path.resolve(import.meta.dirname, '..');
const KAITO_MD = readFileSync(path.join(APP, 'KAITO.md'), 'utf8');

function tmpPaths(withBase = true): PersonaPaths {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kaito-persona-'));
  const p = { base: path.join(dir, 'KAITO.md'), local: path.join(dir, 'local', 'KAITO.local.md') };
  if (withBase) writeFileSync(p.base, KAITO_MD);
  return p;
}

test('KAITO.md: 全項目があり、広島弁と起動時の挨拶「はい、カイトです。」が初期設定に入っている', () => {
  const { sections, unknownHeadings } = parsePersonaMarkdown(KAITO_MD);
  assert.deepEqual(Object.keys(sections).sort(), [...PERSONA_KEYS].sort());
  assert.deepEqual(unknownHeadings, []);
  assert.match(sections.style!, /広島弁で会話/);
  assert.equal(sections.greeting, 'はい、カイトです。');
  assert.match(sections.banned!, /「結論から言います」/);
});

test('KAITO.md: 認証情報・個人情報が含まれていない（GitHub に公開されるため）', () => {
  const { sections } = parsePersonaMarkdown(KAITO_MD);
  assert.deepEqual(findSecrets(sections), []);
  assert.deepEqual(findPersonalInfo(sections), []);
  assert.deepEqual(findPersonalInfo(DEFAULT_PERSONA), []);
});

test('個人設定の保存先 local/ は Git 管理外、KAITO.md は Git 管理', () => {
  const ignored = (f: string) => {
    try {
      execFileSync('git', ['check-ignore', '-q', f], { cwd: APP });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(ignored('local/KAITO.local.md'), true);
  assert.equal(ignored('KAITO.md'), false);
});

test('Markdown: 書き出し→取り込みで内容が変わらない／コメント・タイトル・不明な見出しは取り込まない', () => {
  const md = renderPersonaMarkdown(DEFAULT_PERSONA, { note: '説明' });
  assert.deepEqual(parsePersonaMarkdown(md).sections, DEFAULT_PERSONA);
  const r = parsePersonaMarkdown('# タイトル\n説明\n<!-- ## 役割\nコメント -->\n## 話し方\n標準語で\n## 好きな食べ物\nカレー\r\n## 起動時の挨拶\n「おう、カイトじゃ。」\n');
  assert.deepEqual(r.sections, { style: '標準語で', greeting: 'おう、カイトじゃ。' });
  assert.deepEqual(r.unknownHeadings, ['好きな食べ物']);
  assert.equal(normalizeGreeting('- 「はい、カイトです。」'), 'はい、カイトです。');
});

test('指示文: 挨拶は指示文に入れず接続直後の 1 回だけ。空なら挨拶しない。固定ルールは常に入る', () => {
  const ins = buildInstructions(DEFAULT_PERSONA);
  assert.doesNotMatch(ins, /# 起動時の挨拶/);
  assert.match(ins, /会話の途中で「はい、カイトです」などと名乗り直したり、挨拶を繰り返したりしないでください/);
  assert.match(buildGreetingInstructions('はい、カイトです。')!, /^「はい、カイトです。」とだけ/);
  assert.equal(buildGreetingInstructions('  '), null);
  const emptied = buildInstructions({ ...DEFAULT_PERSONA, privacy: '', rules: '' });
  for (const t of ['実行操作は、現在一切行えません', 'get_weather_forecast', 'end_conversation', '認証情報']) assert.ok(emptied.includes(t), t);
});

test('個人設定: 変更した項目だけをローカルに保存し、次の会話の指示文に反映する', () => {
  const paths = tmpPaths();
  assert.equal(existsSync(paths.local), false);
  const before = sessionPersona(paths);
  assert.equal(before.instructions, buildInstructions(DEFAULT_PERSONA));

  const v = savePersona(paths, { ...DEFAULT_PERSONA, style: '- 標準語で話してください。', greeting: '「おう、カイトじゃ。」' });
  assert.deepEqual(Object.keys(v.overrides).sort(), ['greeting', 'style'], '同じ内容の項目は保存しない');
  const local = readFileSync(paths.local, 'utf8');
  assert.match(local, /## 話し方\n\n- 標準語で話してください。/);
  assert.doesNotMatch(local, /## 役割/);
  assert.equal(readFileSync(paths.base, 'utf8'), KAITO_MD, 'KAITO.md は書き換えない');

  const after = sessionPersona(paths);
  assert.match(after.instructions, /標準語で話してください/);
  assert.doesNotMatch(after.instructions, /広島弁で会話/);
  assert.match(after.greetingInstructions!, /「おう、カイトじゃ。」とだけ/);
});

test('個人設定: 認証情報を含む・長すぎる設定は保存しない（既存の個人設定はそのまま）', () => {
  const paths = tmpPaths();
  savePersona(paths, { extra: '天気は大阪を優先' });
  const saved = readFileSync(paths.local, 'utf8');
  assert.throws(() => savePersona(paths, { extra: 'APIキー: sk-abcdefghijklmnopqrstuvwx' }), PersonaError);
  assert.throws(() => savePersona(paths, { extra: 'パスワード：hunter22' }), PersonaError);
  assert.throws(() => savePersona(paths, { greeting: 'あ'.repeat(61) }), PersonaError);
  assert.equal(readFileSync(paths.local, 'utf8'), saved);
  // 個人情報は個人設定（ローカル）には保存できる
  assert.doesNotThrow(() => savePersona(paths, { extra: '連絡先は me@example.com' }));
});

test('初期状態に戻す: 項目ごと・全部', () => {
  const paths = tmpPaths();
  savePersona(paths, { style: '標準語', extra: 'メモ' });
  assert.deepEqual(Object.keys(resetPersona(paths, ['style']).overrides), ['extra']);
  const v = resetPersona(paths);
  assert.deepEqual(v.overrides, {});
  assert.equal(existsSync(paths.local), false);
  assert.deepEqual(v.effective, v.base);
});

test('インポート: 見出しのある項目だけ取り込み、基本設定と同じ項目は保存しない', () => {
  const paths = tmpPaths();
  const r = importPersona(paths, '# 何か\n## 回答ルール\n- 短く答える\n## 役割\n' + DEFAULT_PERSONA.role + '\n## 謎\nx\n');
  assert.deepEqual(r.imported.sort(), ['role', 'rules']);
  assert.deepEqual(r.ignored, ['謎']);
  assert.deepEqual(Object.keys(r.view.overrides), ['rules']);
  assert.throws(() => importPersona(paths, 'ただの文章'), PersonaError);
  assert.throws(() => importPersona(paths, '## その他の指示\ntoken = ghp_abcdefghijklmnopqrstuvwxyz123456'), PersonaError);
});

test('読み込み: KAITO.md が無ければ内蔵の初期設定、壊れた個人設定は使わず警告', () => {
  const noBase = tmpPaths(false);
  const v = loadPersona(noBase);
  assert.equal(v.baseSource, 'builtin');
  assert.deepEqual(v.effective, DEFAULT_PERSONA);
  assert.ok(v.warnings.length > 0);

  const paths = tmpPaths();
  savePersona(paths, { extra: 'メモ' });
  writeFileSync(paths.local, `## 起動時の挨拶\n${'長'.repeat(200)}\n`);
  const w = loadPersona(paths);
  assert.deepEqual(w.overrides, {});
  assert.match(w.warnings.join(), /個人設定に問題がある/);
});

test('検査: 個人情報（メール・電話番号）と認証情報を見つける', () => {
  assert.equal(findPersonalInfo({ extra: 'mail: a.b@example.co.jp' }).length, 1);
  assert.equal(findPersonalInfo({ extra: '電話 090-1234-5678' }).length, 1);
  assert.equal(findPersonalInfo({ extra: '〒730-0011' }).length, 1);
  assert.equal(findSecrets({ extra: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUV' }).length, 1);
  assert.equal(findSecrets({ extra: 'トークンは使わない。パスワードの話はしない。' }).length, 0, '説明文は誤検出しない');
  assert.equal(findPersonalInfo({ style: '十二・五度、降水確率30パーセント、14時、1〜3文' }).length, 0);
});
