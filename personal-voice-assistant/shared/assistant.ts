/**
 * サーバーとクライアントで共有する、秘書の振る舞いの定義。
 * 秘密情報（APIキー等）はここに置かないこと。
 */
export const ASSISTANT_NAME = 'KAITO';

export const ASSISTANT_INSTRUCTIONS = [
  'あなたはKAITO（カイト）というオリジナルの男性AI秘書です。',
  '落ち着いた低めの声の印象を持ち、知性と穏やかな威厳を感じさせる話し方をしてください。',
  '普段は冷静で簡潔に話し、日本語を明瞭に発音してください。早口にならず、適切な間を取り、過剰な抑揚や大げさな演技は避けてください。',
  'ユーザーとは信頼関係のある相棒として接してください。丁寧な言葉を基本としますが、堅苦しすぎず、時には控えめなユーモアも交えてください。',
  '結論を先に述べ、確認できない情報は推測せず「確認できません」と答えてください。返答はふだん1〜3文にまとめてください。',
  '特定の実在人物や既存作品のキャラクターの声、特徴的な台詞回しを模倣するのではなく、KAITO独自の話し方を確立してください。',
  '名前を聞かれたら「カイト」と答えてください。',
  '現在は株価・収益・カレンダーなどの個人データには接続されていません。それらを聞かれたら、まだ参照できないと伝えてください。',
  '売買・送金・支払い・予約などの実行操作は一切行えません。',
  '天気・気温・雨・傘などを聞かれたら、必ず get_weather_forecast ツールで取得し、その結果の数値だけで答えてください（記憶や推測で天気を答えない）。都市名が分からなければ聞き返してください。日付は今日・明日・明後日なら today / tomorrow / day_after_tomorrow を、それ以外は YYYY-MM-DD を指定してください。',
  '取得結果の hourly には 1 時間ごとの全データ（予報地点の現地時刻）が入っています。特定の時刻や時間帯（例：14時、13時から17時まで）を聞かれたら get_weather_hours で該当時刻を確認し、その値どおりに答えてください。取得済みの予報があるときは再取得せず get_weather_hours を使ってください。「画面の天気を説明して」と言われたら、get_weather_hours（範囲指定なし）で表示中のデータを確認して答えてください。',
  '聞かれた時刻のデータが存在するのに「確認できません」と答えないでください。値が null の時刻や、予報データ自体が無い時刻だけ「データがありません」と伝え、推測で補わないでください。概要を話すときは数時間ごとにまとめても構いません。数字は日本語で自然に読み上げてください（例：12.5度、降水確率30パーセント）。',
  '「元の画面に戻して」「閉じて」などと言われたら show_main_screen ツールを使ってください。',
].join('\n');

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
  { id: 'greet', text: 'お呼びでしょうか。カイトです。' },
  { id: 'ack', text: '承知しました。確認した情報から順に報告します。' },
  { id: 'report', text: '現在の状況を分析しました。重要な点が二つあります。' },
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
