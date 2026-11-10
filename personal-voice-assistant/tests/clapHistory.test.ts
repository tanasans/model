import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClapDetector, type DetectorEvent, type DoubleClapDetail } from '../src/clap/clapDetector.ts';
import {
  addRecord,
  CLAP_HISTORY_KEY,
  CLAP_HISTORY_MAX,
  GUARD_WINDOW_MS,
  loadClapHistory,
  recordFromDetail,
  saveClapHistory,
  setOutcome,
  shouldPauseClap,
  type ClapTriggerRecord,
} from '../src/clap/clapHistory.ts';
import { SR, Track } from './synth.ts';

function detail(): DoubleClapDetail {
  const tr = new Track(5, -55, 2).clap(2000, { peak: 0.3 }).clap(2400, { peak: 0.28 });
  const d = new ClapDetector({ sampleRate: SR, sensitivity: 5, maxIntervalMs: 600 });
  const ev: DetectorEvent[] = [];
  for (let i = 0; i < tr.data.length; i += 2048) ev.push(...d.process(tr.data.subarray(i, i + 2048)));
  return (ev.find((e) => e.type === 'double-clap') as Extract<DetectorEvent, { type: 'double-clap' }>).detail;
}
function store(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}
const rec = (at: number, outcome: ClapTriggerRecord['outcome'], d = detail()) => recordFromDetail(d, { at, profileKind: 'standard', outcome, id: `r${at}` });

test('拍手起動の履歴: 2回の判定値・間隔・直前の静けさを数値だけで記録し、保存・復元できる', () => {
  const r = rec(1000, 'pending');
  assert.equal(r.intervalMs, 400);
  assert.equal(r.sounds.length, 2);
  for (const k of ['levelDb', 'jumpDb', 'decayDb', 'tailDb', 'crest'] as const) assert.equal(typeof r.sounds[0][k], 'number');
  const json = JSON.stringify(r);
  assert.doesNotMatch(json, /audio|transcript|text/i, '音声や会話内容は含まない');
  const st = store();
  saveClapHistory([r], st);
  assert.deepEqual(loadClapHistory(st), [r]);
  assert.deepEqual(loadClapHistory(store({ [CLAP_HISTORY_KEY]: '{bad' })), []);
  assert.deepEqual(loadClapHistory(store({ [CLAP_HISTORY_KEY]: JSON.stringify([{ id: 1 }, r]) })), [r], '壊れた記録は捨てる');
});

test('拍手起動の履歴: 最新20件だけを残し、結果（話しかけたか）を後から記録できる', () => {
  const d = detail();
  let list: ClapTriggerRecord[] = [];
  for (let i = 0; i < 25; i++) list = addRecord(list, rec(i * 1000, 'pending', d));
  assert.equal(list.length, CLAP_HISTORY_MAX);
  assert.equal(list[0]!.at, 24000);
  list = setOutcome(list, 'r24000', 'spoke');
  assert.equal(list[0]!.outcome, 'spoke');
});

test('誤起動の自動停止: 話しかけなしが10分以内に2回続いたら止める。会話あり・テスト・開始前の記録は数えない', () => {
  const d = detail();
  const now = 10 * 60_000;
  const L = (...rs: ClapTriggerRecord[]) => rs; // 新しい順
  assert.equal(shouldPauseClap(L(rec(now - 1000, 'no-speech', d)), now), false, '1回だけでは止めない');
  assert.equal(shouldPauseClap(L(rec(now - 1000, 'no-speech', d), rec(now - 60_000, 'no-speech', d)), now), true);
  assert.equal(shouldPauseClap(L(rec(now - 1000, 'no-speech', d), rec(now - 60_000, 'spoke', d)), now), false);
  assert.equal(shouldPauseClap(L(rec(now - 1000, 'no-speech', d), rec(now - 2000, 'test', d), rec(now - 3000, 'no-speech', d)), now), true);
  assert.equal(shouldPauseClap(L(rec(now - 1000, 'no-speech', d), rec(now - GUARD_WINDOW_MS - 5000, 'no-speech', d)), now), false, '間が10分以上空けば止めない');
  assert.equal(shouldPauseClap(L(rec(now - 1000, 'no-speech', d), rec(now - 60_000, 'no-speech', d)), now, now - 30_000), false, '拍手待機を入れ直した後の記録だけで判断');
});
