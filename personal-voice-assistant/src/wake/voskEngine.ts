import type { Model } from 'vosk-browser';
import type { RecognizerSpec, VoskFinal } from './wakePolicy';
import { WAKE_SAMPLE_RATE } from './dsp';

/**
 * Vosk（端末内で動く音声認識、Apache-2.0）の読み込みと認識器の管理。
 * - モデルは同じ PC の Web サーバー（/models/…）から読み込む。音声は外部に送信しない
 * - vosk-browser 本体（約 5.8MB）は音声待機を ON にしたときだけ読み込む
 */
export const MODEL_FILE = 'vosk-model-small-ja-0.22.tar.gz';
export const MODEL_URL = `/models/${MODEL_FILE}`;

export type ModelState = 'missing' | 'present';

/** モデルファイルが置かれているか（未設置時は SPA の index.html が返るため、種類で判定） */
export async function checkModel(): Promise<ModelState> {
  try {
    const res = await fetch(MODEL_URL, { method: 'HEAD', cache: 'no-store' });
    const type = res.headers.get('content-type') ?? '';
    const len = Number(res.headers.get('content-length') ?? '0');
    return res.ok && !type.includes('text/html') && (len === 0 || len > 1_000_000) ? 'present' : 'missing';
  } catch {
    return 'missing';
  }
}

let modelPromise: Promise<Model> | null = null;

/** モデルを読み込む（初回は数秒かかる。2 回目以降は読み込み済みのものを使う） */
export function loadModel(): Promise<Model> {
  modelPromise ??= (async () => {
    const { createModel } = await import('vosk-browser');
    return createModel(MODEL_URL, -1); // -1: 警告以上のみ（認識結果はログに出さない）
  })().catch((e) => {
    modelPromise = null;
    throw e;
  });
  return modelPromise;
}

/** メモリ解放（音声待機 OFF・タブを閉じるとき） */
export function unloadModel(): void {
  const p = modelPromise;
  modelPromise = null;
  void p?.then((m) => m.terminate()).catch(() => undefined);
}

type Recognizer = InstanceType<Model['KaldiRecognizer']>;

/**
 * モードに応じた認識器（1〜2 個）に同じ音声を流す。
 * 認識（別スレッド）が音声の到着に追いつけているかを測るため、送った音声と処理が終わった音声の長さを数える
 * （vosk-browser は音声のかたまりを 1 つ処理するごとに result か partialresult を返す）。
 */
export class WakeRecognizers {
  private readonly recs: Array<{ spec: RecognizerSpec; rec: Recognizer; pending: number[]; pendingSamples: number; doneSamples: number }>;
  private disposed = false;

  constructor(model: Model, specs: RecognizerSpec[], onFinal: (spec: RecognizerSpec, final: VoskFinal) => void) {
    this.recs = specs.map((spec) => {
      const rec = new model.KaldiRecognizer(WAKE_SAMPLE_RATE, JSON.stringify(spec.grammar));
      rec.setWords(true);
      const entry = { spec, rec, pending: [] as number[], pendingSamples: 0, doneSamples: 0 };
      const processed = () => {
        const n = entry.pending.shift();
        if (n !== undefined) {
          entry.pendingSamples -= n;
          entry.doneSamples += n;
        }
      };
      // 確定結果のみを使う（途中結果は誤起動が多いため使わない）
      rec.on('result', (msg) => {
        if (this.disposed || msg.event !== 'result') return;
        processed();
        const r = msg.result;
        if (r.text) onFinal(spec, { text: r.text, result: r.result });
      });
      rec.on('partialresult', () => {
        if (!this.disposed) processed();
      });
      return entry;
    });
  }

  /** 処理が終わった音声の長さ（秒）。複数の認識器のうち遅い方（処理速度の計算用） */
  processedSec(): number {
    return Math.min(...this.recs.map((r) => r.doneSamples / WAKE_SAMPLE_RATE));
  }

  /** 認識の遅れ（まだ処理されていない音声の長さ、秒）。複数の認識器のうち大きい方 */
  backlogSec(): number {
    return Math.max(0, ...this.recs.map((r) => r.pendingSamples / WAKE_SAMPLE_RATE));
  }

  accept(samples16k: Float32Array): void {
    if (this.disposed || samples16k.length === 0) return;
    for (const r of this.recs) {
      r.pending.push(samples16k.length);
      r.pendingSamples += samples16k.length;
      r.rec.acceptWaveformFloat(samples16k, WAKE_SAMPLE_RATE);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { rec } of this.recs) {
      try {
        rec.remove();
      } catch {
        /* 既に解放済み */
      }
    }
  }
}
