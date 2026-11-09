/**
 * 記憶検索の速さの計測（合成データ。実際の記憶ではありません）。npm run bench:memory
 * 記憶 50/300/1000 件・発言 500/1万/5万件で、search_memory の処理時間（平均・中央値・最大）と AI に返す量を表示する。
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryStore } from '../server/memory/store.ts';
import { runMemoryTool } from '../server/memory/service.ts';
const words = ['開発', '予定', '天気', '広島', '会議', '買い物', '歯医者', 'コーヒー', '長期記憶', '拍手', '競馬', '株価', '旅行', '家族', '誕生日', '仕事', '読書', '映画'];
const r = (n: number) => Math.floor(Math.random() * n);
const sentence = () => Array.from({ length: 4 + r(6) }, () => words[r(words.length)]).join('の') + 'じゃけぇ、よろしく。';
const stat = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const med = s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; return `平均 ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)} / 中央値 ${med.toFixed(2)} / 最大 ${s[s.length - 1]!.toFixed(2)} ms`; };
for (const [mem, msg] of [[50, 500], [300, 10000], [1000, 50000]] as const) {
  const { store } = await openMemoryStore(mkdtempSync(path.join(os.tmpdir(), 'mb-')));
  const s = store!;
  for (let i = 0; i < mem; i++) s.addMemory({ content: `${sentence()}${i}`, category: (['preference', 'decision', 'schedule', 'other'] as const)[i % 4], origin: 'manual' });
  const now = Date.now();
  let sid = '';
  for (let i = 0; i < msg; i++) {
    if (i % 20 === 0) sid = s.startSession('wake', now - (msg - i) * 60_000);
    s.putMessage(sid, { itemId: `i${i}`, seq: i % 20, role: i % 2 ? 'assistant' : 'user', text: sentence(), status: 'final' });
  }
  const run = (args: Record<string, unknown>) => { const t: number[] = []; let out = ''; for (let k = 0; k < 15; k++) { const a = performance.now(); out = JSON.stringify(runMemoryTool(s, 'search_memory', args, { sessionId: null, now: new Date() })); t.push(performance.now() - a); } return { t, bytes: Buffer.byteLength(out) }; };
  const a = run({ query: '開発予定', target: 'memories', category: null, date_from: null, date_to: null });
  const b = run({ query: '歯医者', target: 'both', category: null, date_from: null, date_to: null });
  const c = run({ query: '', target: 'history', category: null, date_from: 'yesterday', date_to: 'yesterday' });
  const d = run({ query: '存在しない言葉', target: 'both', category: null, date_from: null, date_to: null });
  console.log(`記憶 ${mem}件・発言 ${msg}件\n  記憶「開発予定」: ${stat(a.t)}（返す量 ${a.bytes} バイト）\n  両方「歯医者」: ${stat(b.t)}（${b.bytes} バイト）\n  履歴・昨日: ${stat(c.t)}（${c.bytes} バイト）\n  該当なし: ${stat(d.t)}（${d.bytes} バイト）`);
  s.close();
}
