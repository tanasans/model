/**
 * テスト用の合成音。実際の部屋・マイクに近づけるため、
 * 拍手には帯域の偏り・立ち上がり時間・残響（部屋の響き）・音量のばらつきを持たせる。
 */
export const SR = 48_000;

/** 再現性のある疑似乱数（-0.5〜0.5） */
export function rng(seed = 1): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000 - 0.5;
  };
}

/** 2 次の帯域通過フィルタ（RBJ biquad） */
function bandpass(x: Float32Array, centerHz: number, q: number, sr = SR): Float32Array {
  const w = (2 * Math.PI * centerHz) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w)) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i]! + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

function normalizePeak(x: Float32Array, peak: number): Float32Array {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] = (x[i]! / m) * peak;
  return x;
}

export interface ClapParams {
  /** ピーク振幅（0〜1） */
  peak?: number;
  /** 立ち上がり時間（ms） */
  attackMs?: number;
  /** 直接音の減衰時定数（ms） */
  decayMs?: number;
  /** 帯域の中心（Hz） */
  centerHz?: number;
  /** 残響のレベル（直接音ピーク比 dB、例: -18） */
  reverbDb?: number;
  /** 残響時間 RT60（秒） */
  rt60?: number;
  seed?: number;
}

export function clapWave(p: ClapParams = {}): Float32Array {
  const { peak = 0.5, attackMs = 0.5, decayMs = 8, centerHz = 2000, reverbDb = -20, rt60 = 0.4, seed = 1 } = p;
  const r = rng(seed);
  const len = Math.round(SR * Math.max(0.12, rt60 * 1.2));
  const noise = new Float32Array(len);
  for (let i = 0; i < len; i++) noise[i] = r() * 2;
  const shaped = bandpass(noise, centerHz, 0.6);
  const out = new Float32Array(len);
  const a = (attackMs / 1000) * SR;
  const d = (decayMs / 1000) * SR;
  // 残響: -60dB に rt60 秒で減衰する指数カーブ。直接音より少し遅れて立ち上がる
  const rvTau = (rt60 * SR) / 6.9;
  const rvGain = Math.pow(10, reverbDb / 20);
  const r2 = rng(seed + 99);
  for (let i = 0; i < len; i++) {
    const att = a > 0 ? Math.min(1, i / a) : 1;
    const direct = att * Math.exp(-Math.max(0, i - a) / d) * shaped[i]!;
    const rvEnv = Math.min(1, i / (SR * 0.01)) * Math.exp(-i / rvTau);
    out[i] = direct + rvGain * 2.2 * rvEnv * r2() * 2 * 0.5;
  }
  return normalizePeak(out, peak);
}

/** タイムライン上に音を重ねる */
export class Track {
  readonly data: Float32Array;
  constructor(seconds: number, noiseDb = -58, seed = 7) {
    this.data = new Float32Array(Math.round(seconds * SR));
    // ピンク寄りの背景雑音（空調・PC ファン）
    const r = rng(seed);
    const amp = Math.pow(10, noiseDb / 20) * Math.sqrt(3);
    let lp = 0;
    for (let i = 0; i < this.data.length; i++) {
      lp = 0.97 * lp + 0.03 * r() * 2;
      this.data[i] = amp * (0.5 * r() * 2 + 4 * lp);
    }
  }
  addWave(atMs: number, w: Float32Array): this {
    const start = Math.round((atMs / 1000) * SR);
    for (let i = 0; i < w.length && start + i < this.data.length; i++) this.data[start + i]! += w[i]!;
    return this;
  }
  clap(atMs: number, p: ClapParams = {}): this {
    return this.addWave(atMs, clapWave({ seed: Math.round(atMs) + 3, ...p }));
  }
  /** 話し声：音節ごとに破裂音（パ・タ・カ）＋母音。摩擦音（サ行）も混ぜる */
  speech(atMs: number, seconds: number, peak = 0.3, seed = 5): this {
    const r = rng(seed);
    let t = 0;
    const out = new Float32Array(Math.round(seconds * SR));
    while (t < seconds - 0.25) {
      const syl = 0.14 + (r() + 0.5) * 0.12;
      const f0 = 110 + (r() + 0.5) * 120;
      const s0 = Math.round(t * SR);
      const kind = r() + 0.5;
      let vowelStart = s0;
      if (kind < 0.35) {
        // 破裂音：10ms の鋭いバースト → 20ms 後に母音
        const n = Math.round(0.01 * SR);
        const b = new Float32Array(n);
        for (let i = 0; i < n; i++) b[i] = r() * 2 * Math.exp(-i / (SR * 0.003));
        const bb = bandpass(b, 2500, 0.8);
        for (let i = 0; i < n && s0 + i < out.length; i++) out[s0 + i]! += bb[i]! * peak * 2.5;
        vowelStart = s0 + Math.round(0.02 * SR);
      } else if (kind < 0.5) {
        // 摩擦音：80ms の高い雑音
        const n = Math.round(0.08 * SR);
        const f = new Float32Array(n);
        for (let i = 0; i < n; i++) f[i] = r() * 2;
        const ff = bandpass(f, 5000, 1);
        for (let i = 0; i < n && s0 + i < out.length; i++) out[s0 + i]! += ff[i]! * peak * 0.8 * Math.sin((Math.PI * i) / n);
        vowelStart = s0 + n;
      }
      const vn = Math.round(syl * SR);
      for (let i = 0; i < vn && vowelStart + i < out.length; i++) {
        const tt = i / SR;
        const env = Math.min(1, tt / 0.025) * Math.min(1, (vn - i) / (SR * 0.03));
        let v = 0;
        for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f0 * h * tt) * (h === 3 || h === 4 ? 1.2 : 1 / h);
        out[vowelStart + i]! += peak * 0.35 * env * v;
      }
      t += syl + 0.03 + (r() + 0.5) * 0.06 + (r() > 0.42 ? 0.35 : 0); // ときどき息継ぎ
    }
    return this.addWave(atMs, out);
  }
  /** キーボード：カチッという高い短音＋低いコトッ。不規則な間隔で打鍵し、ときどき止まる */
  typing(atMs: number, seconds: number, peak = 0.25, seed = 9): this {
    const r = rng(seed);
    let t = 0;
    while (t < seconds) {
      const n = Math.round(0.03 * SR);
      const c = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const click = r() * 2 * Math.exp(-i / (SR * (0.0008 + (r() + 0.5) * 0.0015)));
        const thock = Math.sin((2 * Math.PI * 180 * i) / SR) * Math.exp(-i / (SR * 0.006)) * 0.4;
        c[i] = click + thock;
      }
      const amp = peak * (0.5 + (r() + 0.5) * 0.8);
      this.addWave(atMs + t * 1000, normalizePeak(bandpass(c, 3500, 0.5), amp));
      // 打鍵間隔 80〜350ms、ときどき 0.6〜2 秒止まる
      t += 0.08 + (r() + 0.5) * 0.27 + (r() > 0.4 ? (r() + 0.5) * 1.4 + 0.6 : 0);
    }
    return this;
  }
  /** 文章入力に近いタイピング：単語ごとに 3〜8 打鍵、単語の間、ときどき考える間（1〜3 秒） */
  typingWords(atMs: number, seconds: number, peak = 0.25, seed = 9): this {
    const r = rng(seed);
    let t = 0;
    while (t < seconds) {
      const keys = 3 + Math.floor((r() + 0.5) * 6);
      for (let k = 0; k < keys && t < seconds; k++) {
        this.typing(atMs + t * 1000, 0.001, peak, seed + Math.round(t * 1000));
        t += 0.1 + (r() + 0.5) * 0.15;
      }
      t += 0.15 + (r() + 0.5) * 0.35 + (r() > 0.35 ? (r() + 0.5) * 2 + 1 : 0);
    }
    return this;
  }
  /**
   * 実機に近いキーボード：1 打鍵 ＝ 押す音（カチッ＋底打ちのコトッ）＋ 70〜180ms 後の離す音（4〜12dB 小さい）。
   * キーごとに音量・音色がばらつき、スペース・Enter は大きめ。
   * 打ち方：単語（3〜8 打鍵）、2 打鍵だけで止まる操作（Enter 2 回・Backspace 2 回など）、1 打鍵だけ、考える間（1〜4 秒）。
   */
  keystroke(atMs: number, peak: number, seed: number, opts: { big?: boolean } = {}): this {
    const r = rng(seed);
    const mk = (amp: number, clickMs: number, center: number, thockHz: number) => {
      const n = Math.round(0.035 * SR);
      const c = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const click = r() * 2 * Math.exp(-i / (SR * clickMs / 1000));
        const thock = Math.sin((2 * Math.PI * thockHz * i) / SR) * Math.exp(-i / (SR * 0.008)) * (opts.big ? 0.7 : 0.35);
        c[i] = click + thock;
      }
      return normalizePeak(bandpass(c, center, 0.45), amp);
    };
    const press = peak * (opts.big ? 1.4 : 0.6 + (r() + 0.5) * 0.7);
    this.addWave(atMs, mk(press, 0.6 + (r() + 0.5) * 2.2, 2200 + (r() + 0.5) * 3000, opts.big ? 140 : 200 + (r() + 0.5) * 150));
    const relAt = atMs + 70 + (r() + 0.5) * 110;
    const rel = press * Math.pow(10, -(4 + (r() + 0.5) * 8) / 20);
    return this.addWave(relAt, mk(rel, 0.5 + (r() + 0.5) * 1.2, 3000 + (r() + 0.5) * 2500, 260));
  }
  typingReal(atMs: number, seconds: number, peak = 0.2, seed = 9): this {
    const r = rng(seed);
    let t = 0;
    let k = 0;
    while (t < seconds) {
      const u = r() + 0.5;
      const keys = u < 0.2 ? 1 : u < 0.45 ? 2 : 3 + Math.floor((r() + 0.5) * 6);
      for (let i = 0; i < keys && t < seconds; i++) {
        const big = r() + 0.5 < (keys <= 2 ? 0.5 : 0.12); // 単独操作は Enter・スペースが多い
        this.keystroke(atMs + t * 1000, peak, seed * 7919 + k++, { big });
        t += 0.11 + (r() + 0.5) * 0.25;
      }
      t += 0.2 + (r() + 0.5) * 0.4 + (r() > 0.25 ? 1 + (r() + 0.5) * 3 : 0);
    }
    return this;
  }
  click(atMs: number, peak = 0.05): this {
    const r = rng(Math.round(atMs) + 1);
    const n = Math.round(SR * 0.01);
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = peak * r() * 2 * Math.exp(-i / (SR * 0.0015));
    return this.addWave(atMs, w);
  }
  /** 机に物を置く音：低い「ドン」 */
  thud(atMs: number, peak = 0.6): this {
    const n = Math.round(0.15 * SR);
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = peak * Math.sin((2 * Math.PI * 90 * i) / SR) * Math.exp(-i / (SR * 0.03));
    return this.addWave(atMs, w);
  }
}

export function dbToAmp(db: number): number {
  return Math.pow(10, db / 20);
}
