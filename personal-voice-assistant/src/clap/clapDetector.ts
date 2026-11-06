/**
 * 拍手 2 回の検出ロジック（ブラウザ内で完結。外部送信なし）。
 *
 * 音声サンプルを約 5ms のフレームに区切り、次の条件をすべて満たす「短く鋭い高めの音」を拍手とみなす。
 *  1. 大きさ   : フレームの音量（RMS）が絶対しきい値以上、かつ周囲の騒音レベル＋一定 dB 以上
 *  2. 立ち上がり: 直前 15ms と比べて急激に大きくなった（話し声・物音のゆっくりした立ち上がりを除外）
 *  3. 短さ     : ピークから 12dB 下がるまでが短い（話し声・音楽など続く音を除外）
 *  4. 音の高さ : 周波数重心が一定以上（机に物を置く「ドン」という低い音を除外）
 * さらに 2 回の並び方で判定する。
 *  - 1 回目の前に一定時間「大きな音」がない（会話・タイピングの途中では反応しない）
 *  - 2 回の間隔が最小〜最大間隔の範囲内、2 回の大きさが近い
 *  - 2 回目の後、確認時間内に 3 回目の音がない（タイピング等の連続音を除外）
 */

export interface ClapDetectorOptions {
  sampleRate: number;
  /** 感度 1（鈍い）〜 10（敏感）。既定 5 */
  sensitivity: number;
  /** 1 回目と 2 回目の最大間隔（ms）。既定 600 */
  maxIntervalMs: number;
}

export interface TransientInfo {
  timeMs: number;
  /** フレーム RMS のピーク（dBFS） */
  levelDb: number;
  /** 周波数重心の推定値（Hz） */
  centroidHz: number;
  /** 音の長さ（ms） */
  durationMs: number;
  accepted: boolean;
  /** 不採用の理由（日本語） */
  reason?: string;
}

export type DetectorEvent =
  | { type: 'transient'; info: TransientInfo }
  | { type: 'first-clap'; timeMs: number }
  | { type: 'sequence-cancelled'; timeMs: number; reason: string }
  | { type: 'double-clap'; timeMs: number };

/** 判定に使う固定パラメータ（テストや調整用に公開） */
export const CLAP_CONSTANTS = {
  frameMs: 5,
  /** 直前何 ms と比較して立ち上がりの鋭さを見るか */
  attackLookbackMs: 15,
  /** 立ち上がりに必要な増加量（dB） */
  attackDb: 15,
  /** ピークからこの dB 下がったら音の終わり */
  decayDb: 12,
  /** これより長い音は拍手ではない（ms） */
  maxDurationMs: 150,
  /** 周波数重心の下限（Hz）。低い「ドン」を除外 */
  minCentroidHz: 1500,
  /** 1 回目の前に必要な静かな時間（ms） */
  preQuietMs: 400,
  /** 2 回の最小間隔（ms）。反響の二重検出を除外 */
  minIntervalMs: 120,
  /** 2 回目の後、3 回目が来ないことを確認する時間（ms） */
  confirmMs: 350,
  /** 2 回の大きさの差の上限（dB） */
  maxLevelDiffDb: 10,
  /** 開始直後に騒音レベルを学習する時間（ms）。この間は検出しない */
  warmupMs: 800,
} as const;

/** 感度 → しきい値。感度が高いほど小さな音でも反応する */
export function thresholdsFor(sensitivity: number): { minLevelDb: number; riseDb: number } {
  const s = Math.min(10, Math.max(1, Math.round(sensitivity)));
  return {
    // 感度5で -24dBFS（目安：1m 程度離れた普通の拍手）。1 段階 2.5dB
    minLevelDb: -24 - (s - 5) * 2.5,
    // 周囲の騒音レベルからの上昇量
    riseDb: 22 - (s - 5) * 1.5,
  };
}

type Sequence =
  | { state: 'idle' }
  | { state: 'one'; t1: number; level1: number }
  | { state: 'two'; t2: number };

interface Candidate {
  startMs: number;
  peakDb: number;
  /** 立ち上がり直後の数フレームの周波数特性（エネルギー加重） */
  energy: number;
  diffEnergy: number;
  frames: number;
  /** 'noise' は拍手ではない大きな音（話し声など）を最後まで追跡しているもの */
  kind: 'candidate' | 'noise';
  rejectReason?: string;
  peakFrameReported: boolean;
}

export class ClapDetector {
  private opts: ClapDetectorOptions;
  private frameSize: number;
  private frameBuf: Float32Array;
  private frameFill = 0;
  private lastSample = 0;
  private samplesSeen = 0;
  private floorDb = -60;
  private recentDb: number[] = [];
  private lookbackFrames: number;
  private current: Candidate | null = null;
  private seq: Sequence = { state: 'idle' };
  /** 最後に「大きな音（拍手以外も含む）」があった時刻 */
  private lastNoiseMs = -Infinity;
  private _levelDb = -100;

  constructor(opts: ClapDetectorOptions) {
    this.opts = { ...opts };
    this.frameSize = Math.max(32, Math.round((opts.sampleRate * CLAP_CONSTANTS.frameMs) / 1000));
    this.frameBuf = new Float32Array(this.frameSize);
    this.lookbackFrames = Math.max(1, Math.round(CLAP_CONSTANTS.attackLookbackMs / CLAP_CONSTANTS.frameMs));
  }

  /** 直近フレームの音量（dBFS）。メーター表示用 */
  get levelDb(): number {
    return this._levelDb;
  }

  /** 周囲の騒音レベル（dBFS）。メーター表示用 */
  get noiseFloorDb(): number {
    return this.floorDb;
  }

  /** 現在の感度での反応しきい値（dBFS）。メーター表示用 */
  get triggerLevelDb(): number {
    const th = thresholdsFor(this.opts.sensitivity);
    return Math.max(th.minLevelDb, this.floorDb + th.riseDb);
  }

  get waitingForSecond(): boolean {
    return this.seq.state !== 'idle';
  }

  setOptions(partial: Partial<Omit<ClapDetectorOptions, 'sampleRate'>>): void {
    this.opts = { ...this.opts, ...partial };
  }

  /** 任意長のサンプル列を処理し、発生したイベントを返す */
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

  private nowMs(): number {
    return (this.samplesSeen / this.opts.sampleRate) * 1000;
  }

  private processFrame(events: DetectorEvent[]): void {
    const buf = this.frameBuf;
    let energy = 0;
    let diffEnergy = 0;
    let prev = this.lastSample;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i]!;
      energy += x * x;
      const d = x - prev;
      diffEnergy += d * d;
      prev = x;
    }
    this.lastSample = prev;
    this.samplesSeen += buf.length;
    const t = this.nowMs();
    const rms = Math.sqrt(energy / buf.length);
    const db = 20 * Math.log10(rms + 1e-9);
    this._levelDb = db;

    const th = thresholdsFor(this.opts.sensitivity);
    const warm = t < CLAP_CONSTANTS.warmupMs;

    if (this.current) {
      this.trackEvent(this.current, db, energy, diffEnergy, t, events);
    } else if (!warm && db >= th.minLevelDb && db >= this.floorDb + th.riseDb) {
      const before = this.recentDb.length ? Math.min(...this.recentDb) : this.floorDb;
      const sharp = db - before >= CLAP_CONSTANTS.attackDb;
      this.current = {
        startMs: t,
        peakDb: db,
        energy,
        diffEnergy,
        frames: 1,
        kind: sharp ? 'candidate' : 'noise',
        rejectReason: sharp ? undefined : '立ち上がりが緩やか（話し声・物音など）',
        peakFrameReported: false,
      };
    } else {
      // 騒音レベルの学習（下がるときは速く、上がるときはゆっくり）
      const a = warm ? 0.3 : db < this.floorDb ? 0.2 : 0.01;
      this.floorDb = Math.max(-90, this.floorDb + a * (db - this.floorDb));
    }

    this.recentDb.push(db);
    if (this.recentDb.length > this.lookbackFrames) this.recentDb.shift();

    this.advanceSequence(t, events);
  }

  private trackEvent(
    c: Candidate,
    db: number,
    energy: number,
    diffEnergy: number,
    t: number,
    events: DetectorEvent[],
  ): void {
    c.frames++;
    if (db > c.peakDb) c.peakDb = db;
    // 立ち上がり直後（約 20ms）の音色だけを評価する（残響の影響を減らす）
    if (c.frames <= 4) {
      c.energy += energy;
      c.diffEnergy += diffEnergy;
    }
    const duration = t - c.startMs;
    const th = thresholdsFor(this.opts.sensitivity);
    const ended = db < c.peakDb - CLAP_CONSTANTS.decayDb || db < this.floorDb + th.riseDb / 2;

    if (c.kind === 'candidate' && !ended && duration > CLAP_CONSTANTS.maxDurationMs) {
      c.kind = 'noise';
      c.rejectReason = '音が長い（話し声・音楽など）';
    }
    if (!ended) return;

    this.current = null;
    const centroidHz = this.centroidHz(c.energy, c.diffEnergy);
    let accepted = c.kind === 'candidate';
    let reason = c.rejectReason;
    if (accepted && centroidHz < CLAP_CONSTANTS.minCentroidHz) {
      accepted = false;
      reason = '音が低い（物を置く音など）';
    }
    const info: TransientInfo = {
      timeMs: c.startMs,
      levelDb: round1(c.peakDb),
      centroidHz: Math.round(centroidHz),
      durationMs: Math.round(duration),
      accepted,
      reason,
    };
    events.push({ type: 'transient', info });
    if (accepted) this.onClap(c.startMs, c.peakDb, events);
    else this.onNoise(t, reason ?? '拍手以外の音', events);
  }

  /** 1 次差分のエネルギー比から周波数重心を推定する（正弦波なら厳密にその周波数になる） */
  private centroidHz(energy: number, diffEnergy: number): number {
    if (energy <= 0) return 0;
    const r = Math.min(4, diffEnergy / energy); // = 2(1 - cos ω)
    const cos = Math.min(1, Math.max(-1, 1 - r / 2));
    return (Math.acos(cos) * this.opts.sampleRate) / (2 * Math.PI);
  }

  private onClap(t: number, level: number, events: DetectorEvent[]): void {
    const seq = this.seq;
    if (seq.state === 'idle') {
      if (t - this.lastNoiseMs >= CLAP_CONSTANTS.preQuietMs) {
        this.seq = { state: 'one', t1: t, level1: level };
        events.push({ type: 'first-clap', timeMs: t });
      } else {
        // 直前に別の音があった（会話・タイピングの途中など）
        this.lastNoiseMs = t;
      }
      return;
    }
    if (seq.state === 'one') {
      const gap = t - seq.t1;
      if (gap < CLAP_CONSTANTS.minIntervalMs) return; // 反響
      if (gap <= this.opts.maxIntervalMs && Math.abs(level - seq.level1) <= CLAP_CONSTANTS.maxLevelDiffDb) {
        this.seq = { state: 'two', t2: t };
      } else {
        this.cancel(t, gap > this.opts.maxIntervalMs ? '間隔が長すぎる' : '2回の大きさが違いすぎる', events);
      }
      return;
    }
    // 3 回目の音 → 連続音とみなして取り消し
    this.cancel(t, '3回以上続いた（タイピング・連続音など）', events);
  }

  private onNoise(t: number, reason: string, events: DetectorEvent[]): void {
    if (this.seq.state !== 'idle') this.cancel(t, `途中で別の音があった：${reason}`, events);
    else this.lastNoiseMs = t;
  }

  private cancel(t: number, reason: string, events: DetectorEvent[]): void {
    this.seq = { state: 'idle' };
    this.lastNoiseMs = t;
    events.push({ type: 'sequence-cancelled', timeMs: t, reason });
  }

  private advanceSequence(t: number, events: DetectorEvent[]): void {
    const seq = this.seq;
    if (seq.state === 'one' && t - seq.t1 > this.opts.maxIntervalMs && !this.current) {
      this.seq = { state: 'idle' };
      this.lastNoiseMs = seq.t1;
      events.push({ type: 'sequence-cancelled', timeMs: t, reason: '2回目が来なかった' });
    } else if (seq.state === 'two' && t - seq.t2 >= CLAP_CONSTANTS.confirmMs && !this.current) {
      this.seq = { state: 'idle' };
      this.lastNoiseMs = t;
      events.push({ type: 'double-clap', timeMs: t });
    }
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
