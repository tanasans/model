#!/usr/bin/env node
/**
 * KAITO デスクトップ ランチャー（デスクトップのアイコン・Windows の自動起動から呼ばれる）。
 *
 *   node launcher/kaito-launcher.mjs start [--autostart]  起動（すでに動いていれば画面を前に出す）
 *   node launcher/kaito-launcher.mjs stop                 終了（待機・マイク・会話を止め、記憶を保存してからサーバーを止める）
 *   node launcher/kaito-launcher.mjs status               状態を表示
 *   node launcher/kaito-launcher.mjs install              ビルド済みか確認し、デスクトップのショートカットを作る（作り直す）
 *   node launcher/kaito-launcher.mjs uninstall            ショートカットと自動起動の登録を消す
 *   node launcher/kaito-launcher.mjs autostart on|off|status
 *
 * 本番用の起動：ビルド済みの画面（dist/client）をサーバーが配信する。開発用の監視（tsx watch・Vite）は使わない。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLaunchLock,
  autostartCommand,
  dataDir,
  DEFAULT_PORT,
  focusUi,
  inspect,
  isKaitoServerProcess,
  logDir,
  logLauncher,
  openUi,
  pidAlive,
  probe,
  readLock,
  RUN_KEY,
  showMessage,
} from './lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.KAITO_PORT) || DEFAULT_PORT;
const DIR = dataDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(instanceId, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const h = await probe(PORT, 1000);
    if (h && !h.foreign && (!instanceId || h.instanceId === instanceId)) return h;
    await sleep(300);
  }
  return null;
}

function fail(message, detail = {}) {
  logLauncher('start-failed', { message, ...detail });
  showMessage(`KAITO を起動できませんでした。\n\n${message}\n\nログ：${logDir(DIR)}`);
  process.exitCode = 1;
}

async function start(autostart) {
  const url = `http://localhost:${PORT}/?launch=${autostart ? 'autostart' : 'desktop'}`;
  const st = await inspect(DIR, PORT);
  if (st.state === 'running') {
    // すでに起動している：新しいサーバーは作らず、画面を前に出す（無ければ開く）
    logLauncher('already-running', { pid: st.lock?.pid, port: PORT });
    if (autostart) return; // ログイン時に二重で開かない
    if (!(st.health?.uiOpen && focusUi())) openUi(url);
    return;
  }
  if (st.state === 'port-busy') return fail(`ポート ${PORT} を KAITO 以外のアプリが使用しています。そのアプリを終了するか、環境変数 KAITO_PORT で別のポートを指定してください。`);

  const launch = acquireLaunchLock(DIR);
  if (!launch) {
    // ほかのランチャーが起動中（連続クリック）：起動が終わるのを待って画面を出すだけ
    logLauncher('launch-in-progress');
    const h = await waitReady(null);
    if (h && !autostart && !(h.uiOpen && focusUi())) openUi(url);
    return;
  }
  try {
    // 担当を取った後にもう一度確認する（ほかのランチャーが直前に起動を終えていた場合）
    const again = await inspect(DIR, PORT);
    if (again.state === 'running') {
      logLauncher('already-running', { pid: again.lock?.pid, port: PORT });
      if (!autostart && !(again.health?.uiOpen && focusUi())) openUi(url);
      return;
    }
    if (st.state === 'stale') {
      logLauncher('stale-lock-removed', { pid: st.lock?.pid });
      rmSync(path.join(DIR, 'kaito-server.json'), { force: true });
    }
    if (!existsSync(path.join(APP_DIR, 'dist', 'client', 'index.html'))) {
      return fail('画面がビルドされていません。PowerShell で KAITO のフォルダに移動し、npm.cmd run desktop:install を実行してください。');
    }
    if (!existsSync(path.join(APP_DIR, 'node_modules', 'tsx'))) {
      return fail('必要なパッケージがありません。KAITO のフォルダで npm.cmd install を実行してください。');
    }
    mkdirSync(logDir(DIR), { recursive: true });
    const out = openSync(path.join(logDir(DIR), 'server.log'), 'a');
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: APP_DIR,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, PORT: String(PORT), KAITO_DESKTOP: '1', NODE_ENV: 'production' },
    });
    child.unref();
    logLauncher('server-spawned', { pid: child.pid, port: PORT, autostart });
    const h = await waitReady(null);
    if (!h) return fail('サーバーが 45 秒以内に起動しませんでした。ログ（server.log）を確認してください。', { pid: child.pid });
    logLauncher('server-ready', { pid: h.pid, port: PORT });
    openUi(url);
  } finally {
    launch.release();
  }
}

async function stop() {
  const lock = readLock(DIR);
  const st = await inspect(DIR, PORT);
  if (st.state !== 'running') {
    if (lock && !pidAlive(lock.pid)) rmSync(path.join(DIR, 'kaito-server.json'), { force: true });
    logLauncher('stop-not-running');
    console.log('KAITO は起動していません。');
    return;
  }
  const pid = st.health?.pid ?? st.lock?.pid;
  // 通常の終了：画面に待機・マイク・会話の停止を伝え、記憶を保存してからサーバーが自分で終了する
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/desktop/shutdown`, { method: 'POST', headers: { Origin: `http://localhost:${PORT}` } });
  } catch {
    /* 応答前に終了した場合も続ける */
  }
  for (let i = 0; i < 50 && pidAlive(pid); i++) await sleep(200);
  if (pidAlive(pid)) {
    // 通常の終了に失敗：KAITO のサーバーであることを確認してから強制終了する（ほかの Node.js は終了しない）
    if (isKaitoServerProcess(pid)) {
      logLauncher('force-kill', { pid });
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      else process.kill(pid, 'SIGKILL');
    } else {
      logLauncher('force-kill-refused', { pid });
      showMessage(`KAITO のサーバー（PID ${pid}）を終了できませんでした。KAITO のプロセスか確認できないため、強制終了はしていません。`);
      process.exitCode = 1;
      return;
    }
  }
  rmSync(path.join(DIR, 'kaito-server.json'), { force: true });
  logLauncher('stopped', { pid });
  console.log('KAITO を終了しました。');
}

function ps(command) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
}

function shortcut(file, args, description) {
  const q = (s) => s.replace(/'/g, "''");
  const icon = path.join(APP_DIR, 'launcher', 'kaito.ico');
  return ps(
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${q(file)}');` +
      `$s.TargetPath='${q(process.execPath)}';$s.Arguments='${q(args)}';$s.WorkingDirectory='${q(APP_DIR)}';` +
      `$s.WindowStyle=7;$s.Description='${q(description)}';` +
      (existsSync(icon) ? `$s.IconLocation='${q(icon)}';` : '') +
      `$s.Save()`,
  );
}

function desktopDir() {
  const r = ps("[Environment]::GetFolderPath('Desktop')");
  return (r.stdout ?? '').trim();
}

function install() {
  if (process.platform !== 'win32') return console.log('ショートカットの作成は Windows のみです。');
  if (!existsSync(path.join(APP_DIR, 'dist', 'client', 'index.html'))) return fail('画面がビルドされていません。先に npm.cmd run build を実行してください。');
  const desk = desktopDir();
  const launcher = `"${path.join(APP_DIR, 'launcher', 'kaito-launcher.mjs')}"`;
  const a = shortcut(path.join(desk, 'KAITO.lnk'), `${launcher} start`, 'KAITO を起動');
  const b = shortcut(path.join(desk, 'KAITOを終了.lnk'), `${launcher} stop`, 'KAITO を終了');
  if (a.status !== 0 || b.status !== 0) return fail('デスクトップにショートカットを作れませんでした。');
  // 自動起動が登録されていれば、今のフォルダを指すように更新する
  if (autostartStatus().enabled) autostart(true);
  logLauncher('installed', { appDir: APP_DIR });
  console.log(`デスクトップに「KAITO」「KAITOを終了」を作りました（${APP_DIR}）。`);
}

function autostartStatus() {
  if (process.platform !== 'win32') return { supported: false, enabled: false, command: null };
  const r = spawnSync('reg', ['query', RUN_KEY, '/v', 'KAITO'], { encoding: 'utf8', windowsHide: true });
  const m = /KAITO\s+REG_SZ\s+(.+)/.exec(r.stdout ?? '');
  return { supported: true, enabled: Boolean(m), command: m ? m[1].trim() : null, expected: autostartCommand(APP_DIR) };
}

function autostart(on) {
  if (process.platform !== 'win32') return console.log('自動起動の登録は Windows のみです。');
  const r = on
    ? spawnSync('reg', ['add', RUN_KEY, '/v', 'KAITO', '/t', 'REG_SZ', '/d', autostartCommand(APP_DIR), '/f'], { windowsHide: true })
    : spawnSync('reg', ['delete', RUN_KEY, '/v', 'KAITO', '/f'], { windowsHide: true });
  logLauncher(on ? 'autostart-on' : 'autostart-off', { ok: r.status === 0 });
  console.log(JSON.stringify(autostartStatus()));
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'start') await start(process.argv.includes('--autostart'));
  else if (cmd === 'stop') await stop();
  else if (cmd === 'status') console.log(JSON.stringify({ ...(await inspect(DIR, PORT)), dataDir: DIR, appDir: APP_DIR, autostart: autostartStatus() }, null, 1));
  else if (cmd === 'install') install();
  else if (cmd === 'uninstall') {
    if (process.platform === 'win32') {
      const desk = desktopDir();
      rmSync(path.join(desk, 'KAITO.lnk'), { force: true });
      rmSync(path.join(desk, 'KAITOを終了.lnk'), { force: true });
      if (autostartStatus().enabled) autostart(false);
    }
    console.log('ショートカットと自動起動の登録を消しました（記憶と設定は残しています）。');
  } else if (cmd === 'autostart') {
    if (arg === 'on') autostart(true);
    else if (arg === 'off') autostart(false);
    else console.log(JSON.stringify(autostartStatus()));
  } else console.log('使い方: node launcher/kaito-launcher.mjs start|stop|status|install|uninstall|autostart on|off');
} catch (e) {
  fail(`予期しないエラー：${e instanceof Error ? e.message : String(e)}`);
}
