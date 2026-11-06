import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClapDetector, type DetectorEvent } from '../src/clap/clapDetector.ts';

const SR = 48_000;

/** 再現性のある疑似乱数 */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000 - 0.5;
  };
}

/** タイムライン上に音を重ねて 1 本の信号を作る */
class Track {
  readonly data: Float32Array;
  private rand = rng(7);
  constructor(seconds: number, noiseAmp = 0.002) {
    this.data = new Float32Array(Math.round(seconds * SR));
    for (let i = 0; i < this.data.length; i++) this.data[i] = this.rand() * 2 * noiseAmp;
  }
  private add(atMs: number, len: number, f: (i: number) => number) {
    const start = Math.round((atMs / 1000) * SR);
    for (let i = 0; i < len && start + i < this.data.length; i++) this.data[start + i]! += f(i);
  }
  /** 拍手：広帯域ノイズが鋭く立ち上がり、約 10ms で減衰 */
  clap(atMs: number, amp = 0.5) {
    const r = rng(Math.round(atMs) + 3);
    this.add(atMs, SR * 0.08, (i) => amp * 2 * r() * Math.exp(-i / (SR * 0.01)));
    return this;
  }
  /** 話し声風：150Hz 基音＋倍音、ゆっくり立ち上がり 400ms 続く */
  speech(atMs: number, ms = 400, amp = 0.3) {
    const n = Math.round((ms / 1000) * SR);
    this.add(atMs, n, (i) => {
      const t = i / SR;
      const env = Math.min(1, t / 0.04) * Math.min(1, (n - i) / (SR * 0.04));
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * 150 * h * t) / h;
      return amp * env * v * 0.5;
    });
    return this;
  }
  /** 物を置く音：80Hz の鋭い「ドン」 */
  thud(atMs: number, amp = 0.6) {
    this.add(atMs, SR * 0.15, (i) => amp * Math.sin((2 * Math.PI * 80 * i) / SR) * Math.exp(-i / (SR * 0.03)));
    return this;
  }
  /** キーボード：短いクリック音 */
  click(atMs: number, amp = 0.3) {
    const r = rng(Math.round(atMs) + 11);
    this.add(atMs, SR * 0.006, (i) => amp * 2 * r() * Math.exp(-i / (SR * 0.0015)));
    return this;
  }
}

function run(track: Track, opts: { sensitivity?: number; maxIntervalMs?: number } = {}): DetectorEvent[] {
  const d = new ClapDetector({ sampleRate: SR, sensitivity: opts.sensitivity ?? 5, maxIntervalMs: opts.maxIntervalMs ?? 600 });
  const events: DetectorEvent[] = [];
  // ブラウザと同様に 2048 サンプルずつ渡す
  for (let i = 0; i < track.data.length; i += 2048) events.push(...d.process(track.data.subarray(i, i + 2048)));
  return events;
}
const doubles = (ev: DetectorEvent[]) => ev.filter((e) => e.type === 'double-clap').length;

test('拍手2回（間隔300ms）で起動する', () => {
  const ev = run(new Track(3).clap(1200).clap(1500));
  assert.equal(doubles(ev), 1);
  const claps = ev.filter((e) => e.type === 'transient' && e.info.accepted);
  assert.equal(claps.length, 2);
});

test('拍手1回では起動しない', () => {
  assert.equal(doubles(run(new Track(3).clap(1200))), 0);
});

test('拍手3回続くと起動しない（連続音扱い）', () => {
  assert.equal(doubles(run(new Track(3).clap(1200).clap(1450).clap(1700))), 0);
});

test('間隔が最大間隔より長いと起動しない／最大間隔を広げると起動する', () => {
  const t = () => new Track(4).clap(1200).clap(2100);
  assert.equal(doubles(run(t(), { maxIntervalMs: 600 })), 0);
  assert.equal(doubles(run(t(), { maxIntervalMs: 1000 })), 1);
});

test('話し声だけでは起動しない', () => {
  const tr = new Track(4).speech(1000, 500).speech(1700, 300).speech(2200, 600);
  assert.equal(doubles(run(tr)), 0);
});

test('話し声の直後の拍手2回には反応しない（会話中の誤起動防止）', () => {
  const tr = new Track(4).speech(1000, 500).clap(1600).clap(1900);
  assert.equal(doubles(run(tr)), 0);
});

test('物を置く低い音2回では起動しない', () => {
  const ev = run(new Track(3).thud(1200).thud(1500));
  assert.equal(doubles(ev), 0);
  assert.ok(ev.some((e) => e.type === 'transient' && !e.info.accepted && e.info.reason?.includes('低い')));
});

test('キーボードの連続タイピングでは起動しない', () => {
  const tr = new Track(4);
  for (let t = 1000; t < 3000; t += 140 + ((t / 7) % 90)) tr.click(t);
  assert.equal(doubles(run(tr)), 0);
});

test('小さな拍手は感度5では無視し、感度10では反応する', () => {
  const t = () => new Track(3).clap(1200, 0.05).clap(1500, 0.05);
  assert.equal(doubles(run(t(), { sensitivity: 5 })), 0);
  assert.equal(doubles(run(t(), { sensitivity: 10 })), 1);
});

test('開始直後（騒音学習中）の音には反応しない', () => {
  assert.equal(doubles(run(new Track(2).clap(100).clap(400))), 0);
});
