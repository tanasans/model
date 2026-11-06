import { DEFAULT_PROFILE, type ClapProfile, type TransientInfo } from './clapDetector';

/**
 * キャリブレーション（実際のマイク・部屋に合わせた判定基準づくり）。
 *  手順1: 静かにして周囲の騒音を測る
 *  手順2: 1 回ずつ間をあけて拍手（5 回）→ 拍手の特徴を測る
 *  手順3（任意）: ふだんの声で話す／キーボードを打つ → 拍手と区別できる基準にする
 */

export interface CalibrationInput {
  /** 手順1で測ったフレームレベル（dBFS） */
  ambientLevels: number[];
  /** 手順2で検出した音（特徴のみモードの検出結果） */
  claps: TransientInfo[];
  /** 手順3で検出した鋭い音（省略可） */
  noises?: TransientInfo[];
}

export interface CalibrationResult {
  ok: boolean;
  profile: ClapProfile;
  /** 画面に表示する説明 */
  notes: string[];
  summary: {
    ambientDb: number;
    clapCount: number;
    clapLevelDb: number | null;
    noiseCount: number;
    /** 手順3の音を新しい基準で判定したとき、拍手と誤判定される数 */
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

export function computeCalibration(input: CalibrationInput): CalibrationResult {
  const notes: string[] = [];
  const ambientDb = percentile(input.ambientLevels, 90);
  const ambient = Number.isFinite(ambientDb) ? ambientDb : -70;
  // 拍手らしい音だけを使う（周囲より十分大きいもの）
  const claps = input.claps.filter((c) => c.levelDb >= ambient + 12);
  const noises = input.noises ?? [];

  const summaryBase = { ambientDb: round(ambient), clapCount: claps.length, noiseCount: noises.length };

  if (claps.length < MIN_CALIBRATION_CLAPS) {
    notes.push(
      `拍手を ${claps.length} 回しか検出できませんでした（${MIN_CALIBRATION_CLAPS} 回以上必要）。` +
        'もう少し強く叩くか、マイクに近づいてやり直してください。',
    );
    return {
      ok: false,
      profile: DEFAULT_PROFILE,
      notes,
      summary: { ...summaryBase, clapLevelDb: null, noiseFalseAccepts: 0 },
    };
  }

  const lv = claps.map((c) => c.levelDb);
  const clapLow = percentile(lv, 0);
  // 各特徴について「計測した拍手の中で最も条件の悪いもの」から余裕を持たせて基準を決める
  const profile: ClapProfile = {
    minLevelDb: clamp(Math.max(ambient + 10, clapLow - 8), -60, -6),
    minAboveFloorDb: clamp(Math.min(DEFAULT_PROFILE.minAboveFloorDb, clapLow - ambient - 6), 8, 30),
    minJumpDb: clamp(percentile(claps.map((c) => c.jumpDb), 0) - 5, 5, 16),
    maxRiseMs: clamp(percentile(claps.map((c) => c.riseMs), 100) + 7.5, 10, 35),
    minDecayDb: clamp(percentile(claps.map((c) => c.decayDb), 0) - 2.5, 2, 15),
    minCentroidHz: clamp(percentile(claps.map((c) => c.centroidHz), 0) * 0.7, 300, 2500),
    maxCrest: clamp(percentile(claps.map((c) => c.crest), 100) + 1.5, 4.5, 14),
  };
  notes.push(`拍手を ${claps.length} 回検出しました（大きさ ${round(clapLow)}〜${round(percentile(lv, 100))}dB）。`);

  // 手順3：話し声・キーボードが拍手と判定されないように基準を引き締める
  let falseAccepts = noises.filter((n) => passes(n, profile, ambient)).length;
  if (noises.length && falseAccepts > 0) {
    const fa = noises.filter((n) => passes(n, profile, ambient));
    // 大きさで分けられるか
    const noiseHigh = percentile(fa.map((n) => n.levelDb), 100);
    if (noiseHigh + 3 <= clapLow - 2) {
      profile.minLevelDb = round(noiseHigh + 3);
      notes.push('話し声・キーボード音より大きい音だけに反応するよう、反応ラインを上げました。');
    } else {
      // 減衰（短さ）で分けられるか
      const noiseDecayHigh = percentile(fa.map((n) => n.decayDb), 100);
      const clapDecayLow = percentile(claps.map((c) => c.decayDb), 0);
      if (noiseDecayHigh + 1 <= clapDecayLow - 1) {
        profile.minDecayDb = round(noiseDecayHigh + 1);
        notes.push('話し声と区別するため「短さ」の基準を厳しくしました。');
      } else {
        notes.push(
          '一部の話し声・キーボード音が拍手と似ています。' +
            '音量だけでは区別しきれないため、2回の並び（直前の静けさ・3回目がないこと）で誤起動を防ぎます。' +
            '気になる場合は、キーボードから離れた位置で強めに叩いてください。',
        );
      }
    }
    falseAccepts = noises.filter((n) => passes(n, profile, ambient)).length;
  } else if (noises.length) {
    notes.push('話し声・キーボード音は拍手と判定されませんでした。');
  }

  // 計測した拍手がすべて合格することを確認
  const clapPass = claps.filter((c) => passes(c, profile, ambient)).length;
  if (clapPass < claps.length) {
    notes.push(`注意：計測した拍手のうち ${claps.length - clapPass} 回は新しい基準でも合格しません。感度を上げて試してください。`);
  }

  return {
    ok: true,
    profile: roundProfile(profile),
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
