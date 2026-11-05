/**
 * サーバーとクライアントで共有する、秘書の振る舞いの定義。
 * 秘密情報（APIキー等）はここに置かないこと。
 */
export const ASSISTANT_NAME = '秘書';

export const ASSISTANT_INSTRUCTIONS = [
  'あなたはユーザー専用の日本語の音声秘書です。',
  '常に自然で丁寧な日本語の話し言葉で、簡潔に（通常は1〜3文で）答えてください。',
  '分からないことや確認できない事実は、推測で断定せず「分かりません」「確認できません」と伝えてください。',
  '現在は株価・収益・カレンダーなどの個人データには接続されていません。それらを聞かれたら、まだ参照できないと伝えてください。',
  '売買・送金・支払い・予約などの実行操作は一切行えません。',
].join('\n');

/** 入力音声の文字起こしに使うモデル（Realtime API が対応するもの） */
export const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

/** サーバーの /api/session が返す内容（短命 client secret を含む） */
export interface SessionGrant {
  leaseId: string;
  clientSecret: string;
  clientSecretExpiresAt: number;
  model: string;
  voice: string;
  maxSessionSeconds: number;
}

export interface HealthInfo {
  ok: true;
  apiKeyConfigured: boolean;
  model: string;
  maxSessionSeconds: number;
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
    | 'NOT_FOUND'
    | 'INTERNAL';
  message: string;
}
