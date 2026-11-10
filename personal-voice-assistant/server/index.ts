/**
 * ローカル専用 API サーバー。
 * - 通常の OpenAI API キーは環境変数（.env）からのみ読み込み、クライアントへは渡さない。
 * - クライアントには POST /v1/realtime/client_secrets（GA）で発行した短命 client secret のみを返す。
 * - 同時セッション数 1、最大継続時間、作成間隔の制限で予期しない課金増を抑える。
 * - ログには APIキー・トークン・音声・会話内容を出力しない。
 */
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { previewVoice, PreviewError } from './voicePreview.js';
import { runTool } from './tools/registry.js';
import { buildRealtimeSession } from './sessionConfig.js';
import { defaultPersonaPaths, importPersona, loadPersona, migrateLegacyPersona, PersonaError, resetPersona, savePersona, sessionPersona } from './persona.js';
import { isInsideApp, resolveDataDir } from './memory/dataDir.js';
import { DB_FILE, openMemoryStore } from './memory/store.js';
import { memoryRouter, type MemoryHolder } from './memory/routes.js';
import { createMemoryAi } from './memory/ai.js';
import { buildMemoryInstructions } from '../shared/memory.js';
import { desktopRouter, newDesktopState, otherInstance, removeLock, uiOpen, writeLock } from './desktop/desktop.js';
import { isPersonaKey, type PersonaOverrides } from '../shared/persona.js';
import OpenAI from 'openai';
import {
  TRANSCRIPTION_MODEL,
  type ApiErrorBody,
  type HealthInfo,
  isVoiceId,
  PREVIEW_SAMPLES,
  type ReasoningEffort,
  type SessionGrant,
  type TurnDetectionSetting,
} from '../shared/assistant.js';
import {
  applyAudioProfile,
  type AudioProfileId,
  type ConversationAudio,
  DEFAULT_AUDIO_PROFILE,
  DEFAULT_SPEECH_SPEED,
  isAudioProfileId,
  isSpeechSpeed,
  type SpeechSpeed,
} from '../shared/conversationAudio.js';

// ---------- 設定 ----------
const HOST = '127.0.0.1'; // ローカルホストのみ。外部公開しない。
const PORT = intEnv('PORT', 8787, 1, 65535);
const MODEL = strEnv('REALTIME_MODEL', 'gpt-realtime-2.1');
const VOICE = strEnv('REALTIME_VOICE', 'marin');
const MAX_SESSION_SECONDS = intEnv('MAX_SESSION_SECONDS', 300, 30, 1800);
const TURN_DETECTION = turnDetectionFromEnv();
// 以下は任意設定（未設定なら従来どおり）。テレビ音声などで会話が途切れる場合の対策候補
const INPUT_NOISE_REDUCTION = ((): 'near_field' | 'far_field' | null => {
  const v = enumEnv('INPUT_NOISE_REDUCTION', ['off', 'near_field', 'far_field'] as const, 'off');
  return v === 'off' ? null : v;
})();
const INTERRUPT_RESPONSE = ((): boolean | null => {
  const v = (process.env.VAD_INTERRUPT_RESPONSE ?? '').trim().toLowerCase();
  return v === 'true' ? true : v === 'false' ? false : null;
})();
const TRANSCRIPTION = strEnv('TRANSCRIPTION_MODEL', TRANSCRIPTION_MODEL);
/**
 * 接続方式。direct（既定）：ブラウザの接続の申し込み（SDP）をローカルサーバーが API キー付きで OpenAI に送る
 * （一時キーの発行が不要になり、起動が速い。API キーはブラウザに渡らない）。secret：従来の一時キー方式
 */
const CONNECT_MODE = enumEnv('REALTIME_CONNECT', ['direct', 'secret'] as const, 'direct');
/** 計測用：WebRTC の接続先を模擬サーバーに切り替える（通常は未設定＝OpenAI）。ローカルのアドレスだけ受け付ける */
const REALTIME_WEBRTC_URL = ((): string | null => {
  const v = (process.env.REALTIME_WEBRTC_URL ?? '').trim();
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(v) ? v : null;
})();
/** .env 由来の会話音声設定（画面のプリセット「標準」はこれをそのまま使う） */
const BASE_AUDIO: ConversationAudio = {
  turnDetection: TURN_DETECTION,
  inputNoiseReduction: INPUT_NOISE_REDUCTION,
  interruptResponse: INTERRUPT_RESPONSE,
};
/** 推論対応モデル（gpt-realtime-2 系）では推論量を抑えて返答までの待ち時間を短くする */
const REASONING_EFFORT: ReasoningEffort | null = /^gpt-realtime-2/.test(MODEL)
  ? enumEnv('REASONING_EFFORT', ['minimal', 'low', 'medium', 'high'] as const, 'low')
  : null;
/** API が reasoning 設定を受け付けなかった場合は以後送らない（従来動作に戻す） */
let reasoningAccepted = REASONING_EFFORT !== null;
/** client secret 自体の有効期限（接続開始にだけ使うので短く。API の下限は 10 秒） */
const CLIENT_SECRET_TTL_SECONDS = 60;
/** セッション作成の最小間隔（連打・ループ対策） */
const MIN_CREATE_INTERVAL_MS = 3_000;
/** クライアントが終了を通知しなかった場合でもリースを解放するまでの猶予 */
const LEASE_GRACE_MS = 15_000;

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 記憶・個人設定の保存先（ユーザー専用のローカル領域。ZIP を展開し直しても消えない。GitHub に含まれない） */
const DATA_DIR = resolveDataDir();
/** KAITO.md（基本設定）と KAITO.local.md（個人設定・データ領域）の場所 */
const PERSONA_PATHS = defaultPersonaPaths(APP_DIR, DATA_DIR);
const personaMigrated = migrateLegacyPersona(APP_DIR, PERSONA_PATHS);
/** デスクトップ常駐（ランチャーから起動された本番用サーバー） */
const DESKTOP_MODE = process.env.KAITO_DESKTOP === '1';
const APP_VERSION = ((): string => {
  try {
    return String(JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version ?? '');
  } catch {
    return '';
  }
})();
const desktop = newDesktopState();

// 多重起動防止：ほかの KAITO サーバーが動いていれば、起動しない（ほかのプロセスは終了しない）
{
  mkdirSync(DATA_DIR, { recursive: true });
  const other = await otherInstance(DATA_DIR);
  if (other) {
    console.error(`[${new Date().toISOString()}] KAITO のサーバーはすでに起動しています（PID ${other.pid}・ポート ${other.port}）。二重には起動しません。`);
    process.exit(3);
  }
}

// 長期記憶（SQLite）。開けなくてもアプリのほかの機能は動かす
const memory: MemoryHolder = await (async () => {
  const r = await openMemoryStore(DATA_DIR);
  const warnings = [...r.warnings];
  if (isInsideApp(DATA_DIR, APP_DIR)) warnings.push('保存先がアプリのフォルダの中にあります。新しい ZIP に入れ替えると記憶が消える可能性があります（KAITO_DATA_DIR を確認してください）。');
  return { store: r.store, error: r.error, warnings, dataDir: DATA_DIR, dbPath: path.join(DATA_DIR, DB_FILE) };
})();

/** 会話の指示文に加える「長期記憶」の部分（その時点の日時と、保存済みの好みだけ。全履歴は送らない） */
function memoryInstructions(): string {
  const s = memory.store;
  let preferences: Array<{ content: string }> = [];
  try {
    if (s && s.getSettings().includePreferences) preferences = s.startPreferences();
  } catch {
    preferences = [];
  }
  return buildMemoryInstructions({ available: Boolean(s), now: new Date(), preferences });
}

const API_KEY = (process.env.OPENAI_API_KEY ?? '').trim();
const openai = API_KEY ? new OpenAI({ apiKey: API_KEY, maxRetries: 1, timeout: 15_000 }) : null;

const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);

// ---------- セッション（リース）管理 ----------
interface Lease {
  id: string;
  createdAt: number;
  callId?: string;
  timer: NodeJS.Timeout;
  /** 直接接続：ブラウザがローカルサーバーに接続を申し込むときの合言葉（OpenAI のキーではない） */
  localKey?: string;
  /** 直接接続：OpenAI に送るセッション設定 */
  session?: SecretOptions;
  /** 計測：OpenAI への接続の申し込み（SDP）にかかった時間 */
  sdpMs?: number;
}
let activeLease: Lease | null = null;
let lastCreateAt = 0;

function releaseLease(id: string, reason: string): void {
  const lease = activeLease;
  if (!lease || lease.id !== id) return;
  clearTimeout(lease.timer);
  activeLease = null;
  log(`session released (${reason})`);
  if (lease.callId && openai && reason !== 'client-end') {
    // 期限切れ・強制終了時はサーバー側からも通話を切断する（ベストエフォート）
    openai.realtime.calls.hangup(lease.callId).then(
      () => log('server-side hangup ok'),
      (err: unknown) => log(`server-side hangup failed: ${describeError(err)}`),
    );
  }
}

// ---------- アプリ ----------
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

/** 他サイトからのリクエスト（CSRF）でトークンを発行させないための Origin チェック */
function requireLocalOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    sendError(res, 403, 'FORBIDDEN_ORIGIN', '許可されていない接続元です。');
    return;
  }
  next();
}

app.get('/api/health', (_req, res) => {
  const body: HealthInfo = {
    ok: true,
    apiKeyConfigured: Boolean(openai),
    model: MODEL,
    maxSessionSeconds: MAX_SESSION_SECONDS,
    defaultVoice: VOICE,
    app: 'kaito',
    version: APP_VERSION,
    instanceId: desktop.instanceId,
    pid: process.pid,
    desktopMode: DESKTOP_MODE,
    uiOpen: uiOpen(desktop),
  };
  res.json(body);
});

// ---------- 外部データ取得（会話中の Function Calling から呼ばれる） ----------
// API キーが必要なデータ源も将来ここ（サーバー側）で扱い、ブラウザにはキーを渡さない
const TOOL_WINDOW_MS = 60_000;
const TOOL_MAX_PER_WINDOW = 30;
let toolCalls: number[] = [];

app.post('/api/tools/:name', requireLocalOrigin, express.json({ limit: '2kb' }), async (req, res) => {
  const now = Date.now();
  toolCalls = toolCalls.filter((t) => now - t < TOOL_WINDOW_MS);
  if (toolCalls.length >= TOOL_MAX_PER_WINDOW) {
    res.status(429).json({ ok: false, tool: req.params.name, error: { code: 'RATE_LIMITED', message: '短時間に取得が多すぎます。少し待ってください。' } });
    return;
  }
  toolCalls.push(now);
  const result = await runTool(String(req.params.name), req.body?.args);
  log(`tool ${req.params.name} ${result.ok ? 'ok' : `failed code=${result.error.code}`}`);
  res.json(result);
});

// ---------- 声の試聴（会話と同じ Realtime API を使うため、料金がかかる） ----------
const MIN_PREVIEW_INTERVAL_MS = 4_000;
let previewBusy = false;
let lastPreviewAt = 0;

// ---------- ローカル挨拶（起動時の挨拶を KAITO の声で事前に作り、接続と同時に再生する） ----------
// 作成は利用者が画面のボタンを押したときだけ（OpenAI の料金がかかる）。待機中に自動で作ることはない
const GREETING_DIR = path.join(DATA_DIR, 'greetings');
function greetingFile(voice: string, speed: number, text: string): string {
  const key = createHash('sha256').update(`${MODEL}|${voice}|${speed}|${text}`).digest('hex').slice(0, 24);
  return path.join(GREETING_DIR, `greeting-${key}.wav`);
}

app.get('/api/greeting', (req, res) => {
  const voice = isVoiceId(req.query.voice) ? req.query.voice : VOICE;
  const speed = isSpeechSpeed(Number(req.query.speed)) ? Number(req.query.speed) : DEFAULT_SPEECH_SPEED;
  const text = sessionPersona(PERSONA_PATHS).greetingText;
  if (!text) {
    sendError(res, 404, 'NOT_FOUND', '起動時の挨拶が設定されていません。');
    return;
  }
  const file = greetingFile(voice, speed, text);
  if (!existsSync(file)) {
    sendError(res, 404, 'NOT_FOUND', 'この声・速さ・挨拶の音声はまだ作成されていません。');
    return;
  }
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('X-Greeting-Text', encodeURIComponent(text));
  res.send(readFileSync(file));
});

app.post('/api/greeting/generate', requireLocalOrigin, express.json({ limit: '1kb' }), async (req, res) => {
  const voice = isVoiceId(req.body?.voice) ? req.body.voice : VOICE;
  const speed: SpeechSpeed = isSpeechSpeed(req.body?.speed) ? req.body.speed : DEFAULT_SPEECH_SPEED;
  const persona = sessionPersona(PERSONA_PATHS);
  if (!persona.greetingText) {
    sendError(res, 400, 'BAD_REQUEST', '起動時の挨拶が空のため、作成できません（KAITO設定で挨拶を設定してください）。');
    return;
  }
  if (!openai) {
    sendError(res, 503, 'NO_API_KEY', 'サーバーに OPENAI_API_KEY が設定されていないため作成できません。');
    return;
  }
  if (activeLease || previewBusy) {
    sendError(res, 409, 'SESSION_BUSY', '会話中または試聴中です。終わってからお試しください。');
    return;
  }
  if (Date.now() - lastPreviewAt < MIN_PREVIEW_INTERVAL_MS) {
    sendError(res, 429, 'RATE_LIMITED', '続けて作成するには数秒お待ちください。');
    return;
  }
  previewBusy = true;
  lastPreviewAt = Date.now();
  try {
    const r = await previewVoice({
      apiKey: API_KEY,
      model: MODEL,
      voice,
      text: persona.greetingText,
      instructions: persona.instructions,
      url: process.env.REALTIME_WS_URL || undefined,
      reasoningEffort: reasoningAccepted ? REASONING_EFFORT : null,
      speed,
    });
    mkdirSync(GREETING_DIR, { recursive: true });
    const file = greetingFile(voice, speed, persona.greetingText);
    writeFileSync(`${file}.tmp`, r.wav);
    renameSync(`${file}.tmp`, file);
    log(`greeting audio created voice=${voice} speed=${speed} seconds=${r.audioSeconds.toFixed(2)}`);
    res.json({ ok: true, seconds: r.audioSeconds });
  } catch (err) {
    const code = err instanceof PreviewError ? err.code : 'UPSTREAM_ERROR';
    log(`greeting audio failed code=${code}`);
    sendError(res, code === 'TIMEOUT' ? 504 : 502, code, err instanceof PreviewError ? err.message : '挨拶の音声を作成できませんでした。');
  } finally {
    previewBusy = false;
  }
});

app.post('/api/voice-preview', requireLocalOrigin, express.json({ limit: '1kb' }), async (req, res) => {
  const voice: unknown = req.body?.voice;
  const sample = PREVIEW_SAMPLES.find((x) => x.id === req.body?.sampleId);
  const previewSpeed: SpeechSpeed = isSpeechSpeed(req.body?.speed) ? req.body.speed : DEFAULT_SPEECH_SPEED;
  if (!isVoiceId(voice) || !sample) {
    sendError(res, 400, 'BAD_REQUEST', '声または試聴文の指定が不正です。');
    return;
  }
  if (!openai) {
    sendError(res, 503, 'NO_API_KEY', 'サーバーに OPENAI_API_KEY が設定されていないため試聴できません。');
    return;
  }
  // 会話中・他の試聴中は行わない（同時接続の抑制）
  if (activeLease || previewBusy) {
    sendError(res, 409, 'SESSION_BUSY', '会話中または別の試聴中です。終わってからお試しください。');
    return;
  }
  if (Date.now() - lastPreviewAt < MIN_PREVIEW_INTERVAL_MS) {
    sendError(res, 429, 'RATE_LIMITED', '続けて試聴するには数秒お待ちください。');
    return;
  }
  previewBusy = true;
  lastPreviewAt = Date.now();
  try {
    const r = await previewVoice({
      apiKey: API_KEY,
      model: MODEL,
      voice,
      text: sample.text,
      instructions: sessionPersona(PERSONA_PATHS).instructions,
      url: process.env.REALTIME_WS_URL || undefined,
      reasoningEffort: reasoningAccepted ? REASONING_EFFORT : null,
      speed: previewSpeed,
    });
    log(`voice preview ok voice=${voice} speed=${previewSpeed} firstAudioMs=${r.firstAudioMs} totalMs=${r.totalMs}`);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('X-First-Audio-Ms', String(r.firstAudioMs));
    res.setHeader('X-Total-Ms', String(r.totalMs));
    res.setHeader('X-Audio-Seconds', r.audioSeconds.toFixed(2));
    res.send(r.wav);
  } catch (err) {
    const code = err instanceof PreviewError ? err.code : 'UPSTREAM_ERROR';
    log(`voice preview failed voice=${voice} code=${code}`);
    sendError(res, code === 'TIMEOUT' ? 504 : 502, code, err instanceof PreviewError ? err.message : '試聴に失敗しました。');
  } finally {
    previewBusy = false;
  }
});

// ---------- KAITO の人格設定（KAITO.md ＋ 個人設定） ----------
// 本文はログに出さない。GitHub への反映（KAITO.md の書き換え・コミット）はここでは一切行わない
function sendPersonaError(res: Response, err: unknown): void {
  if (err instanceof PersonaError) {
    res.status(400).json({ code: 'BAD_REQUEST', message: err.message, issues: err.issues });
    return;
  }
  log(`persona failed: ${describeError(err)}`);
  sendError(res, 500, 'INTERNAL', '設定の読み書きに失敗しました。');
}

app.get('/api/persona', (req, res) => {
  const origin = req.get('origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    sendError(res, 403, 'FORBIDDEN_ORIGIN', '許可されていない接続元です。');
    return;
  }
  res.json(loadPersona(PERSONA_PATHS));
});

app.put('/api/persona', requireLocalOrigin, express.json({ limit: '64kb' }), (req, res) => {
  const raw: unknown = req.body?.sections;
  if (!raw || typeof raw !== 'object') {
    sendError(res, 400, 'BAD_REQUEST', '設定の形式が不正です。');
    return;
  }
  const sections: PersonaOverrides = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPersonaKey(k) || typeof v !== 'string') {
      sendError(res, 400, 'BAD_REQUEST', '設定の項目が不正です。');
      return;
    }
    sections[k] = v;
  }
  try {
    const view = savePersona(PERSONA_PATHS, sections);
    log(`persona saved (overrides=${Object.keys(view.overrides).length})`);
    res.json(view);
  } catch (err) {
    sendPersonaError(res, err);
  }
});

app.post('/api/persona/import', requireLocalOrigin, express.json({ limit: '64kb' }), (req, res) => {
  const md: unknown = req.body?.markdown;
  if (typeof md !== 'string' || md.length > 60_000) {
    sendError(res, 400, 'BAD_REQUEST', 'Markdown の内容が不正です。');
    return;
  }
  try {
    const r = importPersona(PERSONA_PATHS, md);
    log(`persona imported (sections=${r.imported.length}, ignored=${r.ignored.length})`);
    res.json(r);
  } catch (err) {
    sendPersonaError(res, err);
  }
});

app.post('/api/persona/reset', requireLocalOrigin, express.json({ limit: '2kb' }), (req, res) => {
  const keys: unknown = req.body?.keys;
  if (keys !== undefined && !(Array.isArray(keys) && keys.every(isPersonaKey))) {
    sendError(res, 400, 'BAD_REQUEST', '項目の指定が不正です。');
    return;
  }
  try {
    const view = resetPersona(PERSONA_PATHS, keys as string[] | undefined);
    log(`persona reset (${keys ? `keys=${(keys as string[]).length}` : 'all'})`);
    res.json(view);
  } catch (err) {
    sendPersonaError(res, err);
  }
});

// ---------- 長期記憶（ローカルの SQLite。OpenAI には接続しない） ----------
function memoryGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET') {
    const origin = req.get('origin');
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      sendError(res, 403, 'FORBIDDEN_ORIGIN', '許可されていない接続元です。');
      return;
    }
    next();
    return;
  }
  requireLocalOrigin(req, res, next);
}
app.use('/api/memory', memoryRouter(memory, memoryGuard, log, createMemoryAi(openai)));

// ---------- デスクトップ常駐（状態・終了・自動起動の登録） ----------
app.use(
  '/api/desktop',
  desktopRouter({ state: desktop, appDir: APP_DIR, dataDir: DATA_DIR, port: PORT, version: APP_VERSION, desktopMode: DESKTOP_MODE, guard: memoryGuard, exit: (reason) => shutdown(reason), log }),
);

app.post('/api/session', requireLocalOrigin, express.json({ limit: '1kb' }), async (req, res) => {
  if (!req.is('application/json')) {
    sendError(res, 400, 'BAD_REQUEST', 'Content-Type が不正です。');
    return;
  }
  if (!openai) {
    sendError(
      res,
      503,
      'NO_API_KEY',
      'サーバーに OPENAI_API_KEY が設定されていません。.env を設定してサーバーを再起動してください。',
    );
    return;
  }
  if (activeLease) {
    sendError(res, 409, 'SESSION_BUSY', 'すでに会話中のセッションがあります。先に会話を終了してください。');
    return;
  }
  const now = Date.now();
  if (now - lastCreateAt < MIN_CREATE_INTERVAL_MS) {
    sendError(res, 429, 'RATE_LIMITED', '短時間に開始が繰り返されました。数秒待ってから再度お試しください。');
    return;
  }
  lastCreateAt = now;
  // 声の選択（許可リストにあるものだけ。無ければ .env の既定の声）
  const requestedVoice: unknown = req.body?.voice;
  const voice = isVoiceId(requestedVoice) ? requestedVoice : VOICE;
  // テレビ音声対策・話す速さ（許可された値だけ。無ければ従来どおり）
  const audioProfile: AudioProfileId = isAudioProfileId(req.body?.audioProfile) ? req.body.audioProfile : DEFAULT_AUDIO_PROFILE;
  const speechSpeed: SpeechSpeed = isSpeechSpeed(req.body?.speechSpeed) ? req.body.speechSpeed : DEFAULT_SPEECH_SPEED;
  const audio = applyAudioProfile(audioProfile, BASE_AUDIO);
  // KAITO.md と個人設定は会話のたびに読み直す（保存した変更は次の会話から反映）
  // 計測：サーバー内の内訳（Server-Timing ヘッダーでブラウザに返す。数値のみ）
  const tp = performance.now();
  const persona = sessionPersona(PERSONA_PATHS);
  const personaMs = performance.now() - tp;
  const tm = performance.now();
  const memoryPart = memoryInstructions();
  const memoryMs = performance.now() - tm;
  // 長期記憶の決まり・現在の日時・保存済みの好み（最大 5 件）を加える。待機中には何もしない（OpenAI へも接続しない）
  const instructions = `${persona.instructions}\n\n${memoryPart}`;
  const opts: SecretOptions = { voice, audio, speechSpeed, instructions };

  // 発行処理中に別リクエストが来ても 1 件に抑えるため、先にリースを確保する
  const id = randomUUID();
  const lease: Lease = {
    id,
    createdAt: now,
    timer: setTimeout(() => releaseLease(id, 'max-duration'), MAX_SESSION_SECONDS * 1000 + LEASE_GRACE_MS),
  };
  activeLease = lease;

  try {
    const ts = performance.now();
    let secret: { value: string; expires_at: number };
    if (CONNECT_MODE === 'direct') {
      // 直接接続：OpenAI への問い合わせはここでは行わない（接続の申し込み時に 1 回だけ）
      lease.localKey = `ek_local_${randomUUID().replace(/-/g, '')}`;
      lease.session = opts;
      secret = { value: lease.localKey, expires_at: Math.floor(Date.now() / 1000) + CLIENT_SECRET_TTL_SECONDS };
    } else {
      try {
        secret = await issueClientSecret(openai, reasoningAccepted ? REASONING_EFFORT : null, opts);
      } catch (err) {
        // reasoning 設定が原因の 400 なら、設定なしで 1 回だけ再試行（従来の正常動作を壊さないため）
        if (reasoningAccepted && err instanceof OpenAI.BadRequestError) {
          reasoningAccepted = false;
          log('reasoning setting rejected; retrying without it');
          secret = await issueClientSecret(openai, null, opts);
        } else {
          throw err;
        }
      }
    }
    const body: SessionGrant = {
      leaseId: id,
      clientSecret: secret.value,
      clientSecretExpiresAt: secret.expires_at,
      model: MODEL,
      voice,
      maxSessionSeconds: MAX_SESSION_SECONDS,
      turnDetection: audio.turnDetection,
      reasoningEffort: reasoningAccepted ? REASONING_EFFORT : null,
      inputNoiseReduction: audio.inputNoiseReduction,
      interruptResponse: audio.interruptResponse,
      transcriptionModel: TRANSCRIPTION,
      audioProfile,
      speechSpeed,
      instructions,
      greetingInstructions: persona.greetingInstructions,
      greetingText: persona.greetingText,
      ...(CONNECT_MODE === 'direct' ? { realtimeUrl: '/api/realtime/calls' } : REALTIME_WEBRTC_URL ? { realtimeUrl: REALTIME_WEBRTC_URL } : {}),
      connectMode: CONNECT_MODE,
    };
    res.setHeader('Server-Timing', `persona;dur=${personaMs.toFixed(1)}, memory;dur=${memoryMs.toFixed(1)}, secret;dur=${(performance.now() - ts).toFixed(1)}`);
    log(`session prepared (${CONNECT_MODE}) voice=${voice} audioProfile=${audioProfile} speed=${speechSpeed}`);
    res.json(body);
  } catch (err) {
    releaseLease(id, 'issue-failed');
    const status = err instanceof OpenAI.APIError ? err.status : undefined;
    log(`client secret issue failed: ${describeError(err)}`);
    if (status === 401 || status === 403) {
      sendError(res, 502, 'UPSTREAM_AUTH', 'OpenAI の認証に失敗しました。APIキーと権限を確認してください。');
    } else if (status === 429) {
      sendError(res, 502, 'UPSTREAM_ERROR', 'OpenAI 側の利用上限またはレート制限に達しました。課金設定・上限を確認してください。');
    } else {
      sendError(res, 502, 'UPSTREAM_ERROR', 'OpenAI への接続に失敗しました。ネットワークや設定を確認してください。');
    }
  }
});

/**
 * 直接接続：ブラウザの WebRTC の接続の申し込み（SDP offer）を、API キー付きで OpenAI に送り、応答（SDP answer）を返す。
 * 合言葉（会話開始時に渡した ek_local_…）が今の会話のものと一致するときだけ受け付ける。
 */
app.post('/api/realtime/calls', requireLocalOrigin, express.text({ type: 'application/sdp', limit: '64kb' }), async (req, res) => {
  const lease = activeLease;
  const auth = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!openai || !lease || !lease.localKey || !lease.session || auth !== lease.localKey || typeof req.body !== 'string' || !req.body.startsWith('v=')) {
    sendError(res, 403, 'FORBIDDEN_ORIGIN', '接続の申し込みを受け付けられませんでした。もう一度「会話開始」を押してください。');
    return;
  }
  lease.localKey = undefined; // 1 回限り
  const t = performance.now();
  const create = (effort: ReasoningEffort | null) =>
    openai.realtime.calls.create({
      sdp: req.body as string,
      session: buildRealtimeSession({
        model: MODEL,
        instructions: lease.session!.instructions,
        voice: lease.session!.voice,
        transcriptionModel: TRANSCRIPTION,
        effort,
        audio: lease.session!.audio,
        speechSpeed: lease.session!.speechSpeed,
      }),
    });
  try {
    let r: globalThis.Response;
    try {
      r = await create(reasoningAccepted ? REASONING_EFFORT : null);
    } catch (err) {
      if (reasoningAccepted && err instanceof OpenAI.BadRequestError) {
        reasoningAccepted = false;
        log('reasoning setting rejected; retrying without it');
        r = await create(null);
      } else throw err;
    }
    const answer = await r.text();
    const callId = (r.headers.get('location') ?? '').split('/').pop() || undefined;
    if (callId && activeLease === lease) lease.callId = callId;
    lease.sdpMs = performance.now() - t;
    log(`realtime call created (${Math.round(lease.sdpMs)}ms)`);
    res.status(201).setHeader('Content-Type', 'application/sdp');
    if (callId) res.setHeader('Location', `/v1/realtime/calls/${callId}`);
    res.send(answer);
  } catch (err) {
    const status = err instanceof OpenAI.APIError ? err.status : undefined;
    log(`realtime call failed: ${describeError(err)}`);
    if (status === 401 || status === 403) sendError(res, 502, 'UPSTREAM_AUTH', 'OpenAI の認証に失敗しました。APIキーと権限を確認してください。');
    else if (status === 429) sendError(res, 502, 'UPSTREAM_ERROR', 'OpenAI 側の利用上限またはレート制限に達しました。');
    else sendError(res, 502, 'UPSTREAM_ERROR', 'OpenAI への接続に失敗しました。');
  }
});

/** 計測：接続の申し込み（SDP）にかかった時間 */
app.get('/api/session/:leaseId/timing', (req, res) => {
  const lease = activeLease;
  res.json(lease && lease.id === req.params.leaseId ? { sdpMs: lease.sdpMs ?? null } : { sdpMs: null });
});

/** クライアントが WebRTC 接続後に call_id を通知する（最大時間超過時のサーバー側切断用） */
app.post('/api/session/:leaseId/call', requireLocalOrigin, express.json({ limit: '1kb' }), (req, res) => {
  const lease = activeLease;
  const callId: unknown = req.body?.callId;
  if (!lease || lease.id !== req.params.leaseId) {
    sendError(res, 404, 'NOT_FOUND', 'セッションが見つかりません。');
    return;
  }
  if (typeof callId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(callId)) {
    sendError(res, 400, 'BAD_REQUEST', 'call_id が不正です。');
    return;
  }
  lease.callId = callId;
  res.status(204).end();
});

/** 会話終了の通知（navigator.sendBeacon からも呼ばれるため本文は不要） */
app.post('/api/session/:leaseId/end', requireLocalOrigin, (req, res) => {
  releaseLease(req.params.leaseId as string, 'client-end');
  res.status(204).end();
});

// ビルド済みフロントエンド（npm start 時）
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/client');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.use('/api', (_req, res) => sendError(res, 404, 'NOT_FOUND', '見つかりません。'));

// 本文やヘッダーを含めずにエラーを記録する
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log(`unhandled error: ${describeError(err)}`);
  if (!res.headersSent) sendError(res, 500, 'INTERNAL', 'サーバー内部エラーが発生しました。');
});

const server = app.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`OPENAI_API_KEY: ${openai ? '設定済み' : '未設定（UI とエラー表示の確認のみ可能）'}`);
  log(`model=${MODEL} voice=${VOICE} maxSessionSeconds=${MAX_SESSION_SECONDS}`);
  log(`turnDetection=${JSON.stringify(TURN_DETECTION)} reasoningEffort=${REASONING_EFFORT ?? 'n/a'}`);
  log(`inputNoiseReduction=${INPUT_NOISE_REDUCTION ?? 'off'} interruptResponse=${INTERRUPT_RESPONSE ?? 'default'} transcription=${TRANSCRIPTION}`);
  log(`memory: ${memory.store ? `有効（保存先 ${memory.dbPath}）` : `無効：${memory.error}`}`);
  for (const w of memory.warnings) log(`memory: ${w}`);
  if (personaMigrated) log(`persona: 以前の個人設定を ${PERSONA_PATHS.local} に引き継ぎました（元のファイルは残しています）`);
  writeLock(DATA_DIR, { pid: process.pid, port: PORT, instanceId: desktop.instanceId, startedAt: desktop.startedAt, appDir: APP_DIR, version: APP_VERSION });
  log(`instance: pid=${process.pid} version=${APP_VERSION} desktop=${DESKTOP_MODE}`);
});
server.on('error', (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  log(code === 'EADDRINUSE' ? `起動できません：ポート ${PORT} はほかのアプリが使用しています` : `server error: ${describeError(err)}`);
  process.exit(code === 'EADDRINUSE' ? 2 : 1);
});

let exiting = false;
/** 終了：会話の切断 → 記憶（SQLite）を閉じて保存を確定 → ロック削除 → サーバー停止 */
function shutdown(reason = 'signal'): void {
  if (exiting) return;
  exiting = true;
  log(`shutdown (${reason})`);
  if (activeLease) releaseLease(activeLease.id, 'shutdown');
  try {
    memory.store?.close();
  } catch {
    /* 終了時は無視 */
  }
  removeLock(DATA_DIR, desktop.instanceId);
  server.close(() => process.exit(0));
  // 会話の切断（hangup）の送信を少し待ってから終了する
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------- OpenAI 呼び出し ----------
interface SecretOptions {
  voice: string;
  audio: ConversationAudio;
  speechSpeed: SpeechSpeed;
  instructions: string;
}

function issueClientSecret(client: OpenAI, effort: ReasoningEffort | null, o: SecretOptions) {
  return client.realtime.clientSecrets.create({
    expires_after: { anchor: 'created_at', seconds: CLIENT_SECRET_TTL_SECONDS },
    session: buildRealtimeSession({
      model: MODEL,
      instructions: o.instructions,
      voice: o.voice,
      transcriptionModel: TRANSCRIPTION,
      effort,
      audio: o.audio,
      speechSpeed: o.speechSpeed,
    }),
  });
}

/**
 * VAD（発話の区切り検出）設定。
 * 既定は semantic_vad（発話内容から「言い終わり」を判定するため、途中で割り込みにくい）。
 */
function turnDetectionFromEnv(): TurnDetectionSetting {
  const mode = enumEnv('VAD_MODE', ['semantic', 'server'] as const, 'semantic');
  if (mode === 'server') {
    return {
      type: 'server_vad',
      silenceDurationMs: intEnv('VAD_SILENCE_MS', 700, 200, 2000),
      prefixPaddingMs: 300,
      threshold: intEnv('VAD_THRESHOLD_PERCENT', 50, 10, 95) / 100,
    };
  }
  return { type: 'semantic_vad', eagerness: enumEnv('VAD_EAGERNESS', ['low', 'medium', 'high', 'auto'] as const, 'medium') };
}

// ---------- ユーティリティ ----------
function enumEnv<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function sendError(res: Response, status: number, code: ApiErrorBody['code'], message: string): void {
  const body: ApiErrorBody = { code, message };
  res.status(status).json(body);
}

/** エラー内容を秘密情報抜きで要約する（メッセージ本文は出さない） */
function describeError(err: unknown): string {
  if (err instanceof OpenAI.APIError) {
    return `${err.constructor.name} status=${err.status ?? 'n/a'} type=${err.type ?? 'n/a'}`;
  }
  if (err instanceof Error) return err.name;
  return 'unknown';
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function strEnv(name: string, fallback: string): string {
  const v = (process.env[name] ?? '').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : fallback;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
