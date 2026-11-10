import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LatencyTrace, loadLatency, parseServerTiming, saveLatency, span, stat, type LatencyRecord } from '../src/latency/latencyTrace.ts';
import { DB_FILE, migrateToV2, openMemoryStore, SCHEMA_VERSION } from '../server/memory/store.ts';
import { runMemoryTool } from '../server/memory/service.ts';

test('計測: 各段階の時刻を最初の 1 回だけ記録し、最も早い時刻からの経過 ms にする', () => {
  const out: LatencyRecord[] = [];
  const t = new LatencyTrace('wake', (r) => out.push(r));
  t.mark('speechEnd', 1000);
  t.mark('recognized', 1880);
  t.mark('trigger', 1890);
  t.mark('trigger', 5000); // 2 回目は無視
  t.mark('firstSound', 3100);
  t.value('server.secret', 412.345);
  t.note('Realtime の挨拶');
  t.finish();
  t.finish();
  assert.equal(out.length, 1, '1 回だけ記録');
  assert.deepEqual(out[0]!.marks, { speechEnd: 0, recognized: 880, trigger: 890, firstSound: 2100 });
  assert.equal(out[0]!.values['server.secret'], 412.3);
  assert.equal(span(out[0]!, 'trigger', 'firstSound'), 1210);
  assert.equal(span(out[0]!, 'trigger', 'missing'), null);
});

test('計測: サーバー内訳（Server-Timing）を読む', () => {
  assert.deepEqual(parseServerTiming('persona;dur=1.2, memory;dur=0.4, secret;dur=410.5'), [['persona', 1.2], ['memory', 0.4], ['secret', 410.5]]);
  assert.deepEqual(parseServerTiming(null), []);
  assert.deepEqual(parseServerTiming('x;desc=a'), []);
});

test('計測: 平均・中央値・最大', () => {
  assert.deepEqual(stat([300, 100, 200]), { n: 3, mean: 200, median: 200, max: 300 });
  assert.deepEqual(stat([100, 200, 300, 1000]), { n: 4, mean: 400, median: 250, max: 1000 });
  assert.equal(stat([]), null);
});

test('計測: 保存は数値のみで、壊れたデータは無視する', () => {
  const m = new Map<string, string>();
  const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  const r: LatencyRecord = { id: 'a', kind: 'memory', at: 1, marks: { speechEnd: 0, toolRequested: 900 }, values: { sqliteMs: 0.4 }, notes: ['search_memory'] };
  saveLatency([r], st);
  assert.deepEqual(loadLatency(st), [r]);
  m.set('pva.latency.v1', '{bad');
  assert.deepEqual(loadLatency(st), []);
});

test('記憶データ形式 v2: v1 のデータベースを、内容を変えずに移行し、検索できる', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kaito-v1-'));
  const first = await openMemoryStore(dir);
  const s = first.store!;
  const sid = s.startSession('manual', Date.now() - 1000);
  s.putMessage(sid, { itemId: 'a', seq: 1, role: 'user', text: '来週の歯医者を覚えといて', status: 'final' });
  s.close();
  // v1 の状態に戻す（norm 列と索引を外す）
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, DB_FILE));
  db.exec('DROP INDEX IF EXISTS idx_sessions_started; ALTER TABLE messages DROP COLUMN norm; PRAGMA user_version = 1;');
  db.close();
  const again = await openMemoryStore(dir);
  assert.equal(again.error, null);
  assert.ok(SCHEMA_VERSION >= 2);
  const r = runMemoryTool(again.store!, 'search_memory', { query: '歯医者', target: 'history' }, { sessionId: null, now: new Date() });
  assert.deepEqual((r.history as Array<{ text: string }>).map((h) => h.text), ['来週の歯医者を覚えといて']);
  again.store!.close();
  const db2 = new DatabaseSync(path.join(dir, DB_FILE));
  assert.equal((db2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION, '最新の形式まで移行');
  assert.doesNotThrow(() => migrateToV2(db2), '2 回実行しても壊れない');
  db2.close();
});

test('会話履歴の検索: 新しい発言が 3000 件以上あっても、古い会話まで全期間を検索する（v1 の取りこぼしの修正）', async () => {
  const { store } = await openMemoryStore(mkdtempSync(path.join(os.tmpdir(), 'kaito-old-')));
  const s = store!;
  const old = s.startSession('wake', Date.now() - 90 * 86_400_000);
  s.putMessage(old, { itemId: 'o', seq: 1, role: 'user', text: '宮島の旅行は春にする', status: 'final' });
  let sid = '';
  for (let i = 0; i < 3200; i++) {
    if (i % 20 === 0) sid = s.startSession('manual', Date.now() - (3200 - i) * 1000);
    s.putMessage(sid, { itemId: `i${i}`, seq: i % 20, role: 'user', text: `今日の天気と予定の話 ${i}`, status: 'final' });
  }
  const r = runMemoryTool(s, 'search_memory', { query: '宮島 旅行', target: 'history' }, { sessionId: null, now: new Date() });
  assert.deepEqual((r.history as Array<{ text: string }>).map((h) => h.text), ['宮島の旅行は春にする']);
  const none = runMemoryTool(s, 'search_memory', { query: '存在しない言葉', target: 'both' }, { sessionId: null, now: new Date() });
  assert.equal(none.found, 0);
  s.close();
});
