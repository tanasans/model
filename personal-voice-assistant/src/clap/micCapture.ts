/**
 * 拍手検出用のマイク入力（ブラウザ内のみ。送信・保存なし）。
 *
 * 自動音量調整（AGC）・ノイズ抑制（NS）・エコーキャンセル（EC）は拍手の波形を大きく変える：
 *  - ノイズ抑制は「突発的な短い音」を雑音として削るため、拍手の立ち上がりが鈍り・小さくなる
 *  - 自動音量調整は大きな音の直後に音量を下げ、静かなときに雑音を持ち上げるため、2回目の拍手が小さくなる
 *  - エコーキャンセルは処理のために音を遅延・加工する
 * そのため拍手検出ではすべてオフを要求し、実際に適用された設定を画面に表示する。
 * （通常の音声会話は従来どおりオンのまま。会話の聞き取りやすさは変わらない）
 */

export interface MicProcessing {
  autoGainControl: boolean | null;
  noiseSuppression: boolean | null;
  echoCancellation: boolean | null;
  /** 一部の Chrome / OS で使える「声の分離」 */
  voiceIsolation: boolean | null;
  label: string;
  sampleRate: number;
}

export interface MicCapture {
  sampleRate: number;
  processing: MicProcessing;
  close(): void;
}

const WORKLET_SOURCE = `
class ClapTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(2048);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('clap-tap', ClapTap);
`;

export class MicError extends Error {}

/** マイクを開き、サンプルを onSamples に渡し続ける */
export async function openRawMic(onSamples: (samples: Float32Array) => void): Promise<MicCapture> {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    throw new MicError('このブラウザでは拍手検出を使用できません。Windows の Chrome で開いてください。');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // 対応ブラウザのみ有効（未対応なら無視される）
        ...({ voiceIsolation: false } as Record<string, boolean>),
        channelCount: 1,
      },
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    throw new MicError(
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'マイクの使用が許可されませんでした。アドレスバー左のアイコンからマイクを「許可」にしてください。'
        : 'マイクを取得できませんでした。マイクの接続と、他のアプリが使用していないかを確認してください。',
    );
  }

  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = ctx.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(ctx, 'clap-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    const mute = ctx.createGain();
    mute.gain.value = 0; // 処理を継続させるため出力に繋ぐが、音は出さない
    source.connect(tap).connect(mute).connect(ctx.destination);
    let closed = false;
    tap.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      if (!closed) onSamples(ev.data);
    };

    const track = stream.getAudioTracks()[0];
    const st = (track?.getSettings() ?? {}) as MediaTrackSettings & { voiceIsolation?: boolean };
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);
    const c = ctx;
    return {
      sampleRate: c.sampleRate,
      processing: {
        autoGainControl: bool(st.autoGainControl),
        noiseSuppression: bool(st.noiseSuppression),
        echoCancellation: bool(st.echoCancellation),
        voiceIsolation: bool(st.voiceIsolation),
        label: track?.label ?? '',
        sampleRate: c.sampleRate,
      },
      close() {
        if (closed) return;
        closed = true;
        tap.port.onmessage = null;
        for (const t of stream.getTracks()) t.stop();
        void c.close().catch(() => undefined);
      },
    };
  } catch (e) {
    for (const t of stream.getTracks()) t.stop();
    if (ctx) void ctx.close().catch(() => undefined);
    throw e instanceof MicError ? e : new MicError('音声処理（AudioWorklet）を開始できませんでした。');
  }
}
