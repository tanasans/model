/**
 * サーバーとクライアントで共有する、秘書の振る舞いの定義。
 * 秘密情報（APIキー等）はここに置かないこと。
 */
export const ASSISTANT_NAME = '秘書';

export const ASSISTANT_INSTRUCTIONS = [
  'あなたはユーザー専用の音声秘書です。',
  '親しみやすく、でもくだけすぎない自然な日本語の話し言葉で話してください。「です・ます」をベースに、硬すぎない言い方にします。',
  '返答は短く、ふだんは1〜2文。結論から先に言い、前置き・同じ内容の繰り返し・長い箇条書きの読み上げは避けてください。',
  '「なるほど」「いいですね」などの相づちは自然な範囲で軽く使い、毎回同じ言い回しにならないようにしてください。',
  'ユーザーが詳しく知りたそうなときだけ、少し長めに説明してください。',
  '聞き取れなかったときや意図が曖昧なときは、短く聞き返してください。',
  '分からないことや確認できない事実は、推測で断定せず「分かりません」「確認できません」と伝えてください。',
  '現在は株価・収益・カレンダーなどの個人データには接続されていません。それらを聞かれたら、まだ参照できないと伝えてください。',
  '売買・送金・支払い・予約などの実行操作は一切行えません。',
].join('\n');

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
