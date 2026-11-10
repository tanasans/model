/**
 * キーボードのタイピング音による拍手の誤起動対策（v5）。
 * 実機の音は使えないため、1 打鍵＝押す音＋離す音、キーごとのばらつき、2 打鍵だけの操作、考える間を含む合成音で確認する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClapDetector, type ClapProfile, type DetectorEvent } from '../src/clap/clapDetector.ts';
import { CALIB_TIMING, CalibrationRun, sanitizeProfile } from '../src/clap/calibration.ts';
import { SR, Track, dbToAmp, rng } from './synth.ts';

function run(track: Track, o: { sensitivity?: number; maxIntervalMs?: number; profile?: ClapProfile } = {}): DetectorEvent[] {
  const d = new ClapDetector({ sampleRate: SR, sensitivity: o.sensitivity ?? 5, maxIntervalMs: o.maxIntervalMs ?? 600, profile: o.profile });
  const ev: DetectorEvent[] = [];
  for (let i = 0; i < track.data.length; i += 2048) ev.push(...d.process(track.data.subarray(i, i + 2048)));
  return ev;
}
const doubles = (ev: DetectorEvent[]) => ev.filter((e) => e.type === 'double-clap');
const reasons = (ev: DetectorEvent[]) => ev.flatMap((e) => (e.type === 'sequence-cancelled' ? [e.reason] : []));

test('実機に近いタイピング（押す音＋離す音・2打鍵だけの操作）: キーボードの音量3段階×2分・感度5/7で誤起動0回', () => {
  let n = 0;
  for (const peak of [0.1, 0.2, 0.4]) for (const seed of [1, 2]) {
    const tr = new Track(121, -55, seed).typingReal(500, 120, peak, seed * 31 + Math.round(peak * 100));
    n += doubles(run(tr)).length + doubles(run(tr, { sensitivity: 7, maxIntervalMs: 500 })).length;
  }
  assert.equal(n, 0);
});

test('1回のキー操作（押す音→離す音）を拍手2回と誤認しない', () => {
  for (let s = 0; s < 10; s++) {
    const tr = new Track(4, -55, s).keystroke(2000, 0.3, s + 7, { big: s % 2 === 0 });
    const ev = run(tr);
    assert.equal(doubles(ev).length, 0, `seed ${s}`);
  }
  // 間隔が短すぎる並びは理由付きで取り消す
  const ev = run(new Track(4, -55, 1).clap(2000, { peak: 0.3 }).clap(2120, { peak: 0.3 }));
  assert.equal(doubles(ev).length, 0);
  assert.ok(reasons(ev).some((r) => /押す音/.test(r)), reasons(ev).join('\\n'));
});

test('タイピング直後（1秒以内）の拍手は数えず、理由を残す。手を止めて数秒後なら、響く部屋で起動する', () => {
  const p = { peak: 0.3, rt60: 0.6, reverbDb: -16 };
  const soon = run(new Track(14, -55, 3).typingReal(300, 8, 0.15, 4).clap(8900, p).clap(9300, p));
  assert.equal(doubles(soon).length, 0);
  assert.ok(reasons(soon).some((r) => /タイピング|打鍵音/.test(r)), reasons(soon).join('\\n'));
  let ok = 0;
  for (let s = 0; s < 10; s++) {
    const tr = new Track(16, -55, s).typingReal(300, 6, 0.15, s + 40).clap(9800 + s * 100, { ...p, seed: s }).clap(10250 + s * 100, { ...p, seed: s + 9 });
    if (doubles(run(tr)).length === 1) ok++;
  }
  assert.ok(ok >= 9, `成功 ${ok}/10`);
});

test('拍手2回の検出時に、2回それぞれの判定値・間隔・直前の静けさを根拠として残す', () => {
  const ev = run(new Track(5, -55, 2).clap(2000, { peak: 0.3 }).clap(2400, { peak: 0.28 }));
  const d = doubles(ev);
  assert.equal(d.length, 1);
  const x = (d[0] as Extract<DetectorEvent, { type: 'double-clap' }>).detail;
  assert.equal(x.intervalMs, 400);
  assert.ok(x.first.checks.length >= 6 && x.second.checks.every((c) => c.pass));
  assert.ok(x.quietBeforeMs >= 1000);
  assert.equal(x.softBefore, 0);
  assert.equal(typeof x.first.tailDb, 'number');
  assert.equal(x.usedSignature, false);
});

/** キャリブレーション：環境音 → 拍手 5 回 → 手順3でキーボードを打つ */
function calibrateWithKeyboard(seed: number, keyPeak: number) {
  const T = CALIB_TIMING;
  const tr = new Track(40, -52, seed);
  for (let k = 0; k < 5; k++) tr.clap(T.ambientMs + 1000 + k * 1200, { peak: 0.25 + k * 0.02, rt60: 0.5, reverbDb: -18, seed: seed + k });
  const noiseStart = T.ambientMs + 1000 + 5 * 1200 + T.afterLastClapMs;
  tr.typingReal(noiseStart + 300, 5.5, keyPeak, seed + 77);
  const r = new CalibrationRun(SR);
  for (let i = 0; i < tr.data.length; i += 2048) {
    r.feed(tr.data.subarray(i, i + 2048));
    if (r.snapshot().step === 'noise-ready') r.startNoise();
    if (r.snapshot().step === 'result') break;
  }
  return r.snapshot().result!;
}

test('キャリブレーションで打ったキーボード音が判定に登録され、保存・復元後も使われる', () => {
  const res = calibrateWithKeyboard(5, 0.2);
  assert.ok(res.ok, res.notes.join('\\n'));
  assert.ok(res.summary.noiseRegistered >= 3, `登録 ${res.summary.noiseRegistered}`);
  assert.ok(res.notes.some((n) => /登録しました/.test(n)));
  const restored = sanitizeProfile(JSON.parse(JSON.stringify(res.profile)));
  assert.deepEqual(restored, res.profile, 'localStorage に保存しても登録内容が失われない');
  // 登録後は「キーボード音との違い」の判定項目が加わる
  const ev = run(new Track(5, -52, 9).clap(2000, { peak: 0.3, rt60: 0.5, reverbDb: -18 }).clap(2400, { peak: 0.3, rt60: 0.5, reverbDb: -18 }), { profile: restored! });
  const d = doubles(ev);
  assert.equal(d.length, 1);
  const detail = (d[0] as Extract<DetectorEvent, { type: 'double-clap' }>).detail;
  assert.equal(detail.usedSignature, true);
  assert.ok(detail.first.checks.some((c) => c.key === 'kbd' && c.pass));
});

test('キャリブレーション後の基準: 拍手は起動し、キーボードの打鍵音そのものは「キーボード音に近い」と判定される', () => {
  const res = calibrateWithKeyboard(8, 0.25);
  const profile = res.profile;
  let ok = 0;
  for (let s = 0; s < 10; s++) {
    const p = { peak: 0.27 * (0.85 + 0.03 * s), rt60: 0.5, reverbDb: -18 };
    if (doubles(run(new Track(5, -52, 60 + s).clap(2500, { ...p, seed: s }).clap(2950 + s * 15, { ...p, seed: s + 50 }), { profile })).length === 1) ok++;
  }
  assert.ok(ok >= 9, `成功 ${ok}/10`);
  const keys = run(new Track(120, -52, 3).typingReal(500, 118, 0.25, 21), { profile });
  assert.equal(doubles(keys).length, 0);
  const judged = keys.flatMap((e) => (e.type === 'transient' ? [e.info] : []));
  const kbdRejected = judged.filter((i) => i.checks.some((c) => c.key === 'kbd' && !c.pass)).length;
  assert.ok(kbdRejected / judged.length > 0.5, `キーボード音に近いと判定された割合 ${kbdRejected}/${judged.length}`);
});

test('登録した特徴が壊れていれば読み込まない（ほかの基準はそのまま使う）', () => {
  const base = { minLevelDb: -30, minAboveFloorDb: 14, minJumpDb: 10, maxRiseMs: 20, minDecayDb: 4, minCentroidHz: 900, maxCrest: 8 };
  assert.deepEqual(sanitizeProfile({ ...base, signature: { claps: [[1, 2]], noises: 'x' } }), base);
  assert.equal(sanitizeProfile({ ...base, signature: { claps: [[1, 2, 3, 4, 5]], noises: [[1, 2, 3, 4, 5]] }, roomSoundDb: -40 })?.roomSoundDb, -40);
});

test('ばらつきのある拍手2回（静かな状況）: 感度5で40回中38回以上（v5 の対策後も検出率を維持）', () => {
  let ok = 0;
  for (let s = 0; s < 40; s++) {
    const r = rng(s + 900);
    const u = () => r() + 0.5;
    const p = { peak: dbToAmp(-22 + u() * 18), attackMs: 0.2 + u() * 3, decayMs: 4 + u() * 10, centerHz: 1200 + u() * 2300, reverbDb: -24 + u() * 12, rt60: 0.2 + u() * 0.7 };
    const gap = 200 + u() * 340;
    const tr = new Track(4, -62 + u() * 20, s).clap(1500, { ...p, seed: s }).clap(1500 + gap, { ...p, peak: p.peak * (0.7 + u() * 0.6), seed: s + 1 });
    if (doubles(run(tr)).length === 1) ok++;
  }
  assert.ok(ok >= 38, `成功 ${ok}/40`);
});
