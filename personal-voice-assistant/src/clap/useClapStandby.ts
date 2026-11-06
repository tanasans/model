import { useEffect, useRef, useState } from 'react';
import { ClapDetector, type TransientInfo } from './clapDetector';

/**
 * 拍手待機。マイク音声はブラウザ内の AudioWorklet で取り出し、ClapDetector で判定するだけで、
 * どこにも送信・保存しない。待機中は OpenAI API を一切呼ばない。
 */

export type StandbyStatus = 'off' | 'starting' | 'listening' | 'first-clap' | 'paused' | 'error';

export interface ClapStandbyOptions {
  /** 待機スイッチ ON/OFF */
  enabled: boolean;
  /** 音声通話中など、一時的に止める（マイクも解放する） */
  paused: boolean;
  sensitivity: number;
  maxIntervalMs: number;
  onDoubleClap: () => void;
}

export interface Meter {
  levelDb: number;
  triggerDb: number;
}

// AudioWorklet：128 サンプルずつ届く入力を 2048 サンプルにまとめてメインスレッドへ渡すだけ
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

interface Running {
  stream: MediaStream;
  ctx: AudioContext;
  detector: ClapDetector;
  meterTimer: number;
}

export function useClapStandby(opts: ClapStandbyOptions) {
  const { enabled, paused, sensitivity, maxIntervalMs } = opts;
  const [status, setStatus] = useState<StandbyStatus>('off');
  const [error, setError] = useState<string | null>(null);
  const [meter, setMeter] = useState<Meter | null>(null);
  const [lastSound, setLastSound] = useState<TransientInfo | null>(null);
  const [lastNote, setLastNote] = useState<string | null>(null);
  const runningRef = useRef<Running | null>(null);
  const onDoubleRef = useRef(opts.onDoubleClap);
  onDoubleRef.current = opts.onDoubleClap;
  const settingsRef = useRef({ sensitivity, maxIntervalMs });
  settingsRef.current = { sensitivity, maxIntervalMs };

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

    (async () => {
      let stream: MediaStream | null = null;
      let ctx: AudioContext | null = null;
      try {
        if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
          throw new Error('このブラウザでは拍手待機を使用できません。Windows の Chrome で開いてください。');
        }
        try {
          // 拍手の鋭い音を消さないよう、ブラウザの音声加工はすべてオフにする
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          });
        } catch (e) {
          const name = e instanceof DOMException ? e.name : '';
          throw new Error(
            name === 'NotAllowedError' || name === 'SecurityError'
              ? 'マイクの使用が許可されませんでした。アドレスバー左のアイコンからマイクを「許可」にしてください。'
              : 'マイクを取得できませんでした。マイクの接続と、他のアプリが使用していないかを確認してください。',
          );
        }
        if (cancelled) return stopStream(stream);

        ctx = new AudioContext();
        if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
        try {
          await ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        if (cancelled) {
          stopStream(stream);
          void ctx.close();
          return;
        }

        const detector = new ClapDetector({ sampleRate: ctx.sampleRate, ...settingsRef.current });
        const source = ctx.createMediaStreamSource(stream);
        const tap = new AudioWorkletNode(ctx, 'clap-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        const mute = ctx.createGain();
        mute.gain.value = 0; // 処理を継続させるため出力に繋ぐが、音は出さない
        source.connect(tap).connect(mute).connect(ctx.destination);

        tap.port.onmessage = (ev: MessageEvent<Float32Array>) => {
          if (runningRef.current?.detector !== detector) return;
          for (const e of detector.process(ev.data)) {
            if (e.type === 'transient') setLastSound(e.info);
            else if (e.type === 'first-clap') {
              setStatus('first-clap');
              setLastNote('1回目の拍手を検知。もう1回叩いてください。');
            } else if (e.type === 'sequence-cancelled') {
              setStatus('listening');
              setLastNote(`取り消し：${e.reason}`);
            } else if (e.type === 'double-clap') {
              setLastNote('拍手2回を検知しました。会話を開始します。');
              onDoubleRef.current();
            }
          }
        };

        const meterTimer = window.setInterval(() => {
          setMeter({ levelDb: detector.levelDb, triggerDb: detector.triggerLevelDb });
        }, 100);
        runningRef.current = { stream, ctx, detector, meterTimer };
        setStatus('listening');
      } catch (e) {
        if (stream) stopStream(stream);
        if (ctx) void ctx.close().catch(() => undefined);
        if (cancelled) return;
        setError(e instanceof Error ? e.message : '拍手待機を開始できませんでした。');
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      release(runningRef);
    };
  }, [active, enabled]);

  // 感度・間隔の変更は再起動せずに反映
  useEffect(() => {
    runningRef.current?.detector.setOptions({ sensitivity, maxIntervalMs });
  }, [sensitivity, maxIntervalMs]);

  // タブを閉じる・移動するときはマイクを解放
  useEffect(() => {
    const onPageHide = () => release(runningRef);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      release(runningRef);
    };
  }, []);

  return { status, error, meter, lastSound, lastNote };
}

function release(ref: { current: Running | null }): void {
  const r = ref.current;
  ref.current = null;
  if (!r) return;
  window.clearInterval(r.meterTimer);
  stopStream(r.stream);
  void r.ctx.close().catch(() => undefined);
}

function stopStream(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}
