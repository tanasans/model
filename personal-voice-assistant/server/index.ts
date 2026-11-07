/**
 * ローカル専用 API サーバー。
 * - 通常の OpenAI API キーは環境変数（.env）からのみ読み込み、クライアントへは渡さない。
 * - クライアントには POST /v1/realtime/client_secrets（GA）で発行した短命 client secret のみを返す。
 * - 同時セッション数 1、最大継続時間、作成間隔の制限で予期しない課金増を抑える。
 * - ログには APIキー・トークン・音声・会話内容を出力しない。
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { previewVoice, PreviewError } from './voicePreview.js';
import OpenAI from 'openai';
import {
  ASSISTANT_INSTRUCTIONS,
  TRANSCRIPTION_MODEL,
  type ApiErrorBody,
  type HealthInfo,
  isVoiceId,
  PREVIEW_SAMPLES,
  type ReasoningEffort,
  type SessionGrant,
  type TurnDetectionSetting,
} from '../shared/assistant.js';

// ---------- 設定 ----------
const HOST = '127.0.0.1'; // ローカルホストのみ。外部公開しない。
const PORT = intEnv('PORT', 8787, 1, 65535);
const MODEL = strEnv('REALTIME_MODEL', 'gpt-realtime-2.1');
const VOICE = strEnv('REALTIME_VOICE', 'marin');
const MAX_SESSION_SECONDS = intEnv('MAX_SESSION_SECONDS', 300, 30, 1800);
const TURN_DETECTION = turnDetectionFromEnv();
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
  };
  res.json(body);
});

// ---------- 声の試聴（会話と同じ Realtime API を使うため、料金がかかる） ----------
const MIN_PREVIEW_INTERVAL_MS = 4_000;
let previewBusy = false;
let lastPreviewAt = 0;

app.post('/api/voice-preview', requireLocalOrigin, express.json({ limit: '1kb' }), async (req, res) => {
  const voice: unknown = req.body?.voice;
  const sample = PREVIEW_SAMPLES.find((x) => x.id === req.body?.sampleId);
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
      instructions: ASSISTANT_INSTRUCTIONS,
      url: process.env.REALTIME_WS_URL || undefined,
      reasoningEffort: reasoningAccepted ? REASONING_EFFORT : null,
    });
    log(`voice preview ok voice=${voice} firstAudioMs=${r.firstAudioMs} totalMs=${r.totalMs}`);
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

  // 発行処理中に別リクエストが来ても 1 件に抑えるため、先にリースを確保する
  const id = randomUUID();
  const lease: Lease = {
    id,
    createdAt: now,
    timer: setTimeout(() => releaseLease(id, 'max-duration'), MAX_SESSION_SECONDS * 1000 + LEASE_GRACE_MS),
  };
  activeLease = lease;

  try {
    let secret: Awaited<ReturnType<typeof issueClientSecret>>;
    try {
      secret = await issueClientSecret(openai, reasoningAccepted ? REASONING_EFFORT : null, voice);
    } catch (err) {
      // reasoning 設定が原因の 400 なら、設定なしで 1 回だけ再試行（従来の正常動作を壊さないため）
      if (reasoningAccepted && err instanceof OpenAI.BadRequestError) {
        reasoningAccepted = false;
        log('reasoning setting rejected; retrying without it');
        secret = await issueClientSecret(openai, null, voice);
      } else {
        throw err;
      }
    }
    const body: SessionGrant = {
      leaseId: id,
      clientSecret: secret.value,
      clientSecretExpiresAt: secret.expires_at,
      model: MODEL,
      voice,
      maxSessionSeconds: MAX_SESSION_SECONDS,
      turnDetection: TURN_DETECTION,
      reasoningEffort: reasoningAccepted ? REASONING_EFFORT : null,
    };
    log('client secret issued');
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
});
server.on('error', (err) => {
  log(`server error: ${describeError(err)}`);
  process.exit(1);
});

function shutdown(): void {
  if (activeLease) releaseLease(activeLease.id, 'shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------- OpenAI 呼び出し ----------
function issueClientSecret(client: OpenAI, effort: ReasoningEffort | null, voice: string) {
  const td = TURN_DETECTION;
  return client.realtime.clientSecrets.create({
    expires_after: { anchor: 'created_at', seconds: CLIENT_SECRET_TTL_SECONDS },
    session: {
      type: 'realtime',
      model: MODEL,
      instructions: ASSISTANT_INSTRUCTIONS,
      output_modalities: ['audio'],
      ...(effort ? { reasoning: { effort } } : {}),
      audio: {
        input: {
          transcription: { model: TRANSCRIPTION_MODEL, language: 'ja' },
          turn_detection:
            td.type === 'semantic_vad'
              ? { type: 'semantic_vad', eagerness: td.eagerness }
              : {
                  type: 'server_vad',
                  silence_duration_ms: td.silenceDurationMs,
                  prefix_padding_ms: td.prefixPaddingMs,
                  threshold: td.threshold,
                },
        },
        output: { voice },
      },
    },
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
