import { useCallback, useEffect, useRef, useState } from 'react';
import {
  OpenAIRealtimeWebRTC,
  RealtimeAgent,
  RealtimeSession,
  setSensitiveDataLoggingEnabled,
  type RealtimeItem,
} from '@openai/agents/realtime';

/** RealtimeAgent に渡せるツールの型（SDK が公開している型から導出） */
type RealtimeTool = NonNullable<ConstructorParameters<typeof RealtimeAgent>[0]['tools']>[number];
import {
  ASSISTANT_INSTRUCTIONS,
  ASSISTANT_NAME,
  TRANSCRIPTION_MODEL,
  type ApiErrorBody,
  type SessionGrant,
} from '../shared/assistant';
import type { AudioProfileId, SpeechSpeed } from '../shared/conversationAudio';
import { createEndAfterReply, type EndAfterReply } from './endAfterReply';

// SDK のデバッグログに会話内容を出さない
setSensitiveDataLoggingEnabled(false);

export type Phase = 'idle' | 'requesting-mic' | 'fetching-token' | 'connecting' | 'connected' | 'stopping';

export interface TranscriptLine {
  id: string;
  role: 'user' | 'assistant';
  /** 実際に API から得た文字起こし。無い場合は null（架空の文字列は入れない） */
  text: string | null;
  /** text が null の場合の状態 */
  pending: boolean;
}

interface Active {
  session: RealtimeSession;
  stream: MediaStream;
  /** 画面表示用の入力レベル計測（会話用マイクの実測値） */
  meter: InputMeter | null;
  audio: HTMLAudioElement;
  leaseId: string;
  maxTimer: number;
  tickTimer: number;
  /** 拍手起動時：発話が無いまま一定時間経ったら切断するタイマー */
  noSpeechTimer: number | null;
  /** 声で「終わって」と言われたとき、別れの一言を再生し終えてから切断する */
  ender: EndAfterReply;
}

export interface StartOptions {
  /** 'clap' の場合、発話が無ければ自動で切断する（誤起動時の課金を抑える） */
  trigger?: 'manual' | 'clap' | 'wake';
  /** 使う声（未指定ならサーバーの既定）。次の新しい会話から適用される */
  voice?: string | null;
  /** テレビ音声対策プリセット（未指定ならサーバーの既定＝従来どおり）。次の新しい会話から適用 */
  audioProfile?: AudioProfileId | null;
  /** 話す速さ（未指定なら従来どおり） */
  speechSpeed?: SpeechSpeed | null;
}

/** 拍手で起動したのに話しかけられなかった場合、この秒数で自動終了する */
export const CLAP_NO_SPEECH_TIMEOUT_SEC = 15;

export interface VoiceSessionOptions {
  /** 会話で使う Function Calling のツール（天気など）。毎回の会話開始時に取得する */
  getTools?: () => RealtimeTool[];
  /**
   * 会話の記録（長期記憶の会話履歴）。会話の開始・Realtime のサーバーイベント・終了を受け取る。
   * 文字起こしの確定・失敗の判断は受け取った側（ConversationLogger）で行う
   */
  observer?: {
    onStart: (trigger: 'manual' | 'clap' | 'wake', startedAt: number) => void;
    onEvent: (ev: { type?: string; [k: string]: unknown }) => void;
    onEnd: () => void;
  };
}

export function useVoiceSession(opts: VoiceSessionOptions = {}) {
  const getToolsRef = useRef(opts.getTools);
  getToolsRef.current = opts.getTools;
  const observerRef = useRef(opts.observer);
  observerRef.current = opts.observer;
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const activeRef = useRef<Active | null>(null);
  const startingRef = useRef(false);
  /** 開始処理の途中で終了が押されたことを検出するための世代番号 */
  const genRef = useRef(0);

  /** マイク・音声・WebRTC・サーバー側リースを確実に閉じる（何度呼んでも安全） */
  const teardown = useCallback(async (opts: { reason?: string; error?: string } = {}) => {
    genRef.current += 1;
    const a = activeRef.current;
    activeRef.current = null;
    if (opts.error) setError(opts.error);
    if (opts.reason) setNotice(opts.reason);
    if (!a) return;
    setPhase('stopping');
    window.clearTimeout(a.maxTimer);
    if (a.noSpeechTimer !== null) window.clearTimeout(a.noSpeechTimer);
    window.clearInterval(a.tickTimer);
    a.ender.dispose();
    try {
      a.session.close();
    } catch {
      /* 既に閉じている */
    }
    a.meter?.close();
    stopStream(a.stream);
    a.audio.pause();
    a.audio.srcObject = null;
    try {
      observerRef.current?.onEnd();
    } catch {
      /* 記録の失敗で会話の終了処理を止めない */
    }
    await notifyEnd(a.leaseId);
    setRemaining(null);
    setPhase('idle');
  }, []);

  const start = useCallback(async (options: StartOptions = {}) => {
    if (startingRef.current || activeRef.current) return;
    startingRef.current = true;
    const gen = ++genRef.current;
    const cancelled = () => gen !== genRef.current;
    setError(null);
    setNotice(null);
    setLines([]);

    let stream: MediaStream | null = null;
    let grant: SessionGrant | null = null;
    try {
      // 1) マイク許可（許可された場合のみ先へ進む。トークン発行＝課金に関わる処理はこの後）
      setPhase('requesting-mic');
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new UserFacingError('このブラウザではマイクを使用できません。Windows の Chrome で http://localhost から開いてください。');
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (e) {
        throw new UserFacingError(micErrorMessage(e));
      }
      if (cancelled()) throw new CancelledError();

      // 2) サーバーから短命 client secret を取得
      setPhase('fetching-token');
      grant = await fetchGrant({
        ...(options.voice ? { voice: options.voice } : {}),
        ...(options.audioProfile ? { audioProfile: options.audioProfile } : {}),
        ...(options.speechSpeed ? { speechSpeed: options.speechSpeed } : {}),
      });
      if (cancelled()) throw new CancelledError();

      // 3) WebRTC で Realtime API に接続
      setPhase('connecting');
      const audio = new Audio();
      audio.autoplay = true;
      const transport = new OpenAIRealtimeWebRTC({ mediaStream: stream, audioElement: audio });
      const agent = new RealtimeAgent({
        name: ASSISTANT_NAME,
        // サーバーが KAITO.md と個人設定から組み立てた指示文（client secret と同じ）
        instructions: grant.instructions || ASSISTANT_INSTRUCTIONS,
        voice: grant.voice,
        tools: getToolsRef.current?.() ?? [],
      });
      const session = new RealtimeSession(agent, {
        transport,
        model: grant.model,
        tracingDisabled: true, // 会話内容をトレースとして送信しない
        historyStoreAudio: false,
        config: {
          outputModalities: ['audio'],
          ...(grant.reasoningEffort ? { reasoning: { effort: grant.reasoningEffort } } : {}),
          audio: {
            input: {
              transcription: { model: grant.transcriptionModel || TRANSCRIPTION_MODEL, language: 'ja' },
              ...(grant.inputNoiseReduction ? { noiseReduction: { type: grant.inputNoiseReduction } } : {}),
              // サーバーが client secret に設定したものと同じ値を使う（接続時に上書きされないように）
              turnDetection: {
                ...grant.turnDetection,
                ...(grant.interruptResponse === null || grant.interruptResponse === undefined ? {} : { interruptResponse: grant.interruptResponse }),
              },
            },
            // speed はサーバーが client secret に設定したものと同じ値（既定 1＝従来どおり）
            output: { voice: grant.voice, speed: grant.speechSpeed ?? 1 },
          },
        },
      });

      const leaseId = grant.leaseId;
      const maxMs = grant.maxSessionSeconds * 1000;
      const startedAt = Date.now();
      const active: Active = {
        session,
        stream,
        audio,
        leaseId,
        maxTimer: window.setTimeout(() => {
          void teardown({ reason: `最大継続時間（${grant!.maxSessionSeconds}秒）に達したため、自動で会話を終了しました。` });
        }, maxMs),
        tickTimer: window.setInterval(() => {
          setRemaining(Math.max(0, Math.ceil((maxMs - (Date.now() - startedAt)) / 1000)));
        }, 1000),
        noSpeechTimer: null,
        meter: createInputMeter(stream),
        ender: createEndAfterReply(() => {
          if (activeRef.current === active) void teardown({ reason: '声の指示で会話を終了しました。' });
        }),
      };
      activeRef.current = active;
      try {
        observerRef.current?.onStart(options.trigger ?? 'manual', startedAt);
      } catch {
        /* 記録できなくても会話は続ける */
      }
      stream = null; // 以降は active が所有
      setRemaining(grant.maxSessionSeconds);

      session.on('history_updated', (history) => setLines(toLines(history)));
      session.on('transport_event', (ev) => {
        try {
          observerRef.current?.onEvent(ev as { type?: string; [k: string]: unknown });
        } catch {
          /* 記録の失敗で会話を止めない */
        }
        active.ender.onEvent(ev.type);
        if (ev.type === 'input_audio_buffer.speech_started' && active.noSpeechTimer !== null) {
          window.clearTimeout(active.noSpeechTimer);
          active.noSpeechTimer = null;
        }
      });
      session.on('error', (ev) => {
        if (activeRef.current !== active) return;
        void teardown({ error: `通信エラーが発生したため会話を終了しました（${describeSessionError(ev.error)}）。` });
      });
      transport.on('connection_change', (status) => {
        if (status === 'disconnected' && activeRef.current === active && genRef.current === gen) {
          void teardown({ error: 'OpenAI との接続が切断されました。もう一度「会話開始」を押してください。' });
        }
      });

      try {
        await session.connect({ apiKey: grant.clientSecret });
      } catch {
        throw new UserFacingError('OpenAI Realtime API への接続に失敗しました。ネットワーク・APIキーの権限・モデル名を確認してください。');
      }
      if (cancelled()) throw new CancelledError();

      if (transport.callId) void reportCall(leaseId, transport.callId);
      // 起動時の挨拶（KAITO.md の「起動時の挨拶」）。接続直後の 1 回だけで、会話の途中では言わない。空なら挨拶しない
      if (grant.greetingInstructions) {
        try {
          transport.sendEvent({ type: 'response.create', response: { instructions: grant.greetingInstructions } });
        } catch {
          /* 挨拶が送れなくても会話は続けられる */
        }
      }
      if (options.trigger === 'clap' || options.trigger === 'wake') {
        const how = options.trigger === 'clap' ? '拍手' : '呼びかけ';
        active.noSpeechTimer = window.setTimeout(() => {
          if (activeRef.current !== active) return;
          void teardown({
            reason: `${how}で起動しましたが、${CLAP_NO_SPEECH_TIMEOUT_SEC}秒間話しかけがなかったため自動で終了しました（誤起動対策）。`,
          });
        }, CLAP_NO_SPEECH_TIMEOUT_SEC * 1000);
      }
      setPhase('connected');
    } catch (e) {
      if (stream) stopStream(stream);
      if (e instanceof CancelledError) {
        // 終了ボタン等で中断された。teardown 済み or これから解放する
        if (grant && !activeRef.current) void notifyEnd(grant.leaseId);
        return;
      }
      const message = e instanceof UserFacingError ? e.message : '予期しないエラーが発生しました。';
      if (activeRef.current) {
        await teardown({ error: message });
      } else {
        if (grant) await notifyEnd(grant.leaseId);
        setError(message);
        setPhase('idle');
      }
    } finally {
      startingRef.current = false;
    }
  }, [teardown]);

  const stop = useCallback(async () => {
    if (!activeRef.current) {
      // 開始処理中なら中断させる
      genRef.current += 1;
      setPhase('idle');
      return;
    }
    await teardown({ reason: '会話を終了しました。マイクと音声接続を閉じました。' });
  }, [teardown]);

  // タブを閉じる・画面を離れるときも確実に閉じる
  useEffect(() => {
    const onPageHide = () => {
      const a = activeRef.current;
      if (!a) return;
      navigator.sendBeacon(`/api/session/${encodeURIComponent(a.leaseId)}/end`);
      void teardown();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      void teardown();
    };
  }, [teardown]);

  /** 会話中のマイク入力レベル（0〜1、実測）。会話中でなければ null */
  const getInputLevel = useCallback((): number | null => activeRef.current?.meter?.level() ?? null, []);

  /** 声で終了を指示されたとき：KAITO の別れの一言を再生し終えてから切断する（会話中でなければ何もしない） */
  const endAfterReply = useCallback((): boolean => {
    const a = activeRef.current;
    if (!a) return false;
    a.ender.request();
    return true;
  }, []);

  return { phase, error, notice, lines, remaining, start, stop, endAfterReply, getInputLevel };
}

// ---------- 補助 ----------
interface InputMeter {
  level(): number;
  close(): void;
}

/** 会話用マイクの音量を測る（AnalyserNode。音声は保存・送信しない） */
function createInputMeter(stream: MediaStream): InputMeter | null {
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    return {
      level() {
        an.getFloatTimeDomainData(buf);
        let e = 0;
        for (let i = 0; i < buf.length; i++) e += buf[i]! * buf[i]!;
        const db = 10 * Math.log10(e / buf.length + 1e-12);
        return Math.min(1, Math.max(0, (db + 60) / 50)); // -60dB→0、-10dB→1
      },
      close() {
        void ctx.close().catch(() => undefined);
      },
    };
  } catch {
    return null;
  }
}

class UserFacingError extends Error {}
class CancelledError extends Error {}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

async function fetchGrant(body: { voice?: string; audioProfile?: AudioProfileId; speechSpeed?: SpeechSpeed }): Promise<SessionGrant> {
  let res: Response;
  try {
    res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new UserFacingError('ローカルサーバーに接続できません。サーバーが起動しているか確認してください。');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new UserFacingError(body?.message ?? `サーバーエラー（HTTP ${res.status}）が発生しました。`);
  }
  return (await res.json()) as SessionGrant;
}

async function notifyEnd(leaseId: string): Promise<void> {
  try {
    await fetch(`/api/session/${encodeURIComponent(leaseId)}/end`, { method: 'POST', keepalive: true });
  } catch {
    /* サーバー停止中でもリースは時間で解放される */
  }
}

async function reportCall(leaseId: string, callId: string): Promise<void> {
  try {
    await fetch(`/api/session/${encodeURIComponent(leaseId)}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId }),
    });
  } catch {
    /* 失敗してもクライアント側タイマーで切断される */
  }
}

function micErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'マイクの使用が許可されませんでした。アドレスバー左のアイコンからマイクを「許可」にして、もう一度お試しください。';
    case 'NotFoundError':
      return 'マイクが見つかりません。マイクが接続・有効になっているか確認してください。';
    case 'NotReadableError':
      return 'マイクを使用できません。他のアプリがマイクを使用していないか確認してください。';
    default:
      return 'マイクの取得に失敗しました。';
  }
}

function describeSessionError(err: unknown): string {
  // 内容を詳しく出しすぎない（トークン等の混入防止）。種類だけ表示する。
  if (err && typeof err === 'object') {
    const inner = (err as { error?: { type?: unknown; code?: unknown } }).error;
    const code = inner?.code ?? inner?.type;
    if (typeof code === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(code)) return code;
    if (err instanceof Error) return err.name;
  }
  return '詳細不明';
}

function toLines(history: RealtimeItem[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const item of history) {
    if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) continue;
    const texts: string[] = [];
    for (const part of item.content) {
      if (part.type === 'input_text' || part.type === 'output_text') texts.push(part.text);
      else if ((part.type === 'input_audio' || part.type === 'output_audio') && part.transcript) texts.push(part.transcript);
    }
    const text = texts.join(' ').trim();
    out.push({
      id: item.itemId,
      role: item.role,
      text: text || null,
      pending: !text && item.status === 'in_progress',
    });
  }
  return out;
}
