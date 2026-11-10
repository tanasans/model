/**
 * 音量ゲート：静かな間は音声認識（Vosk）に音声を送らず、PC の負担を減らす。
 * - 周囲の騒音より openAboveDb 以上大きい音が来たら送り始め、直前 preRollSec 秒の音もまとめて送る（言葉の頭を欠かさない）
 * - 静かになってから hangSec 秒は送り続ける（認識の「言い終わり」判定に必要な無音を渡す）
 * - 送った音声の時間軸（Vosk の単語時刻）を、待機開始からの時間軸（音量の記録）に変換できるようにする
 *   （呼びかけの前後の静けさの確認は、変換した時刻で行う）
 */
export interface AudioGateOptions {
  sampleRate?: number;
  preRollSec?: number;
  hangSec?: number;
  openAboveDb?: number;
}

export class AudioGate {
  private readonly sr: number;
  private readonly preRollMax: number;
  private readonly hangSamples: number;
  private readonly openAboveDb: number;
  private pre: Float32Array[] = [];
  private preLen = 0;
  private open = false;
  private quiet = 0;
  /** これまでに受け取った音声（サンプル数） */
  private streamSamples = 0;
  /** これまでに送った音声（サンプル数） */
  private fedSamples = 0;
  /** 送った音声の区間ごとの対応（送った位置 → 受け取った位置） */
  private segments: Array<{ fed: number; stream: number }> = [];
  /** 送らずに済んだ音声（サンプル数） */
  skippedSamples = 0;

  constructor(o: AudioGateOptions = {}) {
    this.sr = o.sampleRate ?? 16_000;
    this.preRollMax = Math.round((o.preRollSec ?? 0.6) * this.sr);
    this.hangSamples = Math.round((o.hangSec ?? 1.2) * this.sr);
    this.openAboveDb = o.openAboveDb ?? 8;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** 受け取った音声を渡す。認識へ送る音声のかたまりを返す（静かな間は空） */
  push(x: Float32Array, floorDb: number): Float32Array[] {
    const start = this.streamSamples;
    this.streamSamples += x.length;
    let e = 0;
    for (let i = 0; i < x.length; i++) e += x[i]! * x[i]!;
    const db = 10 * Math.log10(e / Math.max(1, x.length) + 1e-12);
    const loud = db >= floorDb + this.openAboveDb;

    if (!this.open) {
      if (loud) {
        // 送り始める：直前の音（最大 preRollSec 秒）から
        this.open = true;
        this.quiet = 0;
        const out = [...this.pre, x];
        this.segments.push({ fed: this.fedSamples, stream: start - this.preLen });
        if (this.segments.length > 200) this.segments.shift();
        this.fedSamples += this.preLen + x.length;
        this.pre = [];
        this.preLen = 0;
        return out;
      }
      // 送らない（直前の音として少しだけ覚えておく）
      this.pre.push(x);
      this.preLen += x.length;
      while (this.preLen - this.pre[0]!.length >= this.preRollMax) this.preLen -= this.pre.shift()!.length;
      this.skippedSamples += x.length;
      return [];
    }
    this.fedSamples += x.length;
    this.quiet = loud ? 0 : this.quiet + x.length;
    if (this.quiet >= this.hangSamples) this.open = false;
    return [x];
  }

  /** 認識器の時刻（送った音声の秒）→ 待機開始からの秒 */
  toStreamSec(fedSec: number): number {
    const f = fedSec * this.sr;
    let seg = this.segments[0];
    for (const s of this.segments) if (s.fed <= f) seg = s;
    if (!seg) return fedSec;
    return (seg.stream + (f - seg.fed)) / this.sr;
  }
}
