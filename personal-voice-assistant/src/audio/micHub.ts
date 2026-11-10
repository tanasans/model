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

let lastLevelDb: number | null = null;

function dispatch(samples: Float32Array): void {
  // 画面のレベル表示用（実際に受け取った音声の RMS。音声そのものは保持しない）
  let e = 0;
  for (let i = 0; i < samples.length; i++) e += samples[i]! * samples[i]!;
  lastLevelDb = 10 * Math.log10(e / Math.max(1, samples.length) + 1e-12);
  for (const l of listeners) l(samples);
}

export interface MicHubInfo {
  open: boolean;
  /** 直近に受け取った音声のレベル（dBFS）。マイク未使用なら null */
  levelDb: number | null;
  processing: MicProcessing | null;
  /** マイクは開いているが、ブラウザの制限で音声処理が止まっている（画面のクリックで再開） */
  blocked: boolean;
}

/** 画面表示用：待機用マイクの状態（実測値のみ） */
export function getMicHubInfo(): MicHubInfo {
  return capture
    ? { open: true, levelDb: lastLevelDb, processing: capture.processing, blocked: !capture.isRunning() }
    : { open: false, levelDb: null, processing: null, blocked: false };
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
        lastLevelDb = null;
      }
    },
  };
}

/** 現在マイクを開いているか（テスト・表示用） */
export function micIsOpen(): boolean {
  return capture !== null;
}
