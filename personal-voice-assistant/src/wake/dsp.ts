/**
 * ウェイクワード用の音声前処理（ブラウザ内で完結。外部送信なし）。
 *  - Resampler   : マイクのサンプルレート（48kHz 等）→ 16kHz
 *  - NoiseReducer: 定常的な雑音（エアコン・PC ファン・サー音）を弱めるスペクトル減算
 * 合成音声による評価で、雑音のある部屋での認識率が大きく改善したため導入（README 参照）。
 * どちらも逐次処理（ストリーミング）で、任意の長さのチャンクを受け付ける。
 */

export const WAKE_SAMPLE_RATE = 16_000;

/** 窓関数付き sinc の低域通過 FIR ＋ 線形補間による逐次リサンプラ */
export class Resampler {
  private readonly ratio: number;
  private readonly taps: Float32Array;
  private readonly hist: Float32Array;
  private histPos = 0;
  /** 次の出力サンプルの位置（入力サンプル単位、フィルタ後の系列上） */
  private t = 0;
  private filtered: number[] = [];
  private filteredOffset = 0;

  constructor(
    readonly inRate: number,
    readonly outRate = WAKE_SAMPLE_RATE,
  ) {
    this.ratio = inRate / outRate;
    const n = inRate === outRate ? 1 : 63;
    const cutoff = Math.min(0.45 * outRate, 7200) / inRate; // 正規化遮断周波数
    this.taps = new Float32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const m = i - (n - 1) / 2;
      const sinc = m === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * m) / (Math.PI * m);
      const win = n === 1 ? 1 : 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
      this.taps[i] = sinc * win;
      sum += this.taps[i]!;
    }
    for (let i = 0; i < n; i++) this.taps[i]! /= sum;
    this.hist = new Float32Array(n);
  }

  process(input: Float32Array): Float32Array {
    const n = this.taps.length;
    for (let i = 0; i < input.length; i++) {
      this.hist[this.histPos] = input[i]!;
      this.histPos = (this.histPos + 1) % n;
      let acc = 0;
      for (let k = 0; k < n; k++) acc += this.taps[k]! * this.hist[(this.histPos + k) % n]!;
      this.filtered.push(acc);
    }
    const out: number[] = [];
    while (this.t + 1 < this.filteredOffset + this.filtered.length) {
      const idx = this.t - this.filteredOffset;
      const i0 = Math.floor(idx);
      const frac = idx - i0;
      out.push(this.filtered[i0]! * (1 - frac) + this.filtered[i0 + 1]! * frac);
      this.t += this.ratio;
    }
    // 使い終わった部分を捨てる
    const drop = Math.max(0, Math.floor(this.t - this.filteredOffset) - 1);
    if (drop > 0) {
      this.filtered.splice(0, drop);
      this.filteredOffset += drop;
    }
    return Float32Array.from(out);
  }
}

/** 基数 2 の複素 FFT（その場計算） */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a]! += xr;
        im[a]! += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export interface NoiseReducerOptions {
  /** 減算の強さ（大きいほど雑音を強く消すが、声もひずみやすい） */
  overSubtraction?: number;
  /** 最小ゲイン（完全に消さず、自然さを保つ） */
  floorGain?: number;
}

/**
 * 逐次スペクトル減算（512 点 STFT、ホップ 128、Hann 窓、重畳加算）。
 * 雑音スペクトルは周波数ごとに「下がるときは速く、上がるときはゆっくり」追跡する（最小値追跡の簡易版）。
 * 声のように短時間で変化する成分は雑音と見なされにくく、エアコン等の続く音だけが弱まる。
 */
export class NoiseReducer {
  static readonly N = 512;
  static readonly HOP = 128;
  private readonly win: Float64Array;
  private readonly inBuf: Float64Array;
  private inFill = 0;
  private readonly outAcc: Float64Array;
  private noise: Float64Array | null = null;
  private smooth: Float64Array | null = null;
  /** 雑音追跡値の補正係数 */
  static readonly BIAS = 1.6;
  private frames = 0;
  private readonly alpha: number;
  private readonly floorGain: number;
  private readonly re = new Float64Array(NoiseReducer.N);
  private readonly im = new Float64Array(NoiseReducer.N);

  constructor(opts: NoiseReducerOptions = {}) {
    const N = NoiseReducer.N;
    this.alpha = opts.overSubtraction ?? 1.5;
    this.floorGain = opts.floorGain ?? 0.1;
    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    this.inBuf = new Float64Array(N);
    this.outAcc = new Float64Array(N);
  }

  /** 入力と同じ長さの出力を返す（N - HOP サンプルの遅延あり） */
  process(input: Float32Array): Float32Array {
    const { N, HOP } = NoiseReducer;
    const out = new Float32Array(input.length);
    let o = 0;
    for (let i = 0; i < input.length; i++) {
      // 入力を末尾に詰める（inBuf は常に直近 N サンプル）
      this.inBuf[N - HOP + this.inFill] = input[i]!;
      this.inFill++;
      if (this.inFill === HOP) {
        this.inFill = 0;
        this.processFrame();
        for (let k = 0; k < HOP; k++) out[o++] = this.outAcc[k]!;
        this.outAcc.copyWithin(0, HOP);
        this.outAcc.fill(0, N - HOP);
        this.inBuf.copyWithin(0, HOP);
      }
    }
    return o === out.length ? out : out.subarray(0, o);
  }

  private processFrame(): void {
    const { N } = NoiseReducer;
    const { re, im, win } = this;
    for (let i = 0; i < N; i++) {
      re[i] = this.inBuf[i]! * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    const bins = N / 2 + 1;
    if (!this.noise) {
      this.noise = new Float64Array(bins);
      for (let k = 0; k < bins; k++) this.noise[k] = re[k]! * re[k]! + im[k]! * im[k]! + 1e-12;
    }
    const nz = this.noise;
    const sm = this.smooth ?? (this.smooth = Float64Array.from(nz));
    const warm = this.frames < 30; // 最初の約 0.25 秒は雑音推定を速く合わせる
    this.frames++;
    for (let k = 0; k < bins; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]! + 1e-12;
      // 時間方向に平滑化したパワーで雑音を追跡（下がるときは速く、上がるときはゆっくり）
      sm[k] = sm[k]! * 0.7 + p * 0.3;
      if (warm) nz[k] = nz[k]! * 0.8 + sm[k]! * 0.2;
      else nz[k] = sm[k]! < nz[k]! ? nz[k]! + 0.1 * (sm[k]! - nz[k]!) : nz[k]! * 1.003;
      // 追跡値は平均より低めに出るため補正（BIAS）してから減算
      const g = Math.max(1 - (this.alpha * NoiseReducer.BIAS * nz[k]!) / p, this.floorGain);
      re[k]! *= g;
      im[k]! *= g;
      if (k > 0 && k < N / 2) {
        re[N - k]! *= g;
        im[N - k]! *= g;
      }
    }
    // 逆 FFT（共役 → FFT → 共役）
    for (let i = 0; i < N; i++) im[i] = -im[i]!;
    fft(re, im);
    // Hann 窓（解析）× Hann 窓（合成）をホップ N/4 で重ねると和は 1.5 になる
    for (let i = 0; i < N; i++) this.outAcc[i]! += ((re[i]! / N) * win[i]!) / 1.5;
  }
}

/** 前処理一式：リサンプル → 雑音低減 */
export class WakePreprocessor {
  private readonly rs: Resampler;
  private readonly nr: NoiseReducer | null;
  constructor(inRate: number, opts: { noiseReduction: boolean }) {
    this.rs = new Resampler(inRate, WAKE_SAMPLE_RATE);
    this.nr = opts.noiseReduction ? new NoiseReducer() : null;
  }
  process(input: Float32Array): Float32Array {
    const x = this.rs.process(input);
    return this.nr ? this.nr.process(x) : x;
  }
}
