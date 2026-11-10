import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryStore, SCHEMA_VERSION } from '../server/memory/store.ts';
import { embedPending, runMemoryToolAsync } from '../server/memory/service.ts';
import type { MemoryAi } from '../server/memory/ai.ts';

/** OpenAI の代わり：言葉ごとの簡単な数値化（「旅」「宮島」などを同じ向きにする）。要約は先頭を返す */
function fakeAi(calls: string[]): MemoryAi {
  const axes = [/旅|宮島|観光|出かけ/, /歯|医者|病院/, /開発|プログラム|KAITO/];
  return {
    models: { summary: 'fake', embedding: 'fake' },
    async embed(texts) {
      calls.push(`embed:${texts.length}`);
      return texts.map((t) => Float32Array.from(axes.map((re) => (re.test(t) ? 1 : 0.01))));
    },
    async summarize(t) {
      calls.push('summary');
      return `要約：${t.slice(0, 20)}`;
    },
  };
}
const NOW = new Date();

test('データ形式 v3：要約と埋め込みの列を追加', async () => {
  assert.equal(SCHEMA_VERSION, 3);
  const { store } = await openMemoryStore(mkdtempSync(path.join(os.tmpdir(), 'kaito-v3-')));
  assert.equal(store!.getSettings().summaryEnabled, false, '既定は OFF');
  assert.equal(store!.getSettings().semanticEnabled, false, '既定は OFF');
  store!.close();
});

test('意味検索：OFF のときは OpenAI を呼ばない。ON なら、言葉が違っても近い記憶を見つける', async () => {
  const { store } = await openMemoryStore(mkdtempSync(path.join(os.tmpdir(), 'kaito-sem-')));
  const s = store!;
  const calls: string[] = [];
  const ai = fakeAi(calls);
  s.addMemory({ content: '春に宮島へ行く予定', category: 'schedule', origin: 'voice' });
  s.addMemory({ content: '歯医者は木曜日', category: 'schedule', origin: 'voice' });
  const ctx = { sessionId: null, now: NOW };
  const off = await runMemoryToolAsync(s, 'search_memory', { query: '旅行', target: 'memories' }, ctx, ai);
  assert.equal(off.found, 0);
  assert.deepEqual(calls, [], 'OFF のときは呼ばない');
  s.updateSettings({ semanticEnabled: true });
  assert.equal(await embedPending(s, ai), 2);
  const on = await runMemoryToolAsync(s, 'search_memory', { query: '旅行', target: 'memories' }, ctx, ai);
  assert.equal(on.semantic, true);
  assert.deepEqual((on.memories as Array<{ content: string }>).map((m) => m.content), ['春に宮島へ行く予定']);
  // 通常の検索で見つかるときは、意味検索（OpenAI）を使わない
  calls.length = 0;
  await runMemoryToolAsync(s, 'search_memory', { query: '歯医者', target: 'memories' }, ctx, ai);
  assert.deepEqual(calls, []);
  // 削除した記憶は意味検索にも出ない
  const id = s.searchMemories({ query: '宮島' })[0]!.id;
  s.deleteMemory(id);
  const after = await runMemoryToolAsync(s, 'search_memory', { query: '旅行', target: 'memories' }, ctx, ai);
  assert.equal(after.found, 0);
  s.close();
});

test('会話の要約：要約は会話履歴の検索に含まれる（ON のとき）', async () => {
  const { store } = await openMemoryStore(mkdtempSync(path.join(os.tmpdir(), 'kaito-sum-')));
  const s = store!;
  const sid = s.startSession('wake', NOW.getTime() - 1000);
  s.putMessage(sid, { itemId: 'a', seq: 1, role: 'user', text: '来月の出張の予定を立てたい', status: 'final' });
  s.setSummary(sid, '来月の大阪出張の日程を相談した。');
  const ctx = { sessionId: null, now: NOW };
  const off = await runMemoryToolAsync(s, 'search_memory', { query: '大阪出張', target: 'history' }, ctx, null);
  assert.equal(off.summaries, undefined, 'OFF のときは要約を使わない');
  s.updateSettings({ summaryEnabled: true });
  const on = await runMemoryToolAsync(s, 'search_memory', { query: '大阪出張', target: 'history' }, ctx, null);
  assert.deepEqual((on.summaries as Array<{ summary: string }>).map((x) => x.summary), ['来月の大阪出張の日程を相談した。']);
  assert.match(s.transcriptFor(sid), /ユーザー：来月の出張/);
  s.close();
});
