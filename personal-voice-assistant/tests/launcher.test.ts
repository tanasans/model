import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error ランチャーは JavaScript（ビルド不要）
import { acquireLaunchLock, autostartCommand, dataDir, inspect, pidAlive } from '../launcher/lib.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'kaito-launch-'));
async function server(handler: (url: string) => [number, string]): Promise<{ port: number; close: () => void }> {
  const s = createServer((q, r) => {
    const [code, body] = handler(q.url ?? '');
    r.writeHead(code, { 'Content-Type': 'application/json' });
    r.end(body);
  });
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', res));
  return { port: (s.address() as { port: number }).port, close: () => s.close() };
}

test('ランチャー: 保存先はサーバーと同じユーザー専用フォルダ（Windows は %LOCALAPPDATA%\\KAITO）', () => {
  assert.equal(dataDir({ LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }, 'win32', 'C:\\Users\\t'), 'C:\\Users\\t\\AppData\\Local\\KAITO');
  assert.equal(dataDir({}, 'linux', '/home/t'), '/home/t/.local/share/kaito');
});

test('ランチャー: 起動の担当は 1 つだけ（連続クリック）。古い担当（終了したプロセス）は取り直す', () => {
  const dir = tmp();
  const a = acquireLaunchLock(dir);
  assert.ok(a);
  assert.equal(acquireLaunchLock(dir), null, '2 つ目は取れない');
  a!.release();
  const b = acquireLaunchLock(dir);
  assert.ok(b, '解放後は取れる');
  b!.release();
  writeFileSync(path.join(dir, 'kaito-launch.lock'), JSON.stringify({ pid: 999_999_9, at: Date.now() }));
  assert.ok(acquireLaunchLock(dir), '終了したプロセスの担当は取り直す');
});

test('ランチャー: 状態の判定（起動中・異常終了の跡・ほかのアプリが使用中・空き）', async () => {
  const dir = tmp();
  const kaito = await server(() => [200, JSON.stringify({ app: 'kaito', instanceId: 'abc', pid: process.pid, uiOpen: false })]);
  writeFileSync(path.join(dir, 'kaito-server.json'), JSON.stringify({ pid: process.pid, port: kaito.port, instanceId: 'abc' }));
  assert.equal((await inspect(dir, kaito.port)).state, 'running');
  kaito.close();

  const dead = tmp();
  writeFileSync(path.join(dead, 'kaito-server.json'), JSON.stringify({ pid: 999_999_9, port: 1, instanceId: 'x' }));
  const freePort = 1; // 特権ポート：接続できない＝空き扱い
  assert.equal((await inspect(dead, freePort)).state, 'stale', '異常終了の跡（PID が終了）');

  const foreign = await server(() => [200, '<html>other</html>']);
  assert.equal((await inspect(tmp(), foreign.port)).state, 'port-busy', 'KAITO 以外が使用中');
  foreign.close();

  // ロックの PID は生きているが、別の識別子が応答（PID の再利用）→ 起動中とはみなさずポートで判定
  const reused = tmp();
  const other = await server(() => [200, JSON.stringify({ app: 'kaito', instanceId: 'new', pid: 1 })]);
  writeFileSync(path.join(reused, 'kaito-server.json'), JSON.stringify({ pid: process.pid, port: other.port + 1, instanceId: 'old' }));
  assert.equal((await inspect(reused, other.port)).state, 'running', 'ポートで応答している KAITO を使う');
  other.close();
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(999_999_9), false);
});

test('ランチャー: 自動起動のコマンドは、空白を含むパスも引用符で囲む', () => {
  const c = autostartCommand('C:\\Users\\t\\KAITO app', 'C:\\Program Files\\nodejs\\node.exe');
  assert.match(c, /^"C:\\Program Files\\nodejs\\node\.exe" ".*KAITO app.*kaito-launcher\.mjs" start --autostart$/);
});
