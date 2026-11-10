import { useCallback, useState } from 'react';
import {
  type AudioProfileId,
  DEFAULT_AUDIO_PROFILE,
  DEFAULT_SPEECH_SPEED,
  isAudioProfileId,
  isSpeechSpeed,
  type SpeechSpeed,
} from '../../shared/conversationAudio';

/**
 * 会話の音声調整（テレビ音声対策・話す速さ）の保存と復元。
 * - 保存先はこのブラウザの localStorage のみ（サーバーや GitHub には送らない・個人情報は含まない）
 * - 不正な値・壊れたデータは既定値（従来どおり）に戻す
 * - 変更は次の新しい会話から適用される
 */
export const CONVERSATION_SETTINGS_KEY = 'pva.conversation.v1';

export interface ConversationSettings {
  audioProfile: AudioProfileId;
  speechSpeed: SpeechSpeed;
  /** 起動時の挨拶を、作成済みのローカル音声で再生する（音声を作成していなければ従来どおり） */
  localGreeting: boolean;
  /**
   * 高速起動：起動音の鳴り終わりを待たず、会話用マイクと一時キーを並行して準備する。
   * 既定は ON（実機で、PC の再起動後は ON でも呼びかけに反応することを確認）。OFF にすると従来どおり起動音の後に順番に準備する
   */
  fastStart: boolean;
}

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  audioProfile: DEFAULT_AUDIO_PROFILE,
  speechSpeed: DEFAULT_SPEECH_SPEED,
  localGreeting: true,
  fastStart: true,
};

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadConversationSettings(store: KV | null = storage()): ConversationSettings {
  try {
    const raw = store?.getItem(CONVERSATION_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_CONVERSATION_SETTINGS };
    const v = JSON.parse(raw) as Partial<Record<keyof ConversationSettings, unknown>>;
    return {
      audioProfile: isAudioProfileId(v?.audioProfile) ? v.audioProfile : DEFAULT_AUDIO_PROFILE,
      speechSpeed: isSpeechSpeed(v?.speechSpeed) ? v.speechSpeed : DEFAULT_SPEECH_SPEED,
      localGreeting: v?.localGreeting !== false,
      fastStart: v?.fastStart !== false,
    };
  } catch {
    return { ...DEFAULT_CONVERSATION_SETTINGS };
  }
}

export function saveConversationSettings(s: ConversationSettings, store: KV | null = storage()): void {
  try {
    store?.setItem(CONVERSATION_SETTINGS_KEY, JSON.stringify({ audioProfile: s.audioProfile, speechSpeed: s.speechSpeed, localGreeting: s.localGreeting, fastStart: s.fastStart }));
  } catch {
    /* 保存できなくても今回の画面では有効 */
  }
}

export function useConversationSettings() {
  const [settings, setSettings] = useState<ConversationSettings>(() => loadConversationSettings());
  const update = useCallback((patch: Partial<ConversationSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveConversationSettings(next);
      return next;
    });
  }, []);
  return { settings, update };
}

export type ConversationSettingsController = ReturnType<typeof useConversationSettings>;
