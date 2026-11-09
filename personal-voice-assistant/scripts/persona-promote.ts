/**
 * 個人設定（データ領域の KAITO.local.md）の内容を、GitHub で管理する基本設定 KAITO.md に反映する（明示的な操作のときだけ）。
 *
 *   npm run persona:promote            … 反映される項目を表示するだけ（ファイルは変更しない）
 *   npm run persona:promote -- --write … KAITO.md を書き換える（Git へのコミット・プッシュは行わない）
 *
 * 認証情報・個人情報（メールアドレス・電話番号など）が含まれていれば中止する。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPersonaPaths, loadPersona, migrateLegacyPersona } from '../server/persona.ts';
import { resolveDataDir } from '../server/memory/dataDir.ts';
import { findPersonalInfo, findSecrets, PERSONA_TITLE, renderPersonaMarkdown, type PersonaKey } from '../shared/persona.ts';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = defaultPersonaPaths(appDir, resolveDataDir());
migrateLegacyPersona(appDir, paths);
const write = process.argv.includes('--write');
const view = loadPersona(paths);
const keys = Object.keys(view.overrides) as PersonaKey[];

if (view.warnings.length) for (const w of view.warnings) console.log(`注意: ${w}`);
if (keys.length === 0) {
  console.log('個人設定はありません。KAITO.md に反映する内容はありません。');
  process.exit(0);
}
console.log(`KAITO.md に反映される項目（${keys.length}）: ${keys.map((k) => PERSONA_TITLE[k]).join('、')}`);

const issues = [...findSecrets(view.effective), ...findPersonalInfo(view.effective)];
if (issues.length) {
  console.error('中止しました。GitHub に公開される KAITO.md に、次の内容は入れられません：');
  for (const i of issues) console.error(`  - ${i.message}`);
  console.error('画面の「KAITO設定」で該当する項目を修正してから、もう一度実行してください。');
  process.exit(1);
}
if (!write) {
  console.log('確認のみ行いました（ファイルは変更していません）。反映するには: npm run persona:promote -- --write');
  process.exit(0);
}

// 既存の KAITO.md の説明コメントは残す
const current = (() => {
  try {
    return readFileSync(paths.base, 'utf8');
  } catch {
    return '';
  }
})();
const note = /<!--([\s\S]*?)-->/.exec(current)?.[1]?.trim();
writeFileSync(paths.base, renderPersonaMarkdown(view.effective, note ? { note } : {}), 'utf8');
console.log('KAITO.md を更新しました（Git へのコミット・プッシュはしていません）。');
console.log('GitHub に反映するには、内容を確認してから次を実行してください:');
console.log('  git diff KAITO.md');
console.log('  git add KAITO.md && git commit -m "KAITO.md を更新" && git push');
console.log('反映後は、画面の「すべて初期状態に戻す」で個人設定を消すと、基本設定だけで動きます。');
