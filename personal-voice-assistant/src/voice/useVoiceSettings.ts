import { useCallback, useState } from 'react';
import { isVoiceId, type ApiErrorBody, type PreviewSampleId, type VoiceId } from '../../shared/assistant';

/**
 * 声の選択と試聴（画面から独立したロジック層）。
 * - 選んだ声はブラウザに保存し、次の新しい会話から使う（会話中の声は変えない）
 * - 何も選んでいない間はサーバーの既定（.env の REALTIME_VOICE、通常 marin）のまま
 * - 試聴は OpenAI Realtime API を使うため料金がかかる
 */
const KEY = 'pva.voice.v1';

/** 声の説明（印象は記載しない。実際に試聴して比較する） */
export const VOICE_NOTES: Record<VoiceId, string> = {
  marin: '現在の既定（比較用）',
  cedar: '優先候補',
  ash: '優先候補',
  echo: '優先候補',
  ballad: 'その他の候補',
  verse: 'その他の候補',
  sage: 'その他の候補',
  alloy: 'その他の候補',
  coral: 'その他の候補',
  shimmer: 'その他の候補',
};
export const PRIORITY_VOICES: VoiceId[] = ['marin', 'cedar', 'ash', 'echo'];

function load(): VoiceId | null {
  try {
    const v = localStorage.getItem(KEY);
    return isVoiceId(v) ? v : null;
  } catch {
    return null;
  }
}

export interface PreviewResultView {
  voice: VoiceId;
  sampleId: PreviewSampleId;
  firstAudioMs: number;
  totalMs: number;
  audioSeconds: number;
  at: number;
}

export function useVoiceSettings() {
  const [chosen, setChosen] = useState<VoiceId | null>(load);
  const [previewing, setPreviewing] = useState<{ voice: VoiceId; sampleId: PreviewSampleId } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [results, setResults] = useState<PreviewResultView[]>([]);

  const choose = useCallback((v: VoiceId | null) => {
    setChosen(v);
    try {
      if (v) localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch {
      /* 保存できなくても今回の画面では有効 */
    }
  }, []);

  const preview = useCallback(async (voice: VoiceId, sampleId: PreviewSampleId) => {
    setPreviewing({ voice, sampleId });
    setPreviewError(null);
    try {
      const res = await fetch('/api/voice-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice, sampleId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
        throw new Error(body?.message ?? `試聴に失敗しました（HTTP ${res.status}）。`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      setResults((r) =>
        [
          {
            voice,
            sampleId,
            firstAudioMs: Number(res.headers.get('X-First-Audio-Ms') ?? NaN),
            totalMs: Number(res.headers.get('X-Total-Ms') ?? NaN),
            audioSeconds: Number(res.headers.get('X-Audio-Seconds') ?? NaN),
            at: Date.now(),
          },
          ...r,
        ].slice(0, 20),
      );
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : '試聴に失敗しました。');
    } finally {
      setPreviewing(null);
    }
  }, []);

  return { chosen, choose, preview, previewing, previewError, results };
}

export type VoiceSettings = ReturnType<typeof useVoiceSettings>;
