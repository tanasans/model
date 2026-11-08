import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AFTER_AUDIO_MS, createEndAfterReply, MAX_WAIT_MS, WAIT_FOR_AUDIO_MS, type Timers } from '../src/endAfterReply.ts';
import { endConversationAction } from '../src/tools/kaitoTools.ts';

/** 手動で進める疑似タイマー */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => (jobs.set(++seq, { at: now + ms, fn }), seq),
    clear: (id) => void jobs.delete(id),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      jobs.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  return { timers, advance, pending: () => jobs.size };
}

test('声で終了: 別れの一言の再生が終わってから切断する', () => {
  const t = fakeTimers();
  let ended = 0;
  const e = createEndAfterReply(() => ended++, t.timers);
  e.request();
  t.advance(1000);
  e.onEvent('output_audio_buffer.started'); // 別れの一言
  t.advance(4500); // 再生中は WAIT_FOR_AUDIO_MS を過ぎても切らない
  assert.equal(ended, 0);
  e.onEvent('output_audio_buffer.stopped');
  assert.equal(ended, 0, '再生終了の直後はまだ切らない（最後の音を残す）');
  t.advance(AFTER_AUDIO_MS);
  assert.equal(ended, 1);
  t.advance(MAX_WAIT_MS);
  assert.equal(ended, 1, '切断は 1 回だけ');
  assert.equal(t.pending(), 0, 'タイマーを残さない');
});

test('声で終了: 要求時に再生中なら、その再生の終わりで切断する', () => {
  const t = fakeTimers();
  let ended = 0;
  const e = createEndAfterReply(() => ended++, t.timers);
  e.onEvent('output_audio_buffer.started');
  e.request();
  e.onEvent('output_audio_buffer.stopped');
  t.advance(AFTER_AUDIO_MS);
  assert.equal(ended, 1);
});

test('声で終了: 別れの一言が始まらなくても一定時間で必ず切断する', () => {
  const t = fakeTimers();
  let ended = 0;
  const e = createEndAfterReply(() => ended++, t.timers);
  e.request();
  t.advance(WAIT_FOR_AUDIO_MS - 1);
  assert.equal(ended, 0);
  t.advance(1);
  assert.equal(ended, 1);
});

test('声で終了: 再生が終わらなくても上限時間で切断する', () => {
  const t = fakeTimers();
  let ended = 0;
  const e = createEndAfterReply(() => ended++, t.timers);
  e.request();
  e.onEvent('output_audio_buffer.started');
  t.advance(MAX_WAIT_MS);
  assert.equal(ended, 1);
});

test('声で終了: 要求前の再生終了では切らない／会話が先に終われば何もしない／二重要求は 1 回', () => {
  const t = fakeTimers();
  let ended = 0;
  const e = createEndAfterReply(() => ended++, t.timers);
  e.onEvent('output_audio_buffer.started');
  e.onEvent('output_audio_buffer.stopped');
  t.advance(MAX_WAIT_MS * 2);
  assert.equal(ended, 0, '終了要求がなければ切らない');
  e.request();
  e.request();
  e.dispose(); // ボタンや 300 秒で先に終わった
  t.advance(MAX_WAIT_MS * 2);
  assert.equal(ended, 0);
  assert.equal(t.pending(), 0);
});

test('end_conversation: 待機も止める指示を App に渡し、会話中でなければ失敗を返す', () => {
  const calls: boolean[] = [];
  const r1 = endConversationAction({ endConversation: ({ stopStandby }) => (calls.push(stopStandby), true) }, true);
  assert.equal(r1.ok, true);
  assert.equal((r1 as { standby_stopped: boolean }).standby_stopped, true);
  const r2 = endConversationAction({ endConversation: ({ stopStandby }) => (calls.push(stopStandby), true) }, false);
  assert.equal((r2 as { standby_stopped: boolean }).standby_stopped, false);
  assert.deepEqual(calls, [true, false]);
  assert.equal(endConversationAction({ endConversation: () => false }, false).ok, false);
  assert.equal(endConversationAction({}, false).ok, false);
});
