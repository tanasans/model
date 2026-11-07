import { openRawMic, type MicCapture, type MicProcessing } from '../clap/micCapture';

/**
 * マイクの共有（拍手待機・音声待機・キャリブレーションで 1 本のマイク入力を共有する）。
 * - 同じマイクを別々の設定で二重に開くと、ブラウザの音声加工設定が食い違うおそれがあるため 1 本にまとめる
 * - 最初の利用者が来たら開き、最後の利用者が離れたら閉じる（マイクの解放を確実にする）
 * 音声はブラウザ内で各機能に渡すだけで、送信・保存はしない。
 */
type Listener = (samples: Float32Array) => void;

export interface MicSubscription {
  sampleRate: number;
  processing: MicProcessing;
  close(): void;
}

let capture: MicCapture | null = null;
let opening: Promise<MicCapture> | null = null;
const listeners = new Set<Listener>();

function dispatch(samples: Float32Array): void {
  for (const l of listeners) l(samples);
}

export async function subscribeMic(onSamples: Listener): Promise<MicSubscription> {
  listeners.add(onSamples);
  try {
    if (!capture) {
      opening ??= openRawMic(dispatch).finally(() => {
        opening = null;
      });
      const c = await opening;
      // 開いている間に全員が離れていたら閉じる
      if (listeners.size === 0) {
        c.close();
        throw new Error('cancelled');
      }
      capture ??= c;
    }
  } catch (e) {
    listeners.delete(onSamples);
    throw e;
  }
  const c = capture!;
  let closed = false;
  return {
    sampleRate: c.sampleRate,
    processing: c.processing,
    close() {
      if (closed) return;
      closed = true;
      listeners.delete(onSamples);
      if (listeners.size === 0 && capture) {
        capture.close();
        capture = null;
      }
    },
  };
}

/** 現在マイクを開いているか（テスト・表示用） */
export function micIsOpen(): boolean {
  return capture !== null;
}
