import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { previewVoice, PreviewError } from '../server/voicePreview.ts';

/** Realtime API の代わりに動く模擬サーバー（実際の通信はしない） */
function mockRealtime(behavior: 'ok' | 'error' | 'silent') {
  const wss = new WebSocketServer({ port: 0 });
  const seen: { auth?: string; model?: string; events: Array<Record<string, unknown>> } = { events: [] };
  wss.on('connection', (ws, req) => {
    seen.auth = req.headers.authorization;
    seen.model = new URL(req.url!, 'http://x').searchParams.get('model') ?? undefined;
    ws.on('message', (raw) => {
      const ev = JSON.parse(String(raw));
      seen.events.push(ev);
      if (ev.type !== 'response.create') return;
      if (behavior === 'error') ws.send(JSON.stringify({ type: 'error', error: { code: 'invalid_value' } }));
      if (behavior === 'ok') {
        const pcm = Buffer.alloc(24000 * 2); // 1 秒の無音
        for (let i = 0; i < 4; i++) ws.send(JSON.stringify({ type: 'response.output_audio.delta', delta: pcm.subarray(i * 12000, (i + 1) * 12000).toString('base64') }));
        ws.send(JSON.stringify({ type: 'response.done' }));
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  return { url: `ws://127.0.0.1:${port}`, seen, close: () => wss.close() };
}

const base = { apiKey: 'sk-test', model: 'gpt-realtime-2.1', voice: 'cedar', text: 'お呼びでしょうか。カイトです。', instructions: 'KAITO' };

test('試聴: 指定の声・固定文で要求し、WAV と応答速度を返す', async () => {
  const m = mockRealtime('ok');
  try {
    const r = await previewVoice({ ...base, url: m.url });
    assert.equal(m.seen.auth, 'Bearer sk-test');
    assert.equal(m.seen.model, 'gpt-realtime-2.1');
    const upd = m.seen.events.find((e) => e.type === 'session.update') as { session: { audio: { output: { voice: string } }; max_output_tokens: number } };
    assert.equal(upd.session.audio.output.voice, 'cedar');
    assert.ok(upd.session.max_output_tokens <= 600, '出力トークン上限あり');
    assert.match(JSON.stringify(m.seen.events.find((e) => e.type === 'conversation.item.create')), /お呼びでしょうか。カイトです。/);
    assert.equal(r.wav.subarray(0, 4).toString(), 'RIFF');
    assert.equal(r.wav.length, 44 + 48000);
    assert.ok(Math.abs(r.audioSeconds - 1) < 0.01);
    assert.ok(r.firstAudioMs >= 0 && r.totalMs >= r.firstAudioMs);
  } finally {
    m.close();
  }
});

test('試聴: API がエラーを返したら理由付きで失敗する', async () => {
  const m = mockRealtime('error');
  try {
    await assert.rejects(previewVoice({ ...base, url: m.url }), (e) => e instanceof PreviewError && e.code === 'UPSTREAM_ERROR' && /invalid_value/.test(e.message));
  } finally {
    m.close();
  }
});

test('試聴: 応答がなければ時間切れで接続を閉じる', async () => {
  const m = mockRealtime('silent');
  try {
    await assert.rejects(previewVoice({ ...base, url: m.url, timeoutMs: 300 }), (e) => e instanceof PreviewError && e.code === 'TIMEOUT');
  } finally {
    m.close();
  }
});

test('試聴: 接続先が無ければ接続エラー', async () => {
  await assert.rejects(previewVoice({ ...base, url: 'ws://127.0.0.1:9', timeoutMs: 2000 }), (e) => e instanceof PreviewError);
});
