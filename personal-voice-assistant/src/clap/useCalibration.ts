import { useCallback, useEffect, useRef, useState } from 'react';
import { CALIB_TIMING, CalibrationRun, type CalibSnapshot } from './calibration';
import { subscribeMic, type MicSubscription } from '../audio/micHub';
import { MicError, type MicProcessing } from './micCapture';

/**
 * キャリブレーションの画面側の管理（ブラウザ内のみ。API 呼び出し・送信・保存なし）。
 * 手順の進行は CalibrationRun が音声サンプルの時間で自動的に行う（無音を待たない・やり直しにならない）。
 */
export type CalibUiStep = 'idle' | 'error' | CalibSnapshot['step'];

/** この時間マイクから音声が届かなければエラーにする */
const NO_AUDIO_MS = 2500;

export { CALIB_TIMING };

export function useCalibration() {
  const [snap, setSnap] = useState<CalibSnapshot | null>(null);
  const [uiStep, setUiStep] = useState<CalibUiStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [mic, setMic] = useState<MicProcessing | null>(null);

  const micRef = useRef<MicSubscription | null>(null);
  const runRef = useRef<CalibrationRun | null>(null);
  const timerRef = useRef<number | null>(null);
  const lastAudioRef = useRef(0);

  const stop = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    micRef.current?.close();
    micRef.current = null;
  }, []);

  const start = useCallback(async () => {
    stop();
    runRef.current = null;
    setSnap(null);
    setError(null);
    setUiStep('ambient');
    try {
      const capture = await subscribeMic((samples) => {
        lastAudioRef.current = performance.now();
        runRef.current?.feed(samples);
      });
      micRef.current = capture;
      setMic(capture.processing);
      runRef.current = new CalibrationRun(capture.sampleRate);
      lastAudioRef.current = performance.now();
      // 画面更新（10 回/秒）と、マイクから音が届かない場合の検出
      timerRef.current = window.setInterval(() => {
        const run = runRef.current;
        if (!run) return;
        const s = run.snapshot();
        setSnap(s);
        setUiStep(s.step);
        if (s.step === 'result') stop();
        else if (performance.now() - lastAudioRef.current > NO_AUDIO_MS) {
          stop();
          setError('マイクから音声が届いていません。マイクの接続・選択（Chrome のサイト設定）を確認してください。');
          setUiStep('error');
        }
      }, 100);
    } catch (e) {
      setError(e instanceof MicError ? e.message : 'キャリブレーションを開始できませんでした。');
      setUiStep('error');
    }
  }, [stop]);

  const cancel = useCallback(() => {
    stop();
    runRef.current = null;
    setUiStep('idle');
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  return {
    step: uiStep,
    snap,
    error,
    mic,
    start,
    startNoise: () => runRef.current?.startNoise(),
    skipNoise: () => runRef.current?.skipNoise(),
    cancel,
  };
}
