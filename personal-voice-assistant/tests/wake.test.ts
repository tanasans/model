import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateFinal, recognizersFor, wakeThresholds, type LevelProbe, type VoskFinal, type WakePhraseMode } from '../src/wake/wakePolicy.ts';
import { LevelTracker } from '../src/wake/levelTracker.ts';
import { NoiseReducer, Resampler } from '../src/wake/dsp.ts';

// ---------- 本物の認識エンジン（Vosk 日本語小型モデル）の出力を使った判定テスト ----------
interface Clip {
  grammar: 'lone' | 'nee';
  name: string;
  kind: 'lone' | 'nee' | 'confusable' | 'embedded' | 'tv';
  env: 'quiet' | 'normal' | 'noisy';
  floorDb: number;
  finals: VoskFinal[];
  windows: { t0: number; db: number[] }[];
}
const FX = JSON.parse(readFileSync(new URL('./fixtures/wake-vosk-results.json', import.meta.url), 'utf8')) as {
  grammars: Record<string, string[]>;
  clips: Clip[];
};

function probeFor(clip: Clip): LevelProbe {
  return {
    floorDb: () => clip.floorDb,
    maxDb(t0, t1) {
      let m: number | null = null;
      for (const w of clip.windows) {
        for (let i = 0; i < w.db.length; i++) {
          const t = w.t0 + i / 100;
          if (t >= t0 && t < t1) m = m === null ? w.db[i]! : Math.max(m, w.db[i]!);
        }
      }
      return m;
    },
  };
}

/** モードと感度で、各クリップが何回起動するか */
function evaluate(mode: WakePhraseMode, sensitivity: number) {
  const specs = recognizersFor(mode);
  const rows = new Map<string, { kind: Clip['kind']; env: Clip['env']; hits: number }>();
  for (const clip of FX.clips) {
    const spec = specs.find((s) => s.id === clip.grammar);
    const row = rows.get(clip.name) ?? { kind: clip.kind, env: clip.env, hits: 0 };
    rows.set(clip.name, row);
    if (!spec) continue;
    for (const f of clip.finals) if (evaluateFinal(f, spec, probeFor(clip), sensitivity)?.accepted) row.hits++;
  }
  const sum = (k: Clip['kind'], fn: (h: number) => number) =>
    [...rows.values()].filter((r) => r.kind === k).reduce((a, r) => a + fn(r.hits), 0);
  return {
    lone: sum('lone', (h) => Math.min(h, 1)),
    nee: sum('nee', (h) => Math.min(h, 1)),
    confusable: sum('confusable', (h) => h),
    embedded: sum('embedded', (h) => h),
    tv: sum('tv', (h) => h),
  };
}

test('fixture は本物の認識結果を含む（各条件 30 回 × 静か／普通／騒がしい）', () => {
  assert.equal(FX.clips.length, 726);
  assert.deepEqual(FX.grammars.lone, recognizersFor('kaito')[0]!.grammar);
  assert.deepEqual(FX.grammars.nee, recognizersFor('nee')[0]!.grammar);
});

test('テレビ風の連続音声・文中の「カイト」では、どのモード・感度でも起動しない', () => {
  for (const mode of ['kaito', 'nee', 'both'] as const) {
    for (const s of [3, 5, 8]) {
      const r = evaluate(mode, s);
      assert.equal(r.tv, 0, `${mode} 感度${s} テレビ`);
      assert.equal(r.embedded, 0, `${mode} 感度${s} 文中`);
    }
  }
});

test('「ねえ、カイト」モード: 似た言葉（ライト・バイト等 162 回）の誤起動は 2 回以下', () => {
  const r = evaluate('nee', 5);
  console.log(`  ねえモード 感度5: ねえカイト ${r.nee}/90, 似た言葉 ${r.confusable}/162, 文中 ${r.embedded}/15, テレビ ${r.tv}`);
  assert.ok(r.confusable <= 2, `似た言葉 ${r.confusable}`);
  assert.equal(r.lone, 0, 'ねえモードでは単独のカイトでは起動しない');
});

test('両方モード（既定）: 現状の合成音声での成績を記録し、退行を防ぐ', () => {
  const r = evaluate('both', 5);
  console.log(`  両方モード 感度5: 単独カイト ${r.lone}/90, ねえカイト ${r.nee}/90, 似た言葉 ${r.confusable}/162, テレビ ${r.tv}`);
  // 合成音声（機械的な声）での実測値。実際の人の声では別途実機で測る必要がある
  assert.ok(r.nee >= 45, `ねえカイト ${r.nee}/90`);
  assert.ok(r.lone >= 25, `単独カイト ${r.lone}/90`);
  assert.ok(r.confusable <= 15, `似た言葉 ${r.confusable}/162`);
});

test('感度を上げると検出が増え、下げると誤検出が減る（単調性）', () => {
  const lo = evaluate('both', 2);
  const mid = evaluate('both', 5);
  const hi = evaluate('both', 9);
  assert.ok(lo.lone + lo.nee <= mid.lone + mid.nee && mid.lone + mid.nee <= hi.lone + hi.nee);
  assert.ok(lo.confusable <= mid.confusable && mid.confusable <= hi.confusable);
  assert.ok(wakeThresholds(1).minConf > wakeThresholds(10).minConf);
});

// ---------- 判定理由 ----------
const quiet: LevelProbe = { floorDb: () => -60, maxDb: () => -60 };
const words = (...ws: [string, number, number, number][]) => ws.map(([word, conf, start, end]) => ({ word, conf, start, end }));
const lone = recognizersFor('kaito')[0]!;

test('静かな中での「カイト」は起動し、理由はない', () => {
  const d = evaluateFinal({ text: 'カイト', result: words(['カイト', 1, 1.0, 1.4]) }, lone, quiet, 5)!;
  assert.equal(d.accepted, true);
  assert.equal(d.reason, undefined);
});

test('直前・直後に声があると「会話・テレビの途中」として起動しない', () => {
  const noisyAround: LevelProbe = { floorDb: () => -60, maxDb: () => -30 };
  const d = evaluateFinal({ text: 'カイト', result: words(['カイト', 1, 1.0, 1.4]) }, lone, noisyAround, 5)!;
  assert.equal(d.accepted, false);
  assert.match(d.reason!, /直前/);
  assert.match(d.reason!, /直後/);
});

test('文の途中・後ろに言葉が続く場合は起動しない', () => {
  const d1 = evaluateFinal({ text: '[unk] カイト', result: words(['[unk]', 1, 0.5, 0.9], ['カイト', 1, 1.0, 1.4]) }, lone, quiet, 5)!;
  assert.equal(d1.accepted, false);
  assert.match(d1.reason!, /文の途中/);
  const d2 = evaluateFinal({ text: 'カイト [unk]', result: words(['カイト', 1, 1.0, 1.4], ['[unk]', 1, 1.5, 2]) }, lone, quiet, 5)!;
  assert.equal(d2.accepted, false);
});

test('信頼度が低いと起動しない／「ねえ」モードでは単独のカイトを無視', () => {
  const d = evaluateFinal({ text: 'カイト', result: words(['カイト', 0.3, 1.0, 1.4]) }, lone, quiet, 5)!;
  assert.equal(d.accepted, false);
  assert.match(d.reason!, /信頼度/);
  const neeSpec = recognizersFor('nee')[0]!;
  assert.equal(evaluateFinal({ text: 'カイト', result: words(['カイト', 1, 1.0, 1.4]) }, neeSpec, quiet, 5), null);
  const ok = evaluateFinal({ text: 'ねえ カイト', result: words(['ねえ', 1, 0.6, 0.9], ['カイト', 1, 1.0, 1.4]) }, neeSpec, quiet, 5)!;
  assert.equal(ok.accepted, true);
  assert.equal(ok.phrase, 'nee');
  assert.equal(ok.start, 0.6);
});

test('似た言葉（ライト）や無関係な結果は判定対象外', () => {
  assert.equal(evaluateFinal({ text: 'ライト', result: words(['ライト', 1, 1, 1.3]) }, lone, quiet, 5), null);
  assert.equal(evaluateFinal({ text: '' }, lone, quiet, 5), null);
});

// ---------- 音量履歴 ----------
test('LevelTracker: 時間軸と最大レベル・騒音レベル', () => {
  const lt = new LevelTracker(16000);
  const quietBuf = new Float32Array(16000 * 3).map(() => (Math.random() - 0.5) * 0.002);
  lt.push(quietBuf);
  const loud = new Float32Array(1600).map((_, i) => 0.3 * Math.sin(i / 3));
  lt.push(loud);
  lt.push(new Float32Array(8000).map(() => (Math.random() - 0.5) * 0.002));
  assert.ok(Math.abs(lt.timeSec - 3.6) < 0.02);
  assert.ok(lt.maxDb(3.0, 3.1)! > -15);
  assert.ok(lt.maxDb(1.0, 2.0)! < -55);
  assert.ok(lt.floorDb() < -55);
  assert.equal(lt.maxDb(10, 11), null);
});

// ---------- 前処理 ----------
function tone(freq: number, sr: number, sec: number, amp = 0.5) {
  return new Float32Array(Math.round(sr * sec)).map((_, i) => amp * Math.sin((2 * Math.PI * freq * i) / sr));
}
const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length));

test('Resampler: 48kHz・44.1kHz → 16kHz で長さが合い、1kHz は通し、10kHz（折り返し）は大きく減衰', () => {
  for (const sr of [48000, 44100]) {
    const r = new Resampler(sr);
    let n = 0;
    let pass: Float32Array = new Float32Array();
    const src = tone(1000, sr, 1);
    for (let i = 0; i < src.length; i += 2048) {
      const o = r.process(src.subarray(i, i + 2048));
      n += o.length;
      pass = o;
    }
    assert.ok(Math.abs(n - 16000) < 40, `${sr}: ${n}`);
    assert.ok(rms(pass) > 0.3, `1kHz 通過 ${rms(pass)}`);
    const r2 = new Resampler(sr);
    const alias = r2.process(tone(10000, sr, 1));
    assert.ok(rms(alias.subarray(200)) < 0.02, `10kHz 減衰 ${rms(alias)}`);
  }
});

test('NoiseReducer: 定常的な雑音を弱め、声に近い変化する音は残す', () => {
  const sr = 16000;
  let seed = 1;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5);
  const noise = new Float32Array(sr * 3).map(() => rnd() * 0.02);
  const nr = new NoiseReducer();
  const out = nr.process(noise);
  assert.ok(rms(out.subarray(sr)) < rms(noise.subarray(sr)) * 0.5, '雑音が半分以下に');
  // 雑音の上に 0.5 秒の「声」（300Hz＋倍音）を重ねる
  const mixed = noise.slice();
  for (let i = 0; i < sr / 2; i++) {
    const t = i / sr;
    mixed[sr * 2 + i]! += 0.2 * (Math.sin(2 * Math.PI * 300 * t) + 0.5 * Math.sin(2 * Math.PI * 900 * t));
  }
  const out2 = new NoiseReducer().process(mixed);
  const delay = NoiseReducer.N - NoiseReducer.HOP;
  const voiced = out2.subarray(sr * 2 + delay + 800, sr * 2 + delay + sr / 2 - 800);
  assert.ok(rms(voiced) > 0.12, `声が残る ${rms(voiced)}`);
});

test('厳しめ設定の追加確認: 同じ時間に似た言葉（バイト）と聞こえていたら単独のカイトを採用しない', async () => {
  const { decoyVeto } = await import('../src/wake/wakePolicy.ts');
  const d = evaluateFinal({ text: 'カイト', result: words(['カイト', 1, 1.0, 1.4]) }, lone, quiet, 5)!;
  assert.equal(decoyVeto(d, words(['バイト', 1, 1.02, 1.38])), 'バイト');
  assert.equal(decoyVeto(d, words(['バイト', 1, 5.0, 5.4])), null, '別の時間の似た言葉は関係ない');
  assert.equal(decoyVeto(d, words(['カイト', 1, 1.0, 1.4])), null);
});

test('拍手と音声呼びかけが同時に起動を要求しても、会話の開始は 1 回だけ', async () => {
  const { createTriggerGate } = await import('../src/triggerGate.ts');
  const gate = createTriggerGate();
  let starts = 0;
  const startConversation = () => new Promise<void>((r) => setTimeout(() => (starts++, r()), 50));
  const results = await Promise.all([gate.run(startConversation), gate.run(startConversation), gate.run(startConversation)]);
  assert.equal(starts, 1);
  assert.deepEqual(results, [true, false, false]);
  // 終わった後は、次の呼びかけで再び開始できる
  assert.equal(await gate.run(startConversation), true);
  assert.equal(starts, 2);
});
