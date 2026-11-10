import { useEffect, useRef, useState } from 'react';
import { subscribeMic, type MicSubscription } from '../audio/micHub';
import { MicError } from '../clap/micCapture';
import { WakePreprocessor } from './dsp';
import { LevelTracker } from './levelTracker';
import { AudioGate } from './audioGate';
import { checkModel, loadModel, unloadModel, WakeRecognizers } from './voskEngine';
import {
  decoyVeto,
  DECOY_VETO_MAX_SENSITIVITY,
  DECOY_WORDS,
  evaluateFinal,
  recognizersFor,
  WAKE_WORD,
  type VoskWord,
  type WakeDecision,
  type WakePhraseMode,
} from './wakePolicy';

/**
 * 音声待機（「カイト」「ねえ、カイト」）。
 * 音声認識はこの PC のブラウザ内（Vosk）で行い、待機中は OpenAI API を一切呼ばない。
 * 聞き取った内容は画面に一時表示するだけで、保存・送信しない。
 */
export type WakeStatus = 'off' | 'checking' | 'not-installed' | 'loading' | 'listening' | 'paused' | 'error';

export interface WakeStandbyOptions {
  enabled: boolean;
  /** 会話中・起動処理中などは止める（マイクも解放する） */
  paused: boolean;
  mode: WakePhraseMode;
  sensitivity: number;
  noiseReduction: boolean;
  onWake: (d: WakeDecision) => void;
}

export type WakeLogEntry =
  | { id: number; at: number; kind: 'decision'; decision: WakeDecision }
  | { id: number; at: number; kind: 'heard'; text: string }
  | { id: number; at: number; kind: 'note'; text: string };

type NewEntry =
  | { kind: 'decision'; decision: WakeDecision }
  | { kind: 'heard'; text: string }
  | { kind: 'note'; text: string };

/** 起動後（または 2 つの認識器が同じ呼びかけを拾ったとき）に重ねて起動しない時間 */
const COOLDOWN_MS = 2500;
const LOG_MAX = 30;
/**
 * 認識の遅れ（まだ処理されていない音声の長さ）の上限。
 * PC の処理が追いつかず遅れがたまると、呼びかけから何十秒も後に認識されることがある（実機で確認）。
 *  - STALE_SEC を超えて遅れた認識結果では起動しない（話してからだいぶ後に勝手に起動しないため）
 *  - RESTART_SEC を超えたら、たまった音声を捨てて認識をやり直す
 */
export const STALE_SEC = 2.5;
export const RESTART_SEC = 4;
/** この時間内にやり直しがこの回数を超えたら、やり直しを繰り返さずに止めて理由を表示する */
const RESTART_WINDOW_MS = 5 * 60_000;
const RESTART_MAX = 3;

export function useWakeStandby(opts: WakeStandbyOptions) {
  const { enabled, paused, mode, noiseReduction } = opts;
  const [status, setStatus] = useState<WakeStatus>('off');
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<WakeLogEntry[]>([]);
  const [level, setLevel] = useState<{ levelDb: number; floorDb: number; backlogSec: number; speed: number | null; gatedPct: number } | null>(null);
  const restartTimesRef = useRef<number[]>([]);
  /** 認識のやり直し（値が変わると認識器を作り直す） */
  const [restartKey, setRestartKey] = useState(0);
  const [restarts, setRestarts] = useState(0);
  const onWakeRef = useRef(opts.onWake);
  onWakeRef.current = opts.onWake;
  const sensRef = useRef(opts.sensitivity);
  sensRef.current = opts.sensitivity;
  const idRef = useRef(0);
  const lastWakeRef = useRef(0);

  const active = enabled && !paused;

  useEffect(() => {
    if (!active) {
      setStatus(enabled ? 'paused' : 'off');
      setLevel(null);
      return;
    }
    let cancelled = false;
    let mic: MicSubscription | null = null;
    let recs: WakeRecognizers | null = null;
    let timer: number | null = null;
    const push = (e: NewEntry) => setLog((l) => [{ ...e, id: ++idRef.current, at: Date.now() } as WakeLogEntry, ...l].slice(0, LOG_MAX));
    setError(null);

    (async () => {
      setStatus('checking');
      if ((await checkModel()) === 'missing') {
        if (!cancelled) setStatus('not-installed');
        return;
      }
      if (cancelled) return;
      setStatus('loading');
      const model = await loadModel();
      if (cancelled) return;
      const tracker = new LevelTracker();
      const specs = recognizersFor(mode);
      // 「両方」モードの厳しめ設定用：似た言葉の認識結果を少しの間覚えておく
      let decoys: VoskWord[] = [];
      const fire = (d: WakeDecision) => {
        const now = Date.now();
        if (now - lastWakeRef.current < COOLDOWN_MS) return; // 同じ呼びかけの重複
        push({ kind: 'decision', decision: d });
        lastWakeRef.current = now;
        onWakeRef.current(d);
      };
      // 静かな間は認識に音声を送らない（PC の負担を減らす）。単語の時刻は待機開始からの時間に直して使う
      const gate = new AudioGate();
      recs = new WakeRecognizers(model, specs, (spec, rawFinal) => {
        if (cancelled) return;
        const final = { ...rawFinal, result: rawFinal.result?.map((w) => ({ ...w, start: gate.toStreamSec(w.start), end: gate.toStreamSec(w.end) })) };
        // 計測：認識確定の時刻と、認識器の時間軸から求めた「言葉の終わり」の時刻
        const recognizedAt = performance.now();
        const lastEnd = Math.max(0, ...(final.result ?? []).map((w) => w.end));
        const timing = { recognizedAt, speechEndAt: recognizedAt - Math.max(0, tracker.timeSec - lastEnd) * 1000 };
        if (spec.id === 'nee') {
          const found = (final.result ?? []).filter((w) => DECOY_WORDS.includes(w.word));
          if (found.length) decoys = [...decoys, ...found].filter((w) => w.end > tracker.timeSec - 10);
        }
        const ev = evaluateFinal(final, spec, tracker, sensRef.current);
        const d = ev ? { ...ev, timing } : null;
        // 認識が大きく遅れている（話してからだいぶ時間が経っている）結果では起動しない
        const lag = recs?.backlogSec() ?? 0;
        if (d?.accepted && lag > STALE_SEC) {
          push({ kind: 'note', text: `認識が ${lag.toFixed(1)} 秒遅れていたため、起動しませんでした（古い呼びかけの可能性）` });
          return;
        }
        if (!d) {
          // 呼びかけの言葉を含まない確定結果（似た言葉など）だけを表示する。
          // （「両方」モードでは 2 つの認識器が担当外の言い方を受け取るが、それは表示しない）
          const words = final.text.split(' ').filter((w) => w !== '[unk]');
          if (words.length && !words.includes(WAKE_WORD)) {
            push({ kind: 'heard', text: `「${words.join(' ')}」と聞こえました（呼びかけではないため無視）` });
          }
          return;
        }
        if (!d.accepted) {
          push({ kind: 'decision', decision: d });
          return;
        }
        if (mode === 'both' && spec.id === 'lone' && sensRef.current <= DECOY_VETO_MAX_SENSITIVITY) {
          // もう一方の認識器の結果がそろうのを少し待ってから確認する
          window.setTimeout(() => {
            if (cancelled) return;
            const word = decoyVeto(d, decoys);
            if (word) {
              push({
                kind: 'decision',
                decision: { ...d, accepted: false, reason: `似た言葉（${word}）の可能性が高い（厳しめの設定）` },
              });
            } else fire(d);
          }, 600);
          return;
        }
        fire(d);
      });
      let pp: WakePreprocessor | null = null;
      mic = await subscribeMic((samples) => {
        if (!pp || !recs) return;
        const x = pp.process(samples);
        tracker.push(x);
        for (const c of gate.push(x, tracker.floorDb())) recs.accept(c);
      });
      if (cancelled) {
        mic.close();
        return;
      }
      pp = new WakePreprocessor(mic.sampleRate, { noiseReduction });
      let over = 0;
      // 処理速度（処理できた音声の秒 ÷ 経過秒、直近 5 秒）。1 倍未満が続くと遅れがたまる
      const hist: Array<[number, number]> = [];
      timer = window.setInterval(() => {
        const backlogSec = recs?.backlogSec() ?? 0;
        const now = performance.now();
        hist.push([now, recs?.processedSec() ?? 0]);
        while (hist.length && now - hist[0]![0] > 5000) hist.shift();
        const [t0, p0] = hist[0]!;
        // 遅れがあるときだけ処理速度を出す（遅れがなければ、送った分はすべて処理できている）
        const speed = backlogSec > 0.5 && now - t0 > 2000 ? ((recs?.processedSec() ?? 0) - p0) / ((now - t0) / 1000) : null;
        const gatedPct = tracker.timeSec > 0 ? Math.round((gate.skippedSamples / 16000 / tracker.timeSec) * 100) : 0;
        setLevel({ levelDb: tracker.lastDb, floorDb: tracker.floorDb(), backlogSec, speed, gatedPct });
        // 遅れが続けてたまったら、認識をやり直す（音声認識の処理を止めて読み込み直す＝たまった音声を捨てる）
        over = backlogSec > RESTART_SEC ? over + 1 : 0;
        if (over >= 10 && !cancelled) {
          const t = Date.now();
          restartTimesRef.current = [...restartTimesRef.current.filter((x) => t - x < RESTART_WINDOW_MS), t];
          cancelled = true;
          recs?.dispose();
          recs = null;
          unloadModel();
          if (restartTimesRef.current.length > RESTART_MAX) {
            // やり直しても追いつかない：繰り返さずに止めて理由を出す
            restartTimesRef.current = [];
            const sp = speed !== null ? `（処理速度 ${speed.toFixed(2)} 倍）` : '';
            setError(
              `この PC では音声認識の処理が追いつかないため、音声待機を止めました${sp}。「呼びかけの言葉」を 1 つ（「ねえ、カイト」のみ等）にする、ほかのアプリやタブを閉じる、Chrome の省エネモードを OFF にする、のいずれかを試してから、音声待機を ON にし直してください。`,
            );
            setStatus('error');
            if (timer !== null) window.clearInterval(timer);
            mic?.close();
            return;
          }
          push({ kind: 'note', text: `音声認識が ${backlogSec.toFixed(1)} 秒遅れたため、認識をやり直しました（PC の処理が追いついていません${speed !== null ? `・処理速度 ${speed.toFixed(2)} 倍` : ''}）` });
          setRestarts((n) => n + 1);
          setRestartKey((k) => k + 1);
        }
      }, 100);
      setStatus('listening');
    })().catch((e: unknown) => {
      if (cancelled) return;
      setError(
        e instanceof MicError
          ? e.message
          : '音声認識モデルを読み込めませんでした。npm run setup:wake を実行してから、ページを再読み込みしてください。',
      );
      setStatus('error');
    });

    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
      recs?.dispose();
      mic?.close();
    };
  }, [active, enabled, mode, noiseReduction, restartKey]);

  // 音声待機 OFF・タブを閉じるときは、認識モデルのメモリも解放する
  useEffect(() => {
    if (!enabled) unloadModel();
  }, [enabled]);
  useEffect(() => {
    const onPageHide = () => unloadModel();
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  return { status, error, log, level, restarts, clearLog: () => setLog([]) };
}
