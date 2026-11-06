import { useCallback, useEffect, useRef, useState } from 'react';
import { ClapDetector, type TransientInfo } from './clapDetector';
import { PERMISSIVE_PROFILE, computeCalibration, frameLevelsDb, type CalibrationResult } from './calibration';
import { MicError, openRawMic, type MicCapture } from './micCapture';

/**
 * キャリブレーションの進行管理（ブラウザ内のみ。API 呼び出し・送信・保存なし）
 *   ambient（3 秒）→ claps（最大 15 秒、5 回で次へ）→ noise-ready → noise（任意 6 秒）→ result
 */
export type CalibStep = 'idle' | 'ambient' | 'claps' | 'noise-ready' | 'noise' | 'result' | 'error';

export const AMBIENT_SEC = 3;
export const CLAPS_TARGET = 5;
export const CLAPS_MAX_SEC = 15;
export const NOISE_SEC = 6;

export function useCalibration() {
  const [step, setStep] = useState<CalibStep>('idle');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [clapCount, setClapCount] = useState(0);
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [levelDb, setLevelDb] = useState(-100);

  const micRef = useRef<MicCapture | null>(null);
  const timersRef = useRef<number[]>([]);
  const dataRef = useRef({ ambient: [] as number[], claps: [] as TransientInfo[], noises: [] as TransientInfo[] });
  const stepRef = useRef<CalibStep>('idle');
  const detectorRef = useRef<ClapDetector | null>(null);

  const clearTimers = () => {
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current = [];
  };
  const stopMic = () => {
    micRef.current?.close();
    micRef.current = null;
    detectorRef.current = null;
  };

  const go = useCallback((s: CalibStep) => {
    stepRef.current = s;
    setStep(s);
  }, []);

  const countdown = (sec: number, onDone: () => void) => {
    clearTimers();
    setSecondsLeft(sec);
    for (let i = 1; i <= sec; i++) {
      timersRef.current.push(window.setTimeout(() => setSecondsLeft(sec - i), i * 1000));
    }
    timersRef.current.push(window.setTimeout(onDone, sec * 1000));
  };

  const finish = useCallback(
    (withNoise: boolean) => {
      clearTimers();
      stopMic();
      const d = dataRef.current;
      setResult(computeCalibration({ ambientLevels: d.ambient, claps: d.claps, noises: withNoise ? d.noises : [] }));
      go('result');
    },
    [go],
  );

  const startNoise = useCallback(() => {
    if (!micRef.current) return;
    dataRef.current.noises = [];
    go('noise');
    countdown(NOISE_SEC, () => finish(true));
  }, [finish, go]);

  const start = useCallback(async () => {
    clearTimers();
    stopMic();
    dataRef.current = { ambient: [], claps: [], noises: [] };
    setClapCount(0);
    setResult(null);
    setError(null);
    try {
      const mic = await openRawMic((samples) => {
        const s = stepRef.current;
        if (s === 'ambient') {
          dataRef.current.ambient.push(...frameLevelsDb(samples, mic.sampleRate));
        }
        const det = detectorRef.current;
        if (!det) return;
        for (const e of det.process(samples)) {
          if (e.type !== 'transient') continue;
          if (stepRef.current === 'claps') {
            dataRef.current.claps.push(e.info);
            const n = dataRef.current.claps.length;
            setClapCount(n);
            if (n === CLAPS_TARGET) {
              clearTimers();
              // 最後の拍手の余韻が収まってから次へ
              timersRef.current.push(window.setTimeout(() => go('noise-ready'), 600));
            }
          } else if (stepRef.current === 'noise') {
            dataRef.current.noises.push(e.info);
          }
        }
        setLevelDb(det.levelDb);
      });
      micRef.current = mic;
      // 特徴を集める検出器（並びの判定はしない）
      detectorRef.current = new ClapDetector({
        sampleRate: mic.sampleRate,
        sensitivity: 5,
        maxIntervalMs: 600,
        profile: PERMISSIVE_PROFILE,
        featuresOnly: true,
      });
      go('ambient');
      countdown(AMBIENT_SEC, () => {
        go('claps');
        countdown(CLAPS_MAX_SEC, () => go('noise-ready'));
      });
    } catch (e) {
      setError(e instanceof MicError ? e.message : 'キャリブレーションを開始できませんでした。');
      go('error');
    }
  }, [go]);

  const cancel = useCallback(() => {
    clearTimers();
    stopMic();
    go('idle');
  }, [go]);

  useEffect(() => () => {
    clearTimers();
    stopMic();
  }, []);

  return {
    step,
    secondsLeft,
    clapCount,
    result,
    error,
    levelDb,
    start,
    startNoise,
    skipNoise: () => finish(false),
    cancel,
    reset: () => go('idle'),
  };
}
