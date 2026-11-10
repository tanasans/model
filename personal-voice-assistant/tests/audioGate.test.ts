import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioGate } from '../src/wake/audioGate.ts';

const SR = 16000;
const chunk = (amp: number, sec = 0.1) => new Float32Array(Math.round(SR * sec)).fill(amp);
const quiet = () => chunk(0.001); // 約 -60dB
const loud = () => chunk(0.1); // 約 -20dB

test('音量ゲート: 静かな間は送らず、声が来たら直前 0.6 秒から送り、静かになって 1.2 秒後に止める', () => {
  const g = new AudioGate();
  const floor = -60;
  let fed = 0;
  const feed = (x: Float32Array) => (fed += g.push(x, floor).reduce((n, c) => n + c.length, 0));
  for (let i = 0; i < 30; i++) feed(quiet()); // 3 秒の静けさ
  assert.equal(fed, 0, '静かな間は送らない');
  feed(loud()); // 3.0〜3.1 秒：声
  assert.equal(fed, Math.round(SR * 0.7), '直前 0.6 秒 + 声 0.1 秒');
  for (let i = 0; i < 11; i++) feed(quiet());
  assert.equal(g.isOpen, true, '1.2 秒たつまでは送り続ける');
  feed(quiet());
  assert.equal(g.isOpen, false);
  feed(quiet());
  assert.equal(fed, Math.round(SR * (0.7 + 1.2)), '止めた後は送らない');
  assert.ok(g.skippedSamples >= SR * 3.0);
});

test('音量ゲート: 認識器の時刻（送った音声の秒）を、待機開始からの秒に直す', () => {
  const g = new AudioGate();
  const floor = -60;
  for (let i = 0; i < 50; i++) g.push(quiet(), floor); // 0〜5 秒：静けさ
  g.push(loud(), floor); // 5.0 秒〜：送り始め（4.4 秒からの音を含む）
  for (let i = 0; i < 13; i++) g.push(quiet(), floor);
  for (let i = 0; i < 100; i++) g.push(quiet(), floor); // 長い静けさ
  g.push(loud(), floor); // 2 回目：受け取った位置 = 5.1 + 1.3 + 10 = 16.4 秒〜
  // 1 回目の区間：送った 0 秒 = 受け取った 4.4 秒
  assert.ok(Math.abs(g.toStreamSec(0) - 4.4) < 1e-6);
  assert.ok(Math.abs(g.toStreamSec(0.65) - 5.05) < 1e-6);
  // 2 回目の区間：送った 1.9 秒（0.7 + 1.2）= 受け取った 16.4 - 0.6 = 15.8 秒
  assert.ok(Math.abs(g.toStreamSec(1.9) - 15.8) < 1e-6);
  assert.ok(Math.abs(g.toStreamSec(2.5) - 16.4) < 1e-6);
});
