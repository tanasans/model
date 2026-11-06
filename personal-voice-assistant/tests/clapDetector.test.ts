import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClapDetector, type ClapProfile, type DetectorEvent, type TransientInfo } from '../src/clap/clapDetector.ts';
import { computeCalibration } from '../src/clap/calibration.ts';
import { SR, Track, dbToAmp, rng } from './synth.ts';

interface RunOpts {
  sensitivity?: number;
  maxIntervalMs?: number;
  profile?: ClapProfile;
  featuresOnly?: boolean;
  /** ブラウザ環境と同じく 44.1kHz 等も試す */
  sampleRate?: number;
}

function run(track: Track, o: RunOpts = {}): DetectorEvent[] {
  const d = new ClapDetector({
    sampleRate: o.sampleRate ?? SR,
    sensitivity: o.sensitivity ?? 5,
    maxIntervalMs: o.maxIntervalMs ?? 600,
    profile: o.profile,
    featuresOnly: o.featuresOnly,
  });
  const events: DetectorEvent[] = [];
  for (let i = 0; i < track.data.length; i += 2048) events.push(...d.process(track.data.subarray(i, i + 2048)));
  return events;
}
const doubles = (ev: DetectorEvent[]) => ev.filter((e) => e.type === 'double-clap').length;
const transients = (ev: DetectorEvent[]) =>
  ev.flatMap((e) => (e.type === 'transient' ? [e.info] : [])) as TransientInfo[];

/** 1 回の「拍手 2 回」試行。条件をランダムに変える */
function trial(seed: number, opts: { maxIntervalMs: number; minGap?: number }) {
  const r = rng(seed);
  const u = () => r() + 0.5; // 0〜1
  const peakDb = -22 + u() * 18; // -22〜-4 dBFS
  const p = {
    peak: dbToAmp(peakDb),
    attackMs: 0.2 + u() * 3,
    decayMs: 4 + u() * 10,
    centerHz: 1200 + u() * 2300,
    reverbDb: -24 + u() * 12, // -24〜-12dB
    rt60: 0.2 + u() * 0.7, // 0.2〜0.9 秒
  };
  const gap = (opts.minGap ?? 200) + u() * (opts.maxIntervalMs - (opts.minGap ?? 200) - 60);
  const noiseDb = -62 + u() * 20; // 背景雑音 -62〜-42 dB
  const second = { ...p, peak: p.peak * (0.7 + u() * 0.6) }; // 2 回目の強さもばらつかせる
  const at = 1500 + u() * 7; // フレーム境界に対する位置もずらす
  const tr = new Track(4, noiseDb, seed).clap(at, { ...p, seed }).clap(at + gap, { ...second, seed: seed + 1 });
  return { tr, desc: `peak${peakDb.toFixed(0)}dB gap${gap.toFixed(0)}ms rt60=${p.rt60.toFixed(2)} attack${p.attackMs.toFixed(1)}ms noise${noiseDb.toFixed(0)}dB` };
}

// ---------- 検出率 ----------
test('ばらつきのある拍手2回（音量・間隔・残響・立ち上がり）: 40回中38回以上起動（感度5・間隔0.6秒）', () => {
  let ok = 0;
  const fails: string[] = [];
  for (let s = 1; s <= 40; s++) {
    const { tr, desc } = trial(s * 31, { maxIntervalMs: 600 });
    if (doubles(run(tr)) === 1) ok++;
    else fails.push(desc);
  }
  assert.ok(ok >= 38, `成功 ${ok}/40\n${fails.join('\n')}`);
});

test('実機と同じ設定（感度7・間隔0.50秒／0.80秒）: それぞれ20回中19回以上起動', () => {
  for (const maxIntervalMs of [500, 800]) {
    let ok = 0;
    const fails: string[] = [];
    for (let s = 1; s <= 20; s++) {
      const { tr, desc } = trial(s * 97 + maxIntervalMs, { maxIntervalMs });
      if (doubles(run(tr, { sensitivity: 7, maxIntervalMs })) === 1) ok++;
      else fails.push(desc);
    }
    assert.ok(ok >= 19, `間隔${maxIntervalMs}ms: 成功 ${ok}/20\n${fails.join('\n')}`);
  }
});

test('44.1kHz のマイクでも同様に起動する', () => {
  // 48k で作った信号を 44.1k として扱う（時間が約 9% 伸びるだけで判定は同じであること）
  let ok = 0;
  for (let s = 1; s <= 10; s++) if (doubles(run(trial(s * 13, { maxIntervalMs: 520 }).tr, { sampleRate: 44_100 })) === 1) ok++;
  assert.ok(ok >= 9, `成功 ${ok}/10`);
});

test('よく響く部屋（RT60 0.9秒）でも残響を「別の音」と誤認しない（感度5で10回中9回以上）', () => {
  let ok = 0;
  for (let s = 0; s < 10; s++) {
    const p = { rt60: 0.9, reverbDb: -14, peak: 0.3 + s * 0.03 };
    const tr = new Track(4, -55, s).clap(1500, { ...p, seed: s }).clap(1950, { ...p, seed: s + 9 });
    if (doubles(run(tr)) === 1) ok++;
  }
  assert.ok(ok >= 9, `成功 ${ok}/10`);
});

test('残響が拍手と同じくらい大きい部屋でも、感度10なら起動する', () => {
  let ok = 0;
  for (let s = 0; s < 10; s++) {
    const p = { rt60: 0.9, reverbDb: -10, peak: 0.3 + s * 0.03 };
    const tr = new Track(4, -55, s).clap(1500, { ...p, seed: s }).clap(1950, { ...p, seed: s + 9 });
    if (doubles(run(tr, { sensitivity: 10 })) === 1) ok++;
  }
  assert.ok(ok >= 8, `成功 ${ok}/10`);
});

test('立ち上がりが遅めの拍手（4ms、ブラウザ/OS の音声処理で鈍った波形）でも起動する', () => {
  const p = { attackMs: 4, peak: 0.3 };
  assert.equal(doubles(run(new Track(4).clap(1500, p).clap(1900, p))), 1);
});

// ---------- 誤起動しないこと ----------
test('拍手1回では起動しない', () => {
  assert.equal(doubles(run(new Track(3).clap(1200))), 0);
});

test('拍手3回続くと起動しない', () => {
  assert.equal(doubles(run(new Track(3).clap(1200).clap(1450).clap(1700))), 0);
});

test('間隔が最大間隔より長いと起動しない', () => {
  assert.equal(doubles(run(new Track(4).clap(1200).clap(2100), { maxIntervalMs: 600 })), 0);
});

test('話し声（破裂音・摩擦音を含む）60秒・音量3段階で誤起動しない（感度5・感度8）', () => {
  for (const sensitivity of [5, 8]) {
    for (const peak of [0.1, 0.3, 0.6]) {
      const tr = new Track(62).speech(1000, 60, peak, Math.round(peak * 100));
      assert.equal(doubles(run(tr, { sensitivity })), 0, `感度${sensitivity} 音量${peak}`);
    }
  }
});

test('文章入力に近いタイピング 60秒・3パターンで誤起動しない（既定の基準）', () => {
  for (const seed of [9, 19, 29]) {
    const tr = new Track(62).typingWords(1000, 60, 0.2, seed);
    assert.equal(doubles(run(tr)), 0, `seed ${seed}`);
  }
});

test('【最悪ケースの計測】2打鍵だけで止まる打ち方が多いタイピング：既定の基準での誤起動回数を記録', () => {
  // 1 打鍵ごとに 60% の確率で止まる極端な打ち方。既定基準では誤起動が起こり得るため件数を記録する。
  // （キャリブレーションでキーボード音を登録すると 0 件になることを別のテストで確認）
  let total = 0;
  for (const seed of [9, 19, 29]) total += doubles(run(new Track(62).typing(1000, 60, 0.2, seed)));
  console.log(`  最悪ケースのタイピング 3分間での誤起動: ${total} 回（既定の基準）`);
  assert.ok(total <= 20, `誤起動 ${total} 回`);
});

test('話し声の途中・直後の拍手2回は数えない（会話中の誤起動防止）', () => {
  // 話し声（1〜5 秒）の最中に拍手 2 回。話し声の合間でも直前に声があるため数えない
  const tr = new Track(6).speech(1000, 4, 0.3).clap(2600).clap(2900);
  const ev = run(tr);
  assert.equal(doubles(ev), 0);
});

test('物を置く低い音2回では起動しない', () => {
  const ev = run(new Track(3).thud(1200).thud(1500));
  assert.equal(doubles(ev), 0);
  assert.ok(transients(ev).some((t) => !t.accepted && t.checks.find((c) => c.key === 'pitch' && !c.pass)));
});

test('開始直後（騒音学習中）の音には反応しない', () => {
  assert.equal(doubles(run(new Track(2).clap(100).clap(400))), 0);
});

// ---------- 理由の表示 ----------
test('不採用の音には、失敗した項目と分かりやすい理由が付く', () => {
  const ev = run(new Track(4).speech(1000, 2, 0.4), { featuresOnly: true });
  const rejected = transients(ev).filter((t) => !t.accepted);
  for (const t of rejected) {
    assert.ok(t.reason && t.reason.length > 0);
    assert.equal(t.checks.length, 6);
  }
});

// ---------- キャリブレーション ----------
function calibrationRecording(clapPeak: number, rt60: number) {
  const ambient = new Track(3, -50, 3);
  const ambientEv = run(ambient, { featuresOnly: true });
  void ambientEv;
  const levels: number[] = [];
  const fs = Math.round(SR * 0.0025);
  for (let i = 0; i + fs <= ambient.data.length; i += fs) {
    let e = 0;
    for (let k = 0; k < fs; k++) e += ambient.data[i + k]! ** 2;
    levels.push(10 * Math.log10(e / fs + 1e-12));
  }
  const clapsTr = new Track(8, -50, 4);
  for (let k = 0; k < 5; k++) clapsTr.clap(1200 + k * 1200, { peak: clapPeak * (0.8 + 0.1 * k), rt60, reverbDb: -14 });
  const noiseTr = new Track(9, -50, 5).speech(800, 4, 0.3).typing(5000, 3.5, 0.2);
  return {
    ambientLevels: levels,
    claps: transients(run(clapsTr, { featuresOnly: true, sensitivity: 10, profile: PERMISSIVE })),
    noises: transients(run(noiseTr, { featuresOnly: true, sensitivity: 10, profile: PERMISSIVE })),
  };
}
import { PERMISSIVE_PROFILE as PERMISSIVE } from '../src/clap/calibration.ts';

test('キャリブレーション: 小さめの拍手・響く部屋でも、作った基準で起動し、話し声とキーボードでは起動しない', () => {
  const rec = calibrationRecording(0.06, 0.8);
  const res = computeCalibration(rec);
  assert.ok(res.ok, res.notes.join('\n'));
  assert.ok(res.summary.clapCount >= 4, `claps ${res.summary.clapCount}`);
  let ok = 0;
  for (let s = 0; s < 10; s++) {
    const p = { peak: 0.06 * (0.85 + 0.03 * s), rt60: 0.8, reverbDb: -14 };
    const tr = new Track(4, -50, 40 + s).clap(1500, { ...p, seed: s }).clap(1900 + s * 20, { ...p, seed: s + 50 });
    if (doubles(run(tr, { profile: res.profile })) === 1) ok++;
  }
  assert.ok(ok >= 9, `キャリブレーション後の成功 ${ok}/10 profile=${JSON.stringify(res.profile)}`);
  const noise = new Track(62, -50, 77).speech(1000, 30, 0.3, 3).typing(32000, 28, 0.2, 4);
  assert.equal(doubles(run(noise, { profile: res.profile })), 0);
});

test('キャリブレーション: 拍手が足りなければ失敗として案内する', () => {
  const res = computeCalibration({ ambientLevels: [-60, -61], claps: [], noises: [] });
  assert.equal(res.ok, false);
  assert.match(res.notes[0]!, /回以上必要/);
});
