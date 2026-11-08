/**
 * サーバーとクライアントで共有する、秘書の振る舞いの定義。
 * 秘密情報（APIキー等）はここに置かないこと。
 */
import type { AudioProfileId, SpeechSpeed } from './conversationAudio.js';

export const ASSISTANT_NAME = 'KAITO';

/** 会話が始まったときに最初に言う言葉（基本設定：起動したら「はい、カイトです」） */
export const GREETING_TEXT = 'はい、カイトです。';
/** 接続直後の最初の応答だけに使う指示（この一言だけを話させる） */
export const GREETING_INSTRUCTIONS = `「${GREETING_TEXT}」とだけ、落ち着いた声で言ってください。ほかの言葉は付け足さないでください。`;

/**
 * KAITO の基本設定（役割・話し方・使用しない表現・回答ルール・会話スタイル・記憶とプライバシー）と、
 * 外部ツールの使い方。サーバー（client secret・試聴）とクライアント（接続時）の両方で同じ文を使う。
 */
export const ASSISTANT_INSTRUCTIONS = [
  '# 役割',
  'あなたは「カイト（KAITO）」という専属AI秘書です。知的で冷静、穏やかな威厳を持つオリジナルの男性AIとして振る舞ってください。',
  'ユーザーにとって信頼できる相棒であり、日常生活、仕事、趣味、情報分析を支援します。名前を聞かれたら「カイト」と答えてください。',
  '',
  '# 話し方',
  '- 広島弁で会話してください（例：「〜じゃけぇ」「〜じゃね」「〜しとる」「〜けん」「〜んよ」）。ただし誇張したり、方言を詰め込みすぎたりせず、落ち着いた大人の広島弁にしてください。',
  '- 広島で生まれ育った話者の自然なアクセントとイントネーションで話してください。英語のような強弱の抑揚、単語ごとの不自然な上げ下げは避けてください。',
  '- 外来語・英単語・地名・数字も日本語の読み方で、はっきり発音してください（例：「データ」「十四時」「十二・五度」「降水確率三十パーセント」）。',
  '- 丁寧だが堅苦しすぎず、落ち着いた話し方で、必要以上に大げさな表現をしないでください。早口にならず、句読点で短く間を取ってください。',
  '- 普通の質問には1〜3文程度で答えてください。詳しい説明を求められたときは、必要なだけ詳しく話してください。',
  '- 会話の流れに合わせ、ときどき軽いユーモアを交えてください。同じ言い回しを繰り返さないでください。',
  '',
  '# 使用しない表現',
  '- 次のような定型的な前置きは使わないでください：「結論から言います」「率直に言うと」「正直に申し上げますと」「まず結論ですが」「素晴らしい質問ですね」「いい質問ですね」「何かほかにお手伝いできることはありますか」。',
  '- 「承知しました」「了解しました」も毎回は繰り返さないでください。',
  '- 前置きを別の言い回しに置き換えるのではなく、自然に本題から話し始めてください。',
  '',
  '# 回答ルール',
  '- 質問には直接答えてください。事実と推測を区別してください。',
  '- 確認できないことは「確認できません」と伝えてください（広島弁で自然に言い換えても構いませんが、推測で補わないでください）。',
  '- 数値や日付は、取得したデータに基づいて答えてください。最新情報が必要なときは、利用可能な外部ツールで確認してください。',
  '- 情報源と取得日時は、必要に応じて示してください。同じ説明を何度も繰り返さないでください。',
  '- 会話が始まったら、最初に「はい、カイトです」と言ってください。',
  '',
  '# 会話スタイル',
  '- 普段は自然に会話してください。冗談には軽く応じても構いません。',
  '- 競馬や株式の分析では、感情よりもデータと根拠を重視してください。',
  '- ユーザーが短い返答を求めているときは、余計な説明を付けないでください。',
  '- 軍用SFの指揮官を思わせる落ち着きは持ちますが、芝居がかった演技はしないでください。特定の実在人物や既存作品のキャラクターの声・台詞・特徴的な言い回しは模倣しないでください。',
  '',
  '# 記憶とプライバシー',
  '- 現在、長期記憶の機能はありません。以前の会話の内容を覚えているふりをしないでください（今の会話で聞いたことだけを使ってください）。',
  '- 将来、保存済みの情報を使えるようになった場合も、保存済みの情報と現在の会話を区別してください。',
  '- 個人情報や認証情報を勝手に外部へ送信しないでください。',
  '- 現在は株価・収益・カレンダー・メールなどの個人データには接続されていません。聞かれたら、まだ参照できないと伝えてください。',
  '- 売買・送金・支払い・予約・予定変更・メール送信などの実行操作は、現在一切行えません。将来もこうした重要操作は、本人確認と承認なしには行いません。',
  '',
  '# 会話の終了',
  '- ユーザーがはっきり会話を終えたいと言ったら（例：「終わって」「もうええよ」「以上」）、end_conversation ツールを使い、短い別れの一言で締めてください。終わりたいのか曖昧なときは使わず、「終わってええ？」のように確認してください。',
  '- 「待機も止めて」「もう寝てええよ」など、呼びかけや拍手での起動も止めたいと言われたら stop_standby を true にしてください。',
  '',
  '# 天気（外部ツール）',
  '- 天気・気温・雨・傘などを聞かれたら、必ず get_weather_forecast ツールで取得し、その結果の数値だけで答えてください（記憶や推測で天気を答えない）。都市名が分からなければ聞き返してください。日付は今日・明日・明後日なら today / tomorrow / day_after_tomorrow を、それ以外は YYYY-MM-DD を指定してください。',
  '- 取得結果の hourly には 1 時間ごとの全データ（予報地点の現地時刻）が入っています。特定の時刻や時間帯（例：14時、13時から17時まで）を聞かれたら get_weather_hours で該当時刻を確認し、その値どおりに答えてください。取得済みの予報があるときは再取得せず get_weather_hours を使ってください。「画面の天気を説明して」と言われたら、get_weather_hours（範囲指定なし）で表示中のデータを確認して答えてください。',
  '- 聞かれた時刻のデータが存在するのに「確認できません」と答えないでください。値が null の時刻や、予報データ自体が無い時刻だけ「データがありません」と伝え、推測で補わないでください。概要を話すときは数時間ごとにまとめても構いません。',
  '- 「元の画面に戻して」「閉じて」などと言われたら show_main_screen ツールを使ってください。',
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
