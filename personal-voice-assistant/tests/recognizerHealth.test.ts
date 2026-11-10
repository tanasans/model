import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecognizerHealth, REBUILD_HOLD_MS, REFRESH_AFTER_MS } from '../src/wake/recognizerHealth.ts';

test('遅れがないときは何もしない', () => {
  const h = new RecognizerHealth();
  for (let t = 0; t < 60_000; t += 100) assert.equal(h.check(t, 0.2, t, true), 'none');
  assert.equal(h.isStale(0.3), false);
});

test('1. 遅れが 2.5 秒を超えた認識結果では起動しない', () => {
  const h = new RecognizerHealth();
  assert.equal(h.isStale(2.4), false);
  assert.equal(h.isStale(2.6), true);
});

test('2. 遅れが 4 秒を超えて 3 秒続き、静かなときだけ作り直す。話している間は待つ', () => {
  const h = new RecognizerHealth();
  assert.equal(h.check(0, 5, 0, true), 'none');
  assert.equal(h.check(REBUILD_HOLD_MS - 100, 5, 0, true), 'none');
  assert.equal(h.check(REBUILD_HOLD_MS, 5, 0, false), 'none', '話している間は作り直さない');
  assert.equal(h.check(REBUILD_HOLD_MS + 500, 5, 0, true), 'rebuild');
  // 遅れが一度下がったら数え直す
  const h2 = new RecognizerHealth();
  h2.check(0, 5, 0, true);
  h2.check(1000, 1, 0, true);
  assert.equal(h2.check(3500, 5, 0, true), 'none');
});

test('2. 5 分間に 3 回を超えて作り直すことになったら、繰り返さずに止める', () => {
  const h = new RecognizerHealth();
  const actions: string[] = [];
  let t = 0;
  for (let i = 0; i < 4; i++) {
    h.check(t, 5, 0, true);
    actions.push(h.check(t + REBUILD_HOLD_MS, 5, 0, true));
    t += 20_000;
  }
  assert.deepEqual(actions, ['rebuild', 'rebuild', 'rebuild', 'give-up']);
});

test('3. 待機が 1 時間続いたら、静かで遅れがないときに認識器を作り直す', () => {
  const h = new RecognizerHealth();
  assert.equal(h.check(0, 0, REFRESH_AFTER_MS - 1, true), 'none');
  assert.equal(h.check(0, 0, REFRESH_AFTER_MS, false), 'none', '話している間はしない');
  assert.equal(h.check(0, 0, REFRESH_AFTER_MS, true), 'refresh');
});
