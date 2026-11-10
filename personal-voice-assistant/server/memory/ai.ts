/**
 * 長期記憶の AI 処理（会話の要約・意味検索の埋め込み）。設定で ON にしたときだけ使う（既定 OFF・少額の料金）。
 * - 要約：会話の終了後に、確定した文字起こしを OpenAI に送り、2〜3 文に要約してローカルに保存する
 * - 埋め込み：記憶の内容（機微な情報を含む場合も、本人が保存したもの）と検索語を数値にし、言葉が違っても近い内容を探す
 * 待機中には呼ばない。ログに内容は出さない。
 */
import type OpenAI from 'openai';

export interface MemoryAi {
  embed(texts: string[]): Promise<Float32Array[]>;
  summarize(transcript: string): Promise<string>;
  models: { summary: string; embedding: string };
}

const SUMMARY_PROMPT =
  '以下は、音声 AI 秘書 KAITO とユーザーの会話の文字起こしです。後で「前に何を話したか」を探せるよう、日本語で 2〜3 文に要約してください。' +
  '決まったこと・予定・好み・頼まれたことを優先し、文字起こしに無いことは推測で補わないでください。挨拶だけの会話なら「挨拶のみ」と書いてください。';

export function createMemoryAi(openai: OpenAI | null, models = { summary: process.env.SUMMARY_MODEL?.trim() || 'gpt-5-mini', embedding: process.env.EMBEDDING_MODEL?.trim() || 'text-embedding-3-small' }): MemoryAi | null {
  if (!openai) return null;
  return {
    models,
    async embed(texts) {
      const r = await openai.embeddings.create({ model: models.embedding, input: texts });
      return r.data.map((d) => Float32Array.from(d.embedding as number[]));
    },
    async summarize(transcript) {
      const r = await openai.responses.create({ model: models.summary, instructions: SUMMARY_PROMPT, input: transcript, max_output_tokens: 600 });
      return (r.output_text ?? '').trim();
    },
  };
}
