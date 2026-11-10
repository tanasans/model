import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrewarm } from '../server/realtime/prewarm.js';

test('事前ウォームアップ：API キーなしの HEAD を 1 回だけ送り、60 秒以内は繰り返さない', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let clock = 1_000_000;
  const logs: string[] = [];
  const p = createPrewarm({
    url: 'https://api.openai.com/v1/models',
    log: (m) => logs.push(m),
    now: () => clock,
    fetchFn: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 401 });
    }) as unknown as typeof fetch,
  });
  const [a, b] = await Promise.all([p.warm('startup'), p.warm('startup')]);
  assert.equal(calls.length, 1, '同時に呼ばれても 1 回');
  assert.equal(typeof a, 'number');
  assert.equal(a, b);
  assert.equal(calls[0]!.init?.method, 'HEAD');
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.get('authorization'), null, 'API キーを送らない');
  assert.equal(calls[0]!.init?.body, undefined, '内容を送らない');
  clock += 30_000;
  assert.equal(await p.warm('resume'), null);
  assert.equal(calls.length, 1, '60 秒以内は送らない');
  clock += 31_000;
  await p.warm('resume');
  assert.equal(calls.length, 2);
  assert.ok(logs.every((l) => !/sk-|Bearer/i.test(l)));
});

test('事前ウォームアップ：失敗しても例外にならない', async () => {
  const p = createPrewarm({ url: 'https://x.invalid/', log: () => undefined, fetchFn: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
  assert.equal(await p.warm('startup'), null);
});

test('事前ウォームアップ：待機中に定期的には送らない（起動時とスリープ復帰時だけ）', () => {
  const src = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const uses = src.match(/PREWARM\.warm\(/g) ?? [];
  assert.equal(uses.length, 1, '起動時の 1 か所だけ（復帰時は watchResume が判定）');
  assert.match(src, /REALTIME_PREWARM/);
});

test('接続中の挨拶：設定は既定 ON・起動音の後に流す・挨拶中はマイクを止める', () => {
  const src = readFileSync(new URL('../src/useVoiceSession.ts', import.meta.url), 'utf8');
  assert.match(src, /options\.muteMicUntil \?\? 0\) - performance\.now\(\)/, '起動音の鳴り終わりを待つ');
  assert.match(src, /muteFor\(micStream, ms \+ 150\)/, '挨拶中はマイクの音を送らない');
  assert.match(src, /signalingState === 'stable'[\s\S]{0,80}startEarlyGreeting\(\)/, '接続の応答が届いたら挨拶');
});
