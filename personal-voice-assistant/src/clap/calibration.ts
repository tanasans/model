import { ClapDetector, DEFAULT_PROFILE, type ClapProfile, type TransientInfo } from './clapDetector';

/**
 * キャリブレーション（実際のマイク・部屋に合わせた判定基準づくり）。
 *  手順1: 環境音を測る（無音は不要。ふだんの部屋の音のままでよい）
 *  手順2: 1 回ずつ間をあけて拍手（5 回）→ 環境音より十分大きい鋭い音だけを拍手として数える
 *  手順3（任意）: ふだんの声で話す／キーボードを打つ → 拍手と区別できる基準にする
 * どの手順も時間で自動的に次へ進み、小さな音で最初からやり直しになることはない。
 */

/** 手順1の結果：環境音の統計 */
export interface AmbientStats {
  /** ノイズフロア（環境音の基準値）：フレームレベルの中央値（dBFS） */
  floorDb: number;
  /** 環境音の大きめの部分（95%点） */
  p95Db: number;
  /** 環境音の中の瞬間的な小さな音の大きさ（90%点）。無ければ null */
  smallSoundDb: number | null;
  smallSoundCount: number;
  /** 手順2で拍手として数える最小レベル（拍手判定しきい値） */
  clapGateDb: number;
}

export function analyzeAmbient(levels: number[], transients: TransientInfo[]): AmbientStats {
  const floor = levels.length ? percentile(levels, 50) : -70;
  const p95 = levels.length ? percentile(levels, 95) : floor;
  const small = transients.filter((t) => t.levelDb >= floor + 6).map((t) => t.levelDb);
  const smallDb = small.length ? percentile(small, 90) : null;
  // 環境音・環境の小さな音より十分大きい音だけを拍手候補にする
  const gate = Math.max(floor + 14, p95 + 6, smallDb !== null ? smallDb + 4 : -100);
  return {
    floorDb: round(floor),
    p95Db: round(p95),
    smallSoundDb: smallDb === null ? null : round(smallDb),
    smallSoundCount: small.length,
    clapGateDb: round(clamp(gate, -65, -8)),
  };
}

/** 手順2で拍手として数えるか（環境音より十分大きく、急に大きくなった音） */
export function isCalibrationClap(info: TransientInfo, ambient: AmbientStats): boolean {
  return info.levelDb >= ambient.clapGateDb && info.jumpDb >= 8;
}

/** 手順2で拍手を数える最小間隔（残響の二重カウント防止） */
export const CALIBRATION_CLAP_SPACING_MS = 300;

export interface CalibrationInput {
  ambient: AmbientStats;
  /** 手順2で拍手として数えた音（isCalibrationClap を満たすもの） */
  claps: TransientInfo[];
  /** 手順3で検出した鋭い音（省略可） */
  noises?: TransientInfo[];
}

export interface CalibrationResult {
  ok: boolean;
  /** ok のときの基準。失敗時は fallbackProfile を使う */
  profile: ClapProfile;
  /** 拍手が足りないときでも、環境音の測定結果だけで作った基準（手動テスト用） */
  fallbackProfile: ClapProfile;
  notes: string[];
  summary: {
    floorDb: number;
    smallSoundDb: number | null;
    clapGateDb: number;
    clapCount: number;
    clapLevelDb: number | null;
    noiseCount: number;
    noiseFalseAccepts: number;
  };
}

export const MIN_CALIBRATION_CLAPS = 3;

export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx]!;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 判定基準で 1 つの音を判定し直す（感度 5 相当） */
export function passes(info: TransientInfo, p: ClapProfile, floorDb: number): boolean {
  return (
    info.levelDb >= Math.max(p.minLevelDb, floorDb + p.minAboveFloorDb) &&
    info.jumpDb >= p.minJumpDb &&
    info.riseMs <= p.maxRiseMs &&
    info.decayDb >= p.minDecayDb &&
    info.centroidHz >= p.minCentroidHz &&
    info.crest <= p.maxCrest
  );
}

/** 環境音だけから作る基準：標準の判定項目のまま、反応ラインだけ環境に合わせる */
export function ambientOnlyProfile(a: AmbientStats): ClapProfile {
  return {
    ...DEFAULT_PROFILE,
    minLevelDb: round(clamp(a.clapGateDb, -60, -12)),
    minAboveFloorDb: round(clamp(a.clapGateDb - a.floorDb - 2, 8, 30)),
  };
}

export function computeCalibration(input: CalibrationInput): CalibrationResult {
  const notes: string[] = [];
  const amb = input.ambient;
  const floor = amb.floorDb;
  const claps = input.claps;
  const noises = input.noises ?? [];
  const fallbackProfile = ambientOnlyProfile(amb);

  notes.push(
    `環境音の基準値（ノイズフロア）は ${round(floor)}dB でした` +
      (amb.smallSoundCount > 0 ? `。測定中に小さな音が ${amb.smallSoundCount} 回ありましたが、環境音として扱いました。` : '。'),
  );

  const summaryBase = {
    floorDb: round(floor),
    smallSoundDb: amb.smallSoundDb,
    clapGateDb: amb.clapGateDb,
    clapCount: claps.length,
    noiseCount: noises.length,
  };

  if (claps.length < MIN_CALIBRATION_CLAPS) {
    notes.push(
      `拍手判定しきい値（${amb.clapGateDb}dB）を超える拍手を ${claps.length} 回しか検出できませんでした（${MIN_CALIBRATION_CLAPS} 回以上必要）。` +
        'もう少し強く叩くかマイクに近づいてやり直すか、「環境音の結果だけで試す」「手動設定」でテストしてください。',
    );
    return {
      ok: false,
      profile: fallbackProfile,
      fallbackProfile,
      notes,
      summary: { ...summaryBase, clapLevelDb: null, noiseFalseAccepts: 0 },
    };
  }

  const lv = claps.map((c) => c.levelDb);
  const clapLow = percentile(lv, 0);
  const levelFloor = Math.max(floor + 10, amb.smallSoundDb !== null ? amb.smallSoundDb + 3 : -100);
  const profile: ClapProfile = {
    // 環境の小さな音より上、かつ計測した拍手より十分下
    minLevelDb: clamp(Math.min(Math.max(levelFloor, clapLow - 8), clapLow - 3), -60, -6),
    minAboveFloorDb: clamp(Math.min(DEFAULT_PROFILE.minAboveFloorDb, clapLow - floor - 6), 8, 30),
    minJumpDb: clamp(percentile(claps.map((c) => c.jumpDb), 0) - 5, 5, 16),
    maxRiseMs: clamp(percentile(claps.map((c) => c.riseMs), 100) + 7.5, 10, 35),
    minDecayDb: clamp(percentile(claps.map((c) => c.decayDb), 0) - 2.5, 2, 15),
    minCentroidHz: clamp(percentile(claps.map((c) => c.centroidHz), 0) * 0.7, 300, 2500),
    maxCrest: clamp(percentile(claps.map((c) => c.crest), 100) + 1.5, 4.5, 14),
  };
  notes.push(`拍手を ${claps.length} 回検出しました（大きさ ${round(clapLow)}〜${round(percentile(lv, 100))}dB）。`);

  let falseAccepts = noises.filter((n) => passes(n, profile, floor)).length;
  if (noises.length && falseAccepts > 0) {
    const fa = noises.filter((n) => passes(n, profile, floor));
    const noiseHigh = percentile(fa.map((n) => n.levelDb), 100);
    if (noiseHigh + 3 <= clapLow - 2) {
      profile.minLevelDb = round(noiseHigh + 3);
      notes.push('話し声・キーボード音より大きい音だけに反応するよう、反応ラインを上げました。');
    } else {
      const noiseDecayHigh = percentile(fa.map((n) => n.decayDb), 100);
      const clapDecayLow = percentile(claps.map((c) => c.decayDb), 0);
      if (noiseDecayHigh + 1 <= clapDecayLow - 1) {
        profile.minDecayDb = round(noiseDecayHigh + 1);
        notes.push('話し声と区別するため「短さ」の基準を厳しくしました。');
      } else {
        notes.push(
          '一部の話し声・キーボード音が拍手と似ています。音量だけでは区別しきれないため、' +
            '2回の並び（直前の静けさ・3回目がないこと）で誤起動を防ぎます。気になる場合はキーボードから離れて強めに叩いてください。',
        );
      }
    }
    falseAccepts = noises.filter((n) => passes(n, profile, floor)).length;
  } else if (noises.length) {
    notes.push('話し声・キーボード音は拍手と判定されませんでした。');
  }

  const clapPass = claps.filter((c) => passes(c, profile, floor)).length;
  if (clapPass < claps.length) {
    notes.push(`注意：計測した拍手のうち ${claps.length - clapPass} 回は新しい基準でも合格しません。感度を上げて試してください。`);
  }

  return {
    ok: true,
    profile: roundProfile(profile),
    fallbackProfile,
    notes,
    summary: { ...summaryBase, clapLevelDb: round(clapLow), noiseFalseAccepts: falseAccepts },
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function roundProfile(p: ClapProfile): ClapProfile {
  return {
    minLevelDb: round(p.minLevelDb),
    minAboveFloorDb: round(p.minAboveFloorDb),
    minJumpDb: round(p.minJumpDb),
    maxRiseMs: round(p.maxRiseMs),
    minDecayDb: round(p.minDecayDb),
    minCentroidHz: Math.round(p.minCentroidHz),
    maxCrest: round(p.maxCrest),
  };
}

/** 保存データの検証（壊れた値や古い形式は既定値に戻す） */
export function sanitizeProfile(raw: unknown): ClapProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (k: keyof ClapProfile, lo: number, hi: number) => {
    const v = Number(r[k]);
    return Number.isFinite(v) ? clamp(v, lo, hi) : null;
  };
  const p = {
    minLevelDb: num('minLevelDb', -70, 0),
    minAboveFloorDb: num('minAboveFloorDb', 4, 40),
    minJumpDb: num('minJumpDb', 2, 30),
    maxRiseMs: num('maxRiseMs', 5, 60),
    minDecayDb: num('minDecayDb', 0, 30),
    minCentroidHz: num('minCentroidHz', 100, 5000),
    maxCrest: num('maxCrest', 3, 20),
  };
  return Object.values(p).every((v) => v !== null) ? (p as ClapProfile) : null;
}

/** キャリブレーション中に音の特徴を集めるための、ほぼ何でも拾う基準 */
export const PERMISSIVE_PROFILE: ClapProfile = {
  minLevelDb: -70,
  minAboveFloorDb: 10,
  minJumpDb: 6,
  maxRiseMs: 40,
  minDecayDb: -99,
  minCentroidHz: 0,
  maxCrest: 99,
};

/** 2.5ms ごとのレベル（dBFS）を計算する（騒音測定用） */
export function frameLevelsDb(samples: Float32Array, sampleRate: number): number[] {
  const fs = Math.max(16, Math.round(sampleRate * 0.0025));
  const out: number[] = [];
  for (let i = 0; i + fs <= samples.length; i += fs) {
    let e = 0;
    for (let k = 0; k < fs; k++) e += samples[i + k]! ** 2;
    out.push(10 * Math.log10(e / fs + 1e-12));
  }
  return out;
}

// ---------- 進行管理（音声サンプルの時間で進む。ブラウザとテストで同じコードを使う） ----------

export type CalibStep = 'ambient' | 'claps' | 'noise-ready' | 'noise' | 'result';

export const CALIB_TIMING = {
  ambientMs: 4000,
  clapsMaxMs: 15000,
  clapsTarget: 5,
  /** 5 回目の拍手の後、余韻が収まるのを待つ時間 */
  afterLastClapMs: 700,
  /** 手順3を始めるか選ぶ画面で、操作がなければ自動で結果へ進むまでの時間 */
  noiseReadyAutoMs: 15000,
  noiseMs: 6000,
} as const;

export interface CalibSnapshot {
  step: CalibStep;
  /** 現在の手順の残り時間（秒） */
  secondsLeft: number;
  levelDb: number;
  /** 検出器が自動推定している現在のノイズフロア */
  liveFloorDb: number;
  ambient: AmbientStats | null;
  clapCount: number;
  /** 手順2で「拍手判定しきい値に届かない小さな音」として無視した回数 */
  ignoredCount: number;
  lastIgnoredDb: number | null;
  result: CalibrationResult | null;
}

export class CalibrationRun {
  private det: ClapDetector;
  private step: CalibStep = 'ambient';
  private stepStartMs = 0;
  private nowMs = 0;
  private levels: number[] = [];
  private ambientTransients: TransientInfo[] = [];
  private ambient: AmbientStats | null = null;
  private claps: TransientInfo[] = [];
  private noises: TransientInfo[] = [];
  private ignored = 0;
  private lastIgnoredDb: number | null = null;
  private lastClapMs = -Infinity;
  private result: CalibrationResult | null = null;

  constructor(private readonly sampleRate: number) {
    this.det = new ClapDetector({
      sampleRate,
      sensitivity: 5,
      maxIntervalMs: 600,
      profile: PERMISSIVE_PROFILE,
      featuresOnly: true,
    });
  }

  feed(samples: Float32Array): void {
    if (this.step === 'result') return;
    const events = this.det.process(samples);
    const startMs = this.nowMs;
    this.nowMs += (samples.length / this.sampleRate) * 1000;
    if (this.step === 'ambient') this.levels.push(...frameLevelsDb(samples, this.sampleRate));
    for (const e of events) {
      if (e.type !== 'transient') continue;
      const info = e.info;
      if (this.step === 'ambient') this.ambientTransients.push(info);
      else if (this.step === 'claps' && this.ambient) {
        // 検出時刻は検出器の時刻（このチャンクの開始時刻付近）で近似
        const t = Math.max(startMs, info.timeMs);
        if (isCalibrationClap(info, this.ambient) && t - this.lastClapMs >= CALIBRATION_CLAP_SPACING_MS) {
          if (this.claps.length < CALIB_TIMING.clapsTarget) {
            this.claps.push(info);
            this.lastClapMs = t;
          }
        } else if (!isCalibrationClap(info, this.ambient)) {
          this.ignored++;
          this.lastIgnoredDb = info.levelDb;
        }
      } else if (this.step === 'noise') this.noises.push(info);
    }
    this.tick();
  }

  private elapsed(): number {
    return this.nowMs - this.stepStartMs;
  }

  private go(step: CalibStep): void {
    this.step = step;
    this.stepStartMs = this.nowMs;
  }

  /** 時間による自動進行 */
  private tick(): void {
    const el = this.elapsed();
    if (this.step === 'ambient' && el >= CALIB_TIMING.ambientMs) {
      this.ambient = analyzeAmbient(this.levels, this.ambientTransients);
      this.go('claps');
    } else if (this.step === 'claps') {
      const done =
        this.claps.length >= CALIB_TIMING.clapsTarget && this.nowMs - this.lastClapMs >= CALIB_TIMING.afterLastClapMs;
      if (done || el >= CALIB_TIMING.clapsMaxMs) this.go('noise-ready');
    } else if (this.step === 'noise-ready' && el >= CALIB_TIMING.noiseReadyAutoMs) {
      this.finish(false);
    } else if (this.step === 'noise' && el >= CALIB_TIMING.noiseMs) {
      this.finish(true);
    }
  }

  startNoise(): void {
    if (this.step !== 'noise-ready') return;
    this.noises = [];
    this.go('noise');
  }

  skipNoise(): void {
    if (this.step === 'noise-ready' || this.step === 'noise') this.finish(false);
  }

  private finish(withNoise: boolean): void {
    const ambient = this.ambient ?? analyzeAmbient(this.levels, this.ambientTransients);
    this.result = computeCalibration({ ambient, claps: this.claps, noises: withNoise ? this.noises : [] });
    this.go('result');
  }

  snapshot(): CalibSnapshot {
    const limit: Record<CalibStep, number> = {
      ambient: CALIB_TIMING.ambientMs,
      claps: CALIB_TIMING.clapsMaxMs,
      'noise-ready': CALIB_TIMING.noiseReadyAutoMs,
      noise: CALIB_TIMING.noiseMs,
      result: 0,
    };
    return {
      step: this.step,
      secondsLeft: Math.max(0, Math.ceil((limit[this.step] - this.elapsed()) / 1000)),
      levelDb: this.det.levelDb,
      liveFloorDb: this.det.noiseFloorDb,
      ambient: this.ambient,
      clapCount: this.claps.length,
      ignoredCount: this.ignored,
      lastIgnoredDb: this.lastIgnoredDb,
      result: this.result,
    };
  }
}
