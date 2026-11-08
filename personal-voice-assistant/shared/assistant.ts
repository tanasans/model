/**
 * サーバーとクライアントで共有する、秘書の振る舞いの定義。
 * 秘密情報（APIキー等）はここに置かないこと。
 */
import type { AudioProfileId, SpeechSpeed } from './conversationAudio.js';
import { buildGreetingInstructions, buildInstructions, DEFAULT_PERSONA } from './persona.js';

export const ASSISTANT_NAME = 'KAITO';

/**
 * 内蔵の初期設定から作った指示文（KAITO.md が読めないときの予備・テスト用）。
 * 実際の会話では、サーバーが KAITO.md と個人設定から毎回組み立てた指示文（SessionGrant.instructions）を使う。
 */
export const ASSISTANT_INSTRUCTIONS = buildInstructions(DEFAULT_PERSONA);
export const GREETING_TEXT = DEFAULT_PERSONA.greeting;
export const GREETING_INSTRUCTIONS = buildGreetingInstructions(DEFAULT_PERSONA.greeting)!;

/**
 * Realtime API で利用できる声（openai SDK 7.51 の型定義で確認：2026-11-07）。
 * 既定は従来どおり marin。ユーザーが採用を決めるまで既定は変えない。
 */
export const VOICES = ['marin', 'cedar', 'ash', 'echo', 'ballad', 'verse', 'sage', 'alloy', 'coral', 'shimmer'] as const;
export type VoiceId = (typeof VOICES)[number];
export function isVoiceId(v: unknown): v is VoiceId {
  return typeof v === 'string' && (VOICES as readonly string[]).includes(v);
}

/** 声の試聴用の固定文（任意の文章は受け付けない：料金と悪用の抑制） */
export const PREVIEW_SAMPLES = [
  { id: 'greet', text: 'はい、カイトです。' },
  { id: 'ack', text: '明日は晴れるみたいじゃけぇ、傘はいらんと思うよ。' },
  { id: 'report', text: '今の状況を見てみたんじゃけど、大事な点が二つあるんよ。' },
] as const;
export type PreviewSampleId = (typeof PREVIEW_SAMPLES)[number]['id'];

/** 入力音声の文字起こしに使うモデル（Realtime API が対応するもの） */
export const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

/**
 * 発話の区切り（ターン検出, VAD）の設定。SDK（@openai/agents/realtime）の camelCase 形式。
 * サーバーの環境変数から決まり、client secret 発行時とクライアント接続時の両方で同じ値を使う。
 */
export type TurnDetectionSetting =
  | { type: 'semantic_vad'; eagerness: 'low' | 'medium' | 'high' | 'auto' }
  | { type: 'server_vad'; silenceDurationMs: number; prefixPaddingMs: number; threshold: number };

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';


/** サーバーの /api/session が返す内容（短命 client secret を含む） */
export interface SessionGrant {
  leaseId: string;
  clientSecret: string;
  clientSecretExpiresAt: number;
  model: string;
  voice: string;
  maxSessionSeconds: number;
  turnDetection: TurnDetectionSetting;
  /** 推論対応モデルでのみ設定。非対応なら null（送信しない） */
  reasoningEffort: ReasoningEffort | null;
  /** 入力の雑音低減（null＝使わない＝従来どおり）。.env の INPUT_NOISE_REDUCTION */
  inputNoiseReduction: 'near_field' | 'far_field' | null;
  /** 話し始めで AI の返答を止めるか（null＝API の既定＝従来どおり）。.env の VAD_INTERRUPT_RESPONSE */
  interruptResponse: boolean | null;
  /** 文字起こしモデル。.env の TRANSCRIPTION_MODEL（既定は従来の gpt-4o-mini-transcribe） */
  transcriptionModel: string;
  /** 適用されたテレビ音声対策プリセット（standard＝従来どおり） */
  audioProfile: AudioProfileId;
  /** 話す速さ（1＝従来どおり） */
  speechSpeed: SpeechSpeed;
  /** KAITO.md と個人設定から組み立てた指示文（client secret と同じもの） */
  instructions: string;
  /** 接続直後に 1 回だけ使う挨拶の指示（挨拶なしなら null） */
  greetingInstructions: string | null;
}

export interface HealthInfo {
  ok: true;
  apiKeyConfigured: boolean;
  model: string;
  maxSessionSeconds: number;
  /** サーバーの既定の声（.env の REALTIME_VOICE） */
  defaultVoice: string;
}

export interface ApiErrorBody {
  code:
    | 'NO_API_KEY'
    | 'SESSION_BUSY'
    | 'RATE_LIMITED'
    | 'FORBIDDEN_ORIGIN'
    | 'BAD_REQUEST'
    | 'UPSTREAM_AUTH'
    | 'UPSTREAM_ERROR'
    | 'TIMEOUT'
    | 'NOT_FOUND'
    | 'INTERNAL';
  message: string;
}
