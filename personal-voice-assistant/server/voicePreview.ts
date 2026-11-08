/**
 * 声の試聴（サーバー側）。会話と同じ Realtime API・同じモデルで、固定の短い文を指定の声で読み上げ、WAV で返す。
 * - API キーはサーバー内だけで使い、ブラウザには渡さない
 * - 読み上げる文は固定（任意の文章は受け付けない）、出力トークン上限・タイムアウトあり
 * - ログに音声・文章は出さない
 */
import WebSocket from 'ws';

export interface PreviewOptions {
  apiKey: string;
  model: string;
  voice: string;
  text: string;
  instructions: string;
  /** テスト用に差し替え可能（既定: wss://api.openai.com/v1/realtime） */
  url?: string;
  timeoutMs?: number;
  reasoningEffort?: string | null;
  /** 話す速さ（1 または未指定なら送らない＝従来どおり） */
  speed?: number;
}

export interface PreviewResult {
  wav: Buffer;
  /** 要求から最初の音声が届くまで（ms）＝応答速度の目安 */
  firstAudioMs: number;
  totalMs: number;
  audioSeconds: number;
}

export class PreviewError extends Error {
  constructor(
    readonly code: 'UPSTREAM_AUTH' | 'UPSTREAM_ERROR' | 'TIMEOUT',
    message: string,
  ) {
    super(message);
  }
}

const SAMPLE_RATE = 24_000;

export function previewVoice(o: PreviewOptions): Promise<PreviewResult> {
  const url = `${o.url ?? 'wss://api.openai.com/v1/realtime'}?model=${encodeURIComponent(o.model)}`;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${o.apiKey}` } });
    const chunks: Buffer[] = [];
    let firstAudioMs = -1;
    let settled = false;
    const finish = (err: PreviewError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* 既に閉じている */
      }
      if (err) return reject(err);
      const pcm = Buffer.concat(chunks);
      if (pcm.length === 0) return reject(new PreviewError('UPSTREAM_ERROR', '音声が返されませんでした。'));
      resolve({ wav: pcmToWav(pcm, SAMPLE_RATE), firstAudioMs, totalMs: Date.now() - started, audioSeconds: pcm.length / 2 / SAMPLE_RATE });
    };
    const timer = setTimeout(() => finish(new PreviewError('TIMEOUT', '試聴の応答がありませんでした（時間切れ）。')), o.timeoutMs ?? 20_000);

    ws.on('unexpected-response', (_req, res) => {
      finish(
        res.statusCode === 401 || res.statusCode === 403
          ? new PreviewError('UPSTREAM_AUTH', 'OpenAI の認証に失敗しました。')
          : new PreviewError('UPSTREAM_ERROR', `OpenAI への接続に失敗しました（HTTP ${res.statusCode}）。`),
      );
    });
    ws.on('error', () => finish(new PreviewError('UPSTREAM_ERROR', 'OpenAI への接続に失敗しました。')));
    ws.on('close', () => finish(new PreviewError('UPSTREAM_ERROR', '接続が途中で閉じられました。')));
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: o.instructions,
            output_modalities: ['audio'],
            max_output_tokens: 600,
            ...(o.reasoningEffort ? { reasoning: { effort: o.reasoningEffort } } : {}),
            audio: { output: { voice: o.voice, format: { type: 'audio/pcm', rate: SAMPLE_RATE }, ...(o.speed && o.speed !== 1 ? { speed: o.speed } : {}) } },
          },
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `次の一文を、KAITOとして自然に読み上げてください。言い換えや付け足しはしないでください。\n「${o.text}」` }],
          },
        }),
      );
      ws.send(JSON.stringify({ type: 'response.create' }));
    });
    ws.on('message', (data) => {
      let ev: { type?: string; delta?: string; error?: { code?: string } };
      try {
        ev = JSON.parse(String(data));
      } catch {
        return;
      }
      if (ev.type === 'response.output_audio.delta' && typeof ev.delta === 'string') {
        if (firstAudioMs < 0) firstAudioMs = Date.now() - started;
        chunks.push(Buffer.from(ev.delta, 'base64'));
      } else if (ev.type === 'response.done') {
        finish(null);
      } else if (ev.type === 'error') {
        finish(new PreviewError('UPSTREAM_ERROR', `OpenAI からエラーが返されました（${ev.error?.code ?? '詳細不明'}）。`));
      }
    });
  });
}

/** PCM16 モノラルを WAV に包む */
export function pcmToWav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
