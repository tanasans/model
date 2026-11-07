import type { LevelProbe } from './wakePolicy';

/**
 * 認識器に渡した音声（16kHz）と同じ時間軸で、10ms ごとの音量（dBFS）を記録する。
 * 直近 30 秒だけ保持（音声そのものは保持しない）。騒音レベルは直近 5 秒の下位 20% 点。
 */
export class LevelTracker implements LevelProbe {
  private readonly frameLen: number;
  private readonly cap = 3000;
  private readonly ring: Float32Array;
  private total = 0;
  private acc = 0;
  private accN = 0;
  private floorCache = -70;
  private floorAt = -1;

  constructor(readonly sampleRate = 16_000) {
    this.frameLen = Math.round(sampleRate / 100);
    this.ring = new Float32Array(this.cap);
  }

  /** これまでに受け取った音声の長さ（秒） */
  get timeSec(): number {
    return (this.total * this.frameLen + this.accN) / this.sampleRate;
  }

  /** 直近フレームのレベル（メーター表示用） */
  get lastDb(): number {
    return this.total ? this.ring[(this.total - 1) % this.cap]! : -100;
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      this.acc += x * x;
      if (++this.accN === this.frameLen) {
        this.ring[this.total % this.cap] = 10 * Math.log10(this.acc / this.frameLen + 1e-12);
        this.total++;
        this.acc = 0;
        this.accN = 0;
      }
    }
  }

  maxDb(t0: number, t1: number): number | null {
    const a = Math.max(Math.floor(t0 * 100), this.total - this.cap, 0);
    const b = Math.min(Math.floor(t1 * 100), this.total);
    if (b <= a) return null;
    let m = -Infinity;
    for (let i = a; i < b; i++) m = Math.max(m, this.ring[i % this.cap]!);
    return m;
  }

  floorDb(): number {
    if (this.total === 0) return -70;
    if (this.floorAt >= 0 && this.total - this.floorAt < 50) return this.floorCache;
    const n = Math.min(this.total, 500);
    const vals: number[] = [];
    for (let i = this.total - n; i < this.total; i++) vals.push(this.ring[i % this.cap]!);
    vals.sort((p, q) => p - q);
    this.floorCache = vals[Math.floor(0.2 * (vals.length - 1))]!;
    this.floorAt = this.total;
    return this.floorCache;
  }
}
