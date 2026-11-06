import { useEffect, useRef, useState } from 'react';
import { ClapDetector, type ClapProfile, type TransientInfo } from './clapDetector';
import { MicError, openRawMic, type MicCapture, type MicProcessing } from './micCapture';

/**
 * 拍手待機。マイク音声はブラウザ内で判定するだけで、どこにも送信・保存しない。
 * 待機中は OpenAI API を一切呼ばない（料金は発生しない）。
 */

export type StandbyStatus = 'off' | 'starting' | 'listening' | 'first-clap' | 'paused' | 'error';

export interface ClapStandbyOptions {
  enabled: boolean;
  /** 音声通話中・キャリブレーション中など、一時的に止める（マイクも解放する） */
  paused: boolean;
  sensitivity: number;
  maxIntervalMs: number;
  profile: ClapProfile;
  onDoubleClap: (intervalMs: number) => void;
}

export interface Meter {
  levelDb: number;
  triggerDb: number;
  floorDb: number;
}

export type LogEntry =
  | { id: number; at: number; kind: 'sound'; info: TransientInfo }
  | { id: number; at: number; kind: 'note'; tone: 'ok' | 'warn' | 'info'; text: string };

type NewLogEntry =
  | { kind: 'sound'; info: TransientInfo }
  | { kind: 'note'; tone: 'ok' | 'warn' | 'info'; text: string };

const LOG_MAX = 8;

export function useClapStandby(opts: ClapStandbyOptions) {
  const { enabled, paused, sensitivity, maxIntervalMs, profile } = opts;
  const [status, setStatus] = useState<StandbyStatus>('off');
  const [error, setError] = useState<string | null>(null);
  const [meter, setMeter] = useState<Meter | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [processing, setProcessing] = useState<MicProcessing | null>(null);
  const micRef = useRef<{ mic: MicCapture; detector: ClapDetector; timer: number } | null>(null);
  const onDoubleRef = useRef(opts.onDoubleClap);
  onDoubleRef.current = opts.onDoubleClap;
  const settingsRef = useRef({ sensitivity, maxIntervalMs, profile });
  settingsRef.current = { sensitivity, maxIntervalMs, profile };
  const idRef = useRef(0);

  const active = enabled && !paused;

  useEffect(() => {
    if (!active) {
      setStatus(enabled ? 'paused' : 'off');
      setMeter(null);
      return;
    }
    let cancelled = false;
    setStatus('starting');
    setError(null);
    const push = (e: NewLogEntry) =>
      setLog((l) => [{ ...e, id: ++idRef.current, at: Date.now() }, ...l].slice(0, LOG_MAX));

    let detector: ClapDetector | null = null;
    openRawMic((samples) => {
      if (!detector) return;
      for (const e of detector.process(samples)) {
        if (e.type === 'transient') push({ kind: 'sound', info: e.info });
        else if (e.type === 'activity') push({ kind: 'note', tone: 'info', text: '話し声などの続く音を検知（拍手の判定は一時停止）' });
        else if (e.type === 'first-clap') {
          setStatus('first-clap');
          push({ kind: 'note', tone: 'info', text: '1回目の拍手を検知。もう1回叩いてください。' });
        } else if (e.type === 'sequence-cancelled') {
          setStatus('listening');
          push({ kind: 'note', tone: 'warn', text: `取り消し：${e.reason}` });
        } else if (e.type === 'double-clap') {
          setStatus('listening');
          push({ kind: 'note', tone: 'ok', text: `拍手2回を検知しました（間隔 ${(e.intervalMs / 1000).toFixed(2)} 秒）` });
          onDoubleRef.current(e.intervalMs);
        }
      }
    })
      .then((mic) => {
        if (cancelled) return mic.close();
        detector = new ClapDetector({ sampleRate: mic.sampleRate, ...settingsRef.current });
        const d = detector;
        const timer = window.setInterval(() => {
          setMeter({ levelDb: d.levelDb, triggerDb: d.triggerLevelDb, floorDb: d.noiseFloorDb });
        }, 80);
        micRef.current = { mic, detector: d, timer };
        setProcessing(mic.processing);
        setStatus('listening');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof MicError ? e.message : '拍手待機を開始できませんでした。');
        setStatus('error');
      });

    return () => {
      cancelled = true;
      release(micRef);
    };
  }, [active, enabled]);

  // 感度・間隔・基準の変更は再起動せずに反映
  useEffect(() => {
    micRef.current?.detector.setOptions({ sensitivity, maxIntervalMs, profile });
  }, [sensitivity, maxIntervalMs, profile]);

  // タブを閉じる・移動するときはマイクを解放
  useEffect(() => {
    const onPageHide = () => release(micRef);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      release(micRef);
    };
  }, []);

  return { status, error, meter, log, processing, clearLog: () => setLog([]) };
}

function release(ref: { current: { mic: MicCapture; timer: number } | null }): void {
  const r = ref.current;
  ref.current = null;
  if (!r) return;
  window.clearInterval(r.timer);
  r.mic.close();
}
