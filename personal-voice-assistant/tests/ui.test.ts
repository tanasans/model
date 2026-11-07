import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCoreView, type CoreInputs } from '../src/ui/coreState.ts';

const base: CoreInputs = {
  phase: 'idle',
  triggering: false,
  server: 'up',
  apiKeyConfigured: true,
  voiceError: null,
  testMode: false,
  wake: { on: false, status: 'off', error: null, mode: 'both' },
  clap: { on: false, status: 'off', error: null },
};
const v = (p: Partial<CoreInputs>) => deriveCoreView({ ...base, ...p });

test('何も ON でなければ STANDBY（聞いていないのに LISTENING と表示しない）', () => {
  assert.equal(v({}).state, 'STANDBY');
  // ON にしただけでまだマイク準備中なら LISTENING にしない
  assert.equal(v({ wake: { ...base.wake, on: true, status: 'loading' } }).state, 'STANDBY');
  assert.match(v({ wake: { ...base.wake, on: true, status: 'loading' } }).sub, /読込中/);
});

test('実際に聞いている間だけ LISTENING。説明文は有効な起動方法だけを書く', () => {
  const both = v({ wake: { ...base.wake, on: true, status: 'listening', mode: 'nee' }, clap: { on: true, status: 'listening', error: null } });
  assert.equal(both.state, 'LISTENING');
  assert.equal(both.hint, '『ねえ、カイト』または拍手2回で起動します');
  const clapOnly = v({ clap: { on: true, status: 'first-clap', error: null } });
  assert.equal(clapOnly.hint, '拍手2回で起動します');
  assert.equal(clapOnly.sub, '1回目の拍手を検知');
  assert.match(v({ testMode: true, clap: { on: true, status: 'listening', error: null } }).hint, /テストモード/);
});

test('会話中・起動中は ACTIVE', () => {
  assert.equal(v({ phase: 'connected' }).state, 'ACTIVE');
  assert.equal(v({ triggering: true }).sub, '起動中');
  assert.equal(v({ phase: 'connecting' }).sub, 'OpenAI に接続中');
});

test('エラーは ERROR として理由を表示（サーバー停止・モデル未設置・会話エラー）', () => {
  assert.equal(v({ server: 'down' }).state, 'ERROR');
  const nm = v({ wake: { ...base.wake, on: true, status: 'not-installed' } });
  assert.equal(nm.state, 'ERROR');
  assert.match(nm.hint, /setup:wake/);
  assert.equal(v({ voiceError: 'APIキーがありません' }).hint, 'APIキーがありません');
  // 音声待機が OFF ならモデル未設置はエラー扱いしない
  assert.equal(v({ wake: { ...base.wake, on: false, status: 'not-installed' } }).state, 'STANDBY');
});

test('会話中は他のエラーより ACTIVE を優先', () => {
  assert.equal(v({ phase: 'connected', voiceError: 'x' }).state, 'ACTIVE');
});

test('接続処理中だけ connecting（外周の光）を出す。会話中・待機中は出さない', () => {
  assert.equal(v({ phase: 'connecting' }).connecting, true);
  assert.equal(v({ triggering: true }).connecting, true);
  assert.equal(v({ phase: 'connected' }).connecting, false);
  assert.equal(v({ clap: { on: true, status: 'listening', error: null } }).connecting, false);
});
