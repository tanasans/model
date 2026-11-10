import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClapDetector, type ClapProfile, type DetectorEvent, type TransientInfo } from '../src/clap/clapDetector.ts';
import { CALIB_TIMING, CalibrationRun, analyzeAmbient } from '../src/clap/calibration.ts';
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

test('2打鍵だけで止まる打ち方が多い極端なタイピング 3分間で誤起動しない（v4 では 14 回）', () => {
  let total = 0;
  for (const seed of [9, 19, 29]) total += doubles(run(new Track(62).typing(1000, 60, 0.2, seed)));
  assert.equal(total, 0);
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
const T = CALIB_TIMING;

/** 手順に合わせた録音を CalibrationRun に流す。noiseAtMs を指定すると「測る」を押す */
function runCalibration(track: Track, opts: { pressNoise?: boolean } = {}) {
  const r = new CalibrationRun(SR);
  const steps: string[] = [];
  for (let i = 0; i < track.data.length; i += 2048) {
    r.feed(track.data.subarray(i, i + 2048));
    const snap = r.snapshot();
    if (steps[steps.length - 1] !== snap.step) steps.push(snap.step);
    if (snap.step === 'noise-ready' && opts.pressNoise) r.startNoise();
    if (snap.step === 'result') break;
  }
  return { run: r, snap: r.snapshot(), steps };
}

/** 普通の部屋：ファン音＋ランダムな小さなコツコツ音（実機で計測が進まなかった状況の再現） */
function noisyRoom(seconds: number, seed = 3, fanDb = -42) {
  const tr = new Track(seconds, fanDb, seed);
  const r = rng(seed + 2);
  let at = 300;
  while (at < seconds * 1000 - 300) {
    tr.click(at, 0.02 + (r() + 0.5) * 0.06);
    at += 300 + (r() + 0.5) * 900;
  }
  return tr;
}

test('キャリブレーション: 環境音（ファン＋小さな音）があっても、無音を待たずに時間で次の手順へ進む', () => {
  // 拍手をしない 40 秒間の録音：手順は止まらず最後（結果）まで自動で進むこと
  const { snap, steps } = runCalibration(noisyRoom(40));
  assert.deepEqual(steps, ['ambient', 'claps', 'noise-ready', 'result']);
  // 小さな音は拍手として数えない
  assert.equal(snap.result?.summary.clapCount, 0);
  assert.equal(snap.result?.ok, false);
  // 失敗しても、環境音から作った基準と分かりやすい案内がある
  assert.ok(snap.result!.fallbackProfile.minLevelDb > -45, JSON.stringify(snap.result!.fallbackProfile));
  assert.ok(snap.result!.notes.some((n) => /手動設定/.test(n)));
  // 環境音の基準値はファン音のレベル付近（小さな音に引っ張られない）
  assert.ok(Math.abs(snap.result!.summary.floorDb - -42) < 4, `floor ${snap.result!.summary.floorDb}`);
});

test('キャリブレーション: 騒がしい部屋でも拍手5回を正しく数え、小さな音は無視した回数として表示する', () => {
  const tr = noisyRoom(30);
  for (let k = 0; k < 5; k++) tr.clap(T.ambientMs + 1000 + k * 1200, { peak: 0.25 + k * 0.03, rt60: 0.6, reverbDb: -16 });
  const { snap, steps } = runCalibration(tr);
  assert.deepEqual(steps.slice(0, 3), ['ambient', 'claps', 'noise-ready']);
  assert.equal(snap.result?.ok, true, snap.result?.notes.join('\n') ?? '');
  assert.equal(snap.result?.summary.clapCount, 5);
  assert.ok(snap.ignoredCount > 0, '小さな音を無視した回数');
});

test('キャリブレーション: 測定中に小さな音があっても最初からやり直しにならない（手順1は一度だけ）', () => {
  const { steps } = runCalibration(noisyRoom(25));
  assert.equal(steps.filter((s) => s === 'ambient').length, 1);
});

test('キャリブレーション後の基準: 騒がしい部屋で拍手2回は起動し、小さな音・話し声・キーボードでは起動しない', () => {
  const tr = noisyRoom(40, 11);
  for (let k = 0; k < 5; k++) tr.clap(T.ambientMs + 1000 + k * 1200, { peak: 0.2 + k * 0.02, rt60: 0.7, reverbDb: -15 });
  // 手順3：話し声とキーボード
  const noiseStart = T.ambientMs + 1000 + 5 * 1200 + T.afterLastClapMs;
  tr.speech(noiseStart + 300, 3, 0.25).typingWords(noiseStart + 3400, 2.5, 0.2);
  const { snap } = runCalibration(tr, { pressNoise: true });
  assert.ok(snap.result?.ok, snap.result?.notes.join('\n') ?? '');
  const profile = snap.result!.profile;
  let ok = 0;
  for (let s = 0; s < 10; s++) {
    const p = { peak: 0.2 * (0.85 + 0.03 * s), rt60: 0.7, reverbDb: -15 };
    const t = noisyRoom(5, 50 + s).clap(2500, { ...p, seed: s }).clap(2950 + s * 15, { ...p, seed: s + 50 });
    if (doubles(run(t, { profile })) === 1) ok++;
  }
  assert.ok(ok >= 9, `成功 ${ok}/10 profile=${JSON.stringify(profile)}`);
  assert.equal(doubles(run(noisyRoom(60, 77), { profile })), 0, '小さな音だけ');
  assert.equal(doubles(run(new Track(62, -42, 78).speech(1000, 30, 0.3, 3).typingWords(32000, 28, 0.2, 4), { profile })), 0);
});

test('キャリブレーション: 静かな部屋（従来どおり）でも成功する', () => {
  const tr = new Track(30, -58, 4);
  for (let k = 0; k < 5; k++) tr.clap(T.ambientMs + 1000 + k * 1200, { peak: 0.06 * (0.8 + 0.1 * k), rt60: 0.8, reverbDb: -14 });
  const { snap } = runCalibration(tr);
  assert.ok(snap.result?.ok, snap.result?.notes.join('\n') ?? '');
  assert.equal(snap.result?.summary.clapCount, 5);
});

test('環境音の解析: 小さな音の大きさを測り、拍手判定しきい値をその上に置く', () => {
  const levels = Array.from({ length: 1000 }, (_, i) => -50 + (i % 10) * 0.3);
  const small = [-34, -33, -35].map((levelDb) => ({ levelDb }) as TransientInfo);
  const a = analyzeAmbient(levels, small);
  assert.ok(Math.abs(a.floorDb - -48.7) < 1);
  assert.ok(a.clapGateDb >= -33 + 4 - 0.1, `gate ${a.clapGateDb}`);
});

test('検出器: 小さな音が頻繁にあってもノイズフロアの推定が環境音レベルに保たれ、拍手2回は起動する', () => {
  const tr = noisyRoom(8, 21, -45).clap(5000, { peak: 0.3 }).clap(5450, { peak: 0.28 });
  const d = new ClapDetector({ sampleRate: SR, sensitivity: 5, maxIntervalMs: 600 });
  let doublesN = 0;
  for (let i = 0; i < tr.data.length; i += 2048) for (const e of d.process(tr.data.subarray(i, i + 2048))) if (e.type === 'double-clap') doublesN++;
  assert.equal(doublesN, 1);
  assert.ok(Math.abs(d.noiseFloorDb - -45) < 5, `floor ${d.noiseFloorDb}`);
});
