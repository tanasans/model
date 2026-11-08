/**
 * client secret 発行時に送る Realtime セッション設定を組み立てる（純粋関数。テストで送信内容を確認できる）。
 * 任意設定は「設定されたときだけ」送り、未設定なら従来と同じ内容になる。
 */
import type { ReasoningEffort } from '../shared/assistant.js';
import type { ConversationAudio, SpeechSpeed } from '../shared/conversationAudio.js';

export interface SessionConfigInput {
  model: string;
  instructions: string;
  voice: string;
  transcriptionModel: string;
  effort: ReasoningEffort | null;
  audio: ConversationAudio;
  speechSpeed: SpeechSpeed;
}

export function buildRealtimeSession(o: SessionConfigInput) {
  const td = o.audio.turnDetection;
  const interrupt = o.audio.interruptResponse === null ? {} : { interrupt_response: o.audio.interruptResponse };
  return {
    type: 'realtime' as const,
    model: o.model,
    instructions: o.instructions,
    output_modalities: ['audio' as const],
    ...(o.effort ? { reasoning: { effort: o.effort } } : {}),
    audio: {
      input: {
        transcription: { model: o.transcriptionModel, language: 'ja' },
        ...(o.audio.inputNoiseReduction ? { noise_reduction: { type: o.audio.inputNoiseReduction } } : {}),
        turn_detection:
          td.type === 'semantic_vad'
            ? { type: 'semantic_vad' as const, eagerness: td.eagerness, ...interrupt }
            : {
                type: 'server_vad' as const,
                silence_duration_ms: td.silenceDurationMs,
                prefix_padding_ms: td.prefixPaddingMs,
                threshold: td.threshold,
                ...interrupt,
              },
      },
      output: { voice: o.voice, ...(o.speechSpeed === 1 ? {} : { speed: o.speechSpeed }) },
    },
  };
}
