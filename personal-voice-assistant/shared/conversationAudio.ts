/**
 * 会話中の音声入出力の調整（テレビ音声対策・話す速さ）。サーバーとクライアントで共有する。
 * - 既定（standard / 1.0）は従来どおり＝ .env の設定がそのまま使われる
 * - 画面で選んだ値は次の新しい会話から適用される（会話中は変えない）
 */
import type { TurnDetectionSetting } from './assistant.js';

/** 会話の入力側の設定（client secret とクライアント接続の両方で同じ値を使う） */
export interface ConversationAudio {
  turnDetection: TurnDetectionSetting;
  /** null＝雑音低減を使わない */
  inputNoiseReduction: 'near_field' | 'far_field' | null;
  /** null＝API の既定（話し始めると AI の返答が止まる） */
  interruptResponse: boolean | null;
}

/**
 * テレビ音声対策のプリセット。段階ごとに 1 つずつ対策を足していくので、実機で比較しやすい。
 * - standard : 従来どおり（.env の設定）
 * - tv_light : + 入力の雑音低減 far_field（離れたマイク・周囲音向け）
 * - tv_strong: + 話し始めても返答を止めない（テレビの声で KAITO の返答が途切れなくなる。
 *              代わりに、ユーザーが声で割り込んで止めることもできなくなる）
 */
export const AUDIO_PROFILES = ['standard', 'tv_light', 'tv_strong'] as const;
export type AudioProfileId = (typeof AUDIO_PROFILES)[number];
export const DEFAULT_AUDIO_PROFILE: AudioProfileId = 'standard';

export const AUDIO_PROFILE_LABEL: Record<AudioProfileId, string> = {
  standard: '標準（従来どおり）',
  tv_light: 'テレビ対策・弱（雑音低減）',
  tv_strong: 'テレビ対策・強（雑音低減＋返答を止めない）',
};

export function isAudioProfileId(v: unknown): v is AudioProfileId {
  return typeof v === 'string' && (AUDIO_PROFILES as readonly string[]).includes(v);
}

/** プリセットを .env 由来の基本設定に重ねる（standard は基本設定をそのまま返す） */
export function applyAudioProfile(profile: AudioProfileId, base: ConversationAudio): ConversationAudio {
  switch (profile) {
    case 'standard':
      return base;
    case 'tv_light':
      return { ...base, inputNoiseReduction: 'far_field' };
    case 'tv_strong':
      return { ...base, inputNoiseReduction: 'far_field', interruptResponse: false };
  }
}

/** 話す速さ（API の audio.output.speed。1.0＝従来どおり。範囲は API 上 0.25〜1.5） */
export const SPEECH_SPEEDS = [0.85, 0.9, 0.95, 1] as const;
export type SpeechSpeed = (typeof SPEECH_SPEEDS)[number];
export const DEFAULT_SPEECH_SPEED: SpeechSpeed = 1;

export function isSpeechSpeed(v: unknown): v is SpeechSpeed {
  return typeof v === 'number' && (SPEECH_SPEEDS as readonly number[]).includes(v);
}
