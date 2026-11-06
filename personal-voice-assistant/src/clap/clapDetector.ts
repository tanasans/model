/**
 * 拍手 2 回の検出ロジック（v3）。ブラウザ内で完結し、外部送信はしない。
 *
 * v2 からの主な変更（実機で「立ち上がりが緩やか」「途中で別の音があった」と誤判定された問題の対策）
 *  - 拍手の「残響（部屋の響き）」を新しい音と誤認して 2 回の並びを取り消していた。
 *    → 拍手の後は「余韻」状態として扱い、余韻の中から新しい鋭い音（2 回目の拍手）だけを拾う。
 *  - 立ち上がりを「直前 15ms の最小値」と比較しており、フレーム境界や残響の影響で過剰に除外していた。
 *    → 直前 7.5〜30ms の平均と比較し（急激な変化）、ピークまでの時間も別に評価する。
 *  - 判定に使う特徴を増やし、すべて画面に表示できるようにした。
 *
 * 1 つの音について評価する特徴
 *  1. 大きさ     : ピーク（2.5ms フレームの RMS）が基準以上、かつ周囲の騒音より十分大きい
 *  2. 急な変化   : 直前の音量からの増加量（dB）
 *  3. 立ち上がり : 音の始まりからピークまでの時間（ms）
 *  4. 短さ       : ピークから 30〜60ms 後にどれだけ小さくなったか（dB）。話し声は小さくならない
 *  5. 音の高さ   : 立ち上がり部分の周波数重心（Hz）。机に物を置く低い音を除外
 * 並び方の条件
 *  - 1 回目の前に話し声などの続く音がない
 *  - 2 回の間隔が最小〜最大間隔の範囲内で、大きさが近い
 *  - 2 回目の後、確認時間内に 3 回目の鋭い音がない（タイピング・連続音を除外）
 */

/** 判定基準（キャリブレーションで変わる部分） */
export interface ClapProfile {
  /** ピークの最小レベル（dBFS） */
  minLevelDb: number;
  /** 周囲の騒音レベルからの最小上昇量（dB） */
  minAboveFloorDb: number;
  /** 急な変化：直前からの最小増加量（dB） */
  minJumpDb: number;
  /** 立ち上がり：ピークまでの最大時間（ms） */
  maxRiseMs: number;
  /** 短さ：ピーク後の最小減衰量（dB） */
  minDecayDb: number;
  /** 音の高さ：周波数重心の最小値（Hz） */
  minCentroidHz: number;
  /** 尖り：最大振幅÷RMS の上限。キーボードの針のように細いクリック音を除外 */
  maxCrest: number;
}

export const DEFAULT_PROFILE: ClapProfile = {
  minLevelDb: -34,
  minAboveFloorDb: 16,
  minJumpDb: 10,
  maxRiseMs: 20,
  minDecayDb: 4,
  minCentroidHz: 900,
  maxCrest: 8,
};

export interface ClapDetectorOptions {
  sampleRate: number;
  /** 感度 1（鈍い）〜 10（敏感）。基準を全体的に緩める／厳しくする。既定 5 */
  sensitivity: number;
  /** 1 回目と 2 回目の最大間隔（ms） */
  maxIntervalMs: number;
  /** 判定基準。省略時は DEFAULT_PROFILE */
  profile?: ClapProfile;
  /** true の場合、2 回の並びは判定せず、音ごとの特徴だけを出す（キャリブレーション用） */
  featuresOnly?: boolean;
}

export type CheckKey = 'level' | 'jump' | 'rise' | 'decay' | 'pitch' | 'crest';

export interface FeatureCheck {
  key: CheckKey;
  label: string;
  value: number;
  threshold: number;
  unit: string;
  /** 'min' は値が基準以上で合格、'max' は基準以下で合格 */
  kind: 'min' | 'max';
  pass: boolean;
}

export interface TransientInfo {
  timeMs: number;
  levelDb: number;
  jumpDb: number;
  riseMs: number;
  decayDb: number;
  centroidHz: number;
  /** 尖り具合（最大振幅 ÷ RMS、始まりから 10ms） */
  crest: number;
  checks: FeatureCheck[];
  accepted: boolean;
  /** 不採用の理由（分かりやすい日本語） */
  reason?: string;
}

export type DetectorEvent =
  | { type: 'transient'; info: TransientInfo }
  | { type: 'activity'; timeMs: number; durationMs: number }
  | { type: 'first-clap'; timeMs: number }
  | { type: 'sequence-cancelled'; timeMs: number; reason: string }
  | { type: 'double-clap'; timeMs: number; intervalMs: number };

export const CLAP_CONSTANTS = {
  frameMs: 2.5,
  /** 「直前の音量」として平均する範囲（現在から何 ms 前〜何 ms 前） */
  preFromMs: 30,
  preToMs: 7.5,
  /** ピークを探す範囲（音の始まりから） */
  peakSearchMs: 30,
  /** 減衰を測る範囲（ピークから） */
  decayFromMs: 30,
  decayToMs: 60,
  /** これ以上続く大きな音は「話し声などの続く音」 */
  activityMs: 150,
  /** 拍手の余韻として扱う最大時間 */
  maxTailMs: 700,
  /** 1 回目の前に必要な、話し声などの続く音がない時間 */
  preQuietMs: 300,
  /** 1 回目の前に必要な、ほかの鋭い音（タイピング等）がない時間 */
  preSharpQuietMs: 800,
  minIntervalMs: 120,
  /** 2 回目の後、3 回目が来ないことを確認する時間 */
  confirmMs: 300,
  maxLevelDiffDb: 12,
  warmupMs: 600,
} as const;

/** 感度による基準の調整（5 が基準そのもの） */
export function effectiveProfile(base: ClapProfile, sensitivity: number): ClapProfile {
  const k = Math.min(10, Math.max(1, Math.round(sensitivity))) - 5;
  return {
    minLevelDb: base.minLevelDb - k * 2.5,
    minAboveFloorDb: Math.max(6, base.minAboveFloorDb - k * 1.2),
    minJumpDb: Math.max(4, base.minJumpDb - k * 0.8),
    maxRiseMs: base.maxRiseMs + k * 1.5,
    minDecayDb: Math.max(1, base.minDecayDb - k * 0.6),
    minCentroidHz: Math.max(200, base.minCentroidHz * (1 - k * 0.07)),
    maxCrest: base.maxCrest + k * 0.3,
  };
}

const CHECK_TEXT: Record<CheckKey, { label: string; fail: string }> = {
  level: { label: '大きさ', fail: '音が小さい（反応ラインに届かない）' },
  jump: { label: '急な変化', fail: '急に大きくなっていない（話し声・徐々に大きくなる音）' },
  rise: { label: '立ち上がり', fail: 'ピークまでが遅い（話し声・物音）' },
  decay: { label: '短さ', fail: '音がすぐに消えない（話し声・音楽など続く音）' },
  pitch: { label: '音の高さ', fail: '音が低い（物を置く音・足音など）' },
  crest: { label: '尖り', fail: '針のように細い音（キーボード・カチッという音）' },
};

interface Frame {
  db: number;
  energy: number;
  diffEnergy: number;
  peakAbs: number;
  n: number;
}

interface Candidate {
  startIdx: number;
  preDb: number;
  frames: Frame[];
}

type Sequence =
  | { state: 'idle' }
  | { state: 'one'; t1: number; level1: number }
  | { state: 'two'; t1: number; t2: number };

export class ClapDetector {
  private opts: ClapDetectorOptions;
  private eff: ClapProfile;
  private readonly frameSize: number;
  private readonly frameMs: number;
  private frameBuf: Float32Array;
  private frameFill = 0;
  private lastSample = 0;
  private frameIdx = 0;
  /** 直近 ~100ms のフレーム dB（リングバッファ） */
  private hist: number[] = [];
  private readonly histLen: number;
  private floorDb = -70;
  private floorRing: number[] = [];
  private readonly floorRingMax: number;
  private floorTick = 0;
  private mode: 'idle' | 'candidate' | 'tail' = 'idle';
  private cand: Candidate | null = null;
  private tailStartIdx = 0;
  private loudRunFrames = 0;
  private activityReported = false;
  private seq: Sequence = { state: 'idle' };
  private lastActivityMs = -Infinity;
  private lastSharpMs = -Infinity;
  private _levelDb = -100;

  constructor(opts: ClapDetectorOptions) {
    this.opts = { ...opts };
    this.eff = effectiveProfile(opts.profile ?? DEFAULT_PROFILE, opts.sensitivity);
    this.frameSize = Math.max(16, Math.round((opts.sampleRate * CLAP_CONSTANTS.frameMs) / 1000));
    this.frameMs = (this.frameSize / opts.sampleRate) * 1000;
    this.frameBuf = new Float32Array(this.frameSize);
    this.histLen = Math.ceil(100 / this.frameMs);
    this.floorRingMax = Math.ceil(3000 / this.frameMs);
  }

  get levelDb(): number {
    return this._levelDb;
  }
  get noiseFloorDb(): number {
    return this.floorDb;
  }
  /** 反応ライン（dBFS）：大きさの条件を満たす最小レベル */
  get triggerLevelDb(): number {
    return Math.max(this.eff.minLevelDb, this.floorDb + this.eff.minAboveFloorDb);
  }
  get profile(): ClapProfile {
    return this.eff;
  }

  setOptions(partial: Partial<Omit<ClapDetectorOptions, 'sampleRate'>>): void {
    this.opts = { ...this.opts, ...partial };
    this.eff = effectiveProfile(this.opts.profile ?? DEFAULT_PROFILE, this.opts.sensitivity);
  }

  process(samples: Float32Array): DetectorEvent[] {
    const events: DetectorEvent[] = [];
    for (let i = 0; i < samples.length; i++) {
      this.frameBuf[this.frameFill++] = samples[i]!;
      if (this.frameFill === this.frameSize) {
        this.processFrame(events);
        this.frameFill = 0;
      }
    }
    return events;
  }

  private t(idx = this.frameIdx): number {
    return idx * this.frameMs;
  }

  /** 現在フレームより preToMs〜preFromMs 前の平均レベル（dB） */
  private preLevelDb(): number {
    const from = Math.round(CLAP_CONSTANTS.preFromMs / this.frameMs);
    const to = Math.round(CLAP_CONSTANTS.preToMs / this.frameMs);
    const h = this.hist;
    let sum = 0;
    let n = 0;
    for (let k = to; k <= from; k++) {
      const v = h[h.length - k];
      if (v === undefined) continue;
      sum += Math.pow(10, v / 10);
      n++;
    }
    return n ? 10 * Math.log10(sum / n + 1e-12) : this.floorDb;
  }

  private processFrame(events: DetectorEvent[]): void {
    const buf = this.frameBuf;
    let energy = 0;
    let diffEnergy = 0;
    let prev = this.lastSample;
    let peakAbs = 0;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i]!;
      energy += x * x;
      const ax = x < 0 ? -x : x;
      if (ax > peakAbs) peakAbs = ax;
      const d = x - prev;
      diffEnergy += d * d;
      prev = x;
    }
    this.lastSample = prev;
    const ms = energy / buf.length;
    const db = 10 * Math.log10(ms + 1e-12);
    this._levelDb = db;
    const frame: Frame = { db, energy, diffEnergy, peakAbs, n: buf.length };
    const now = this.t();
    const warm = now < CLAP_CONSTANTS.warmupMs;
    const e = this.eff;
    const loud = db >= e.minLevelDb && db >= this.floorDb + e.minAboveFloorDb;
    const jump = db - this.preLevelDb();
    const onset = !warm && loud && jump >= e.minJumpDb;

    if (this.mode === 'candidate' && this.cand) {
      const candPeak = Math.max(...this.cand.frames.map((f) => f.db));
      if (onset && db >= candPeak + 10) {
        // 小さな音を分析中に、はるかに大きな鋭い音（拍手）が来た → 新しい音として分析し直す
        this.startCandidate(frame, jump);
      } else {
        this.cand.frames.push(frame);
        if (this.candidateComplete(this.cand)) this.finalize(this.cand, events);
      }
    } else if (this.mode === 'tail') {
      const tailMs = now - this.t(this.tailStartIdx);
      if (onset) {
        this.startCandidate(frame, jump);
      } else if (db < this.floorDb + e.minAboveFloorDb / 2 || (!loud && tailMs > 200)) {
        this.mode = 'idle';
      } else if (tailMs > CLAP_CONSTANTS.maxTailMs) {
        // 余韻にしては長すぎる → 話し声などが続いている
        this.mode = 'idle';
        this.loudRunFrames = Math.round(CLAP_CONSTANTS.activityMs / this.frameMs);
      }
    } else {
      if (onset) {
        this.startCandidate(frame, jump);
      } else if (loud && !warm) {
        this.loudRunFrames++;
        const runMs = this.loudRunFrames * this.frameMs;
        if (runMs >= CLAP_CONSTANTS.activityMs && !this.activityReported) {
          this.activityReported = true;
          events.push({ type: 'activity', timeMs: now, durationMs: Math.round(runMs) });
          this.onActivity(now, '話し声などの続く音', events);
        } else if (this.activityReported) {
          this.lastActivityMs = now;
        }
      } else {
        this.loudRunFrames = 0;
        this.activityReported = false;
      }
    }

    this.updateFloor(db, warm);

    this.hist.push(db);
    if (this.hist.length > this.histLen) this.hist.shift();
    this.frameIdx++;
    if (!this.opts.featuresOnly) this.advanceSequence(now, events);
  }

  /**
   * 周囲の騒音レベル（ノイズフロア）の自動推定。
   * 直近 3 秒のフレームレベルの下位 20% 点を使う。瞬間的な小さな音（コツッ、カチッ）は
   * 全体の一部にすぎないため影響を受けず、エアコン・ファンなどの続く環境音には追従する。
   */
  private updateFloor(db: number, warm: boolean): void {
    this.floorRing.push(db);
    if (this.floorRing.length > this.floorRingMax) this.floorRing.shift();
    this.floorTick++;
    if (this.floorTick >= (warm ? 4 : 20)) {
      this.floorTick = 0;
      this.floorDb = Math.max(-100, percentileOf(this.floorRing, 0.2));
    }
  }

  private startCandidate(frame: Frame, jump: number): void {
    this.mode = 'candidate';
    this.cand = { startIdx: this.frameIdx, preDb: frame.db - jump, frames: [frame] };
    this.loudRunFrames = 0;
    this.activityReported = false;
  }

  private peakIndex(c: Candidate): number {
    const lim = Math.min(c.frames.length, Math.round(CLAP_CONSTANTS.peakSearchMs / this.frameMs) + 1);
    let pi = 0;
    for (let i = 1; i < lim; i++) if (c.frames[i]!.db > c.frames[pi]!.db) pi = i;
    return pi;
  }

  private candidateComplete(c: Candidate): boolean {
    const needAfterPeak = Math.round(CLAP_CONSTANTS.decayToMs / this.frameMs);
    const peakWindow = Math.round(CLAP_CONSTANTS.peakSearchMs / this.frameMs) + 1;
    if (c.frames.length < peakWindow) return false;
    return c.frames.length > this.peakIndex(c) + needAfterPeak;
  }

  private finalize(c: Candidate, events: DetectorEvent[]): void {
    const e = this.eff;
    const pi = this.peakIndex(c);
    const peak = c.frames[pi]!;
    const from = pi + Math.round(CLAP_CONSTANTS.decayFromMs / this.frameMs);
    const to = pi + Math.round(CLAP_CONSTANTS.decayToMs / this.frameMs);
    let sum = 0;
    let n = 0;
    for (let i = from; i <= to && i < c.frames.length; i++) {
      sum += Math.pow(10, c.frames[i]!.db / 10);
      n++;
    }
    const laterDb = n ? 10 * Math.log10(sum / n + 1e-12) : peak.db;
    // 音色は立ち上がり〜ピーク直後（残響の影響が少ない部分）で評価
    let en = 0;
    let df = 0;
    for (let i = 0; i <= Math.min(c.frames.length - 1, pi + 2); i++) {
      en += c.frames[i]!.energy;
      df += c.frames[i]!.diffEnergy;
    }
    // 尖り具合：始まりから 10ms の「最大振幅 ÷ 平均振幅（RMS）」。キーボードのクリック音は細い針状で大きくなる
    const crestFrames = Math.max(1, Math.round(10 / this.frameMs));
    let cE = 0;
    let cN = 0;
    let cP = 0;
    for (let i = 0; i < crestFrames && i < c.frames.length; i++) {
      cE += c.frames[i]!.energy;
      cN += c.frames[i]!.n;
      cP = Math.max(cP, c.frames[i]!.peakAbs);
    }
    const crest = cP / Math.sqrt(cE / Math.max(1, cN) + 1e-12);
    const info = this.buildInfo({
      timeMs: this.t(c.startIdx),
      levelDb: peak.db,
      jumpDb: peak.db - c.preDb,
      riseMs: pi * this.frameMs,
      decayDb: peak.db - laterDb,
      centroidHz: this.centroidHz(en, df),
      crest,
    }, e);
    events.push({ type: 'transient', info });

    this.cand = null;
    this.mode = 'tail';
    this.tailStartIdx = this.frameIdx;
    if (this.opts.featuresOnly) return;
    if (info.accepted) this.onClap(info.timeMs, info.levelDb, events);
    else this.onSharpNoise(info.timeMs, info.reason ?? '拍手以外の音', events);
    // 大きさと急な変化を満たす音は「鋭い音」として記録（直後の 1 回目を数えないため）
    if (info.checks[0]!.pass && info.checks[1]!.pass) this.lastSharpMs = info.timeMs;
  }

  private buildInfo(
    v: Omit<TransientInfo, 'checks' | 'accepted' | 'reason'>,
    e: ClapProfile,
  ): TransientInfo {
    const levelTh = Math.max(e.minLevelDb, this.floorDb + e.minAboveFloorDb);
    const mk = (key: CheckKey, value: number, threshold: number, unit: string, kind: 'min' | 'max'): FeatureCheck => ({
      key,
      label: CHECK_TEXT[key].label,
      value: round1(value),
      threshold: round1(threshold),
      unit,
      kind,
      pass: kind === 'min' ? value >= threshold : value <= threshold,
    });
    const checks = [
      mk('level', v.levelDb, levelTh, 'dB', 'min'),
      mk('jump', v.jumpDb, e.minJumpDb, 'dB', 'min'),
      mk('rise', v.riseMs, e.maxRiseMs, 'ms', 'max'),
      mk('decay', v.decayDb, e.minDecayDb, 'dB', 'min'),
      mk('pitch', v.centroidHz, e.minCentroidHz, 'Hz', 'min'),
      mk('crest', v.crest, e.maxCrest, '', 'max'),
    ];
    const failed = checks.filter((c) => !c.pass);
    return {
      ...v,
      levelDb: round1(v.levelDb),
      jumpDb: round1(v.jumpDb),
      riseMs: round1(v.riseMs),
      decayDb: round1(v.decayDb),
      centroidHz: Math.round(v.centroidHz),
      crest: round1(v.crest),
      checks,
      accepted: failed.length === 0,
      reason: failed.length ? failed.map((c) => CHECK_TEXT[c.key].fail).join('／') : undefined,
    };
  }

  /** 1 次差分のエネルギー比から周波数重心を推定する */
  private centroidHz(energy: number, diffEnergy: number): number {
    if (energy <= 0) return 0;
    const r = Math.min(4, diffEnergy / energy);
    const cos = Math.min(1, Math.max(-1, 1 - r / 2));
    return (Math.acos(cos) * this.opts.sampleRate) / (2 * Math.PI);
  }

  // ---------- 2 回の並び ----------
  private onClap(t: number, level: number, events: DetectorEvent[]): void {
    const seq = this.seq;
    if (seq.state === 'idle') {
      const quietActivity = t - this.lastActivityMs >= CLAP_CONSTANTS.preQuietMs;
      const quietSharp = t - this.lastSharpMs >= CLAP_CONSTANTS.preSharpQuietMs;
      if (quietActivity && quietSharp) {
        this.seq = { state: 'one', t1: t, level1: level };
        events.push({ type: 'first-clap', timeMs: t });
      } else {
        events.push({
          type: 'sequence-cancelled',
          timeMs: t,
          reason: quietActivity
            ? '直前にタイピングなどの鋭い音があったため、1回目として数えませんでした（1秒ほど静かにしてから叩いてください）'
            : '直前に話し声などの音があったため、1回目として数えませんでした（少し静かにしてから叩いてください）',
        });
      }
      return;
    }
    if (seq.state === 'one') {
      const gap = t - seq.t1;
      if (gap < CLAP_CONSTANTS.minIntervalMs) return;
      if (gap > this.opts.maxIntervalMs) {
        // 間隔が長すぎた → 今回を新しい 1 回目とする
        this.seq = { state: 'one', t1: t, level1: level };
        events.push({ type: 'first-clap', timeMs: t });
        return;
      }
      if (Math.abs(level - seq.level1) > CLAP_CONSTANTS.maxLevelDiffDb) {
        this.cancel(t, `2回の大きさが違いすぎます（差 ${Math.round(Math.abs(level - seq.level1))}dB）。同じ強さで叩いてください`, events);
        return;
      }
      this.seq = { state: 'two', t1: seq.t1, t2: t };
      return;
    }
    this.cancel(t, '3回以上続けて鋭い音がありました（タイピング・連続音と判断）', events);
  }

  private onSharpNoise(t: number, reason: string, events: DetectorEvent[]): void {
    if (this.seq.state !== 'idle') this.cancel(t, `途中で拍手ではない鋭い音がありました：${reason}`, events);
  }

  private onActivity(t: number, what: string, events: DetectorEvent[]): void {
    this.lastActivityMs = t;
    if (this.seq.state !== 'idle') this.cancel(t, `途中で${what}がありました`, events);
  }

  private cancel(t: number, reason: string, events: DetectorEvent[]): void {
    this.seq = { state: 'idle' };
    events.push({ type: 'sequence-cancelled', timeMs: t, reason });
  }

  private advanceSequence(t: number, events: DetectorEvent[]): void {
    const seq = this.seq;
    const busy = this.mode === 'candidate';
    if (seq.state === 'one' && t - seq.t1 > this.opts.maxIntervalMs + 100 && !busy) {
      this.seq = { state: 'idle' };
      events.push({
        type: 'sequence-cancelled',
        timeMs: t,
        reason: `2回目が ${(this.opts.maxIntervalMs / 1000).toFixed(2)} 秒以内に来ませんでした（間隔の設定を長くするか、早めに叩いてください）`,
      });
    } else if (seq.state === 'two' && t - seq.t2 >= CLAP_CONSTANTS.confirmMs && !busy) {
      this.seq = { state: 'idle' };
      events.push({ type: 'double-clap', timeMs: t, intervalMs: Math.round(seq.t2 - seq.t1) });
    }
  }
}

function percentileOf(values: number[], p: number): number {
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))] ?? -100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
