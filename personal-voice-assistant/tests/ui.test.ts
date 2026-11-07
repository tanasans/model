import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCoreView, type CoreInputs } from '../src/ui/coreState.ts';

const base: CoreInputs = {
  phase: 'idle',
  triggering: false,
  server: 'up',
  apiKeyConfigured: true,
  voiceError: null,
  wake: { on: false, status: 'off', error: null },
  clap: { on: false, status: 'off', error: null },
};
const v = (p: Partial<CoreInputs>) => deriveCoreView({ ...base, ...p });
const all = (p: Partial<CoreInputs>) => {
  const r = v(p);
  return `${r.sub} ${r.notice ?? ''}`;
};

test('起動方法の説明文は一切出さない（どの状態でも）', () => {
  const cases: Partial<CoreInputs>[] = [
    {},
    { wake: { on: true, status: 'listening', error: null } },
    { clap: { on: true, status: 'listening', error: null } },
    { wake: { on: true, status: 'listening', error: null }, clap: { on: true, status: 'listening', error: null } },
    { phase: 'connected' },
  ];
  for (const c of cases) assert.doesNotMatch(all(c), /起動します|ねえ、カイト|拍手2回|テストモード|押してください|ON にすると/);
});

test('実際に聞いている間だけ LISTENING。拍手 1 回目は短く通知', () => {
  assert.equal(v({}).state, 'STANDBY');
  assert.equal(v({ wake: { on: true, status: 'loading', error: null } }).state, 'STANDBY');
  assert.equal(v({ wake: { on: true, status: 'listening', error: null } }).state, 'LISTENING');
  assert.equal(v({ wake: { on: true, status: 'listening', error: null } }).sub, '');
  assert.equal(v({ clap: { on: true, status: 'first-clap', error: null } }).sub, '拍手 1');
});

test('会話中・起動中は ACTIVE、接続処理中だけ connecting', () => {
  assert.equal(v({ phase: 'connected' }).state, 'ACTIVE');
  assert.equal(v({ phase: 'connected' }).connecting, false);
  assert.equal(v({ phase: 'connecting' }).connecting, true);
  assert.equal(v({ triggering: true }).sub, '起動');
  assert.equal(v({ phase: 'connected', voiceError: 'x' }).state, 'ACTIVE');
});

test('エラーは ERROR と短い通知（長文は最初の文だけ）', () => {
  assert.equal(v({ server: 'down' }).state, 'ERROR');
  const nm = v({ wake: { on: true, status: 'not-installed', error: null } });
  assert.equal(nm.state, 'ERROR');
  assert.match(nm.notice!, /setup:wake/);
  const long = v({ voiceError: 'サーバーに OPENAI_API_KEY が設定されていません。.env を設定してサーバーを再起動してください。' });
  assert.equal(long.notice, 'サーバーに OPENAI_API_KEY が設定されていません');
  assert.equal(v({ wake: { on: false, status: 'not-installed', error: null } }).state, 'STANDBY');
});
