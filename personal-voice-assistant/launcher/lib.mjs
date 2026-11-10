/**
 * KAITO デスクトップ用ランチャーの共通処理（Node.js の標準機能だけで動く。tsx・ビルド不要）。
 * - サーバーの多重起動防止：ユーザー専用フォルダのロックファイル（PID・識別子・ポート）と、
 *   /api/health の応答（KAITO であること・同じ識別子であること）で確認する
 * - KAITO 以外のプロセスは終了しない。強制終了は、PID の生存とコマンドラインが KAITO のサーバーであることを確認してから
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync, openSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 5173;
export const LOCK_FILE = 'kaito-server.json';
export const LAUNCH_LOCK = 'kaito-launch.lock';

/** 記憶と同じユーザー専用フォルダ（server/memory/dataDir.ts と同じ規則） */
export function dataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  const custom = env.KAITO_DATA_DIR?.trim();
  if (custom) return path.resolve(custom);
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA?.trim() || path.win32.join(home, 'AppData', 'Local'), 'KAITO');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'KAITO');
  return path.posix.join(env.XDG_DATA_HOME?.trim() || path.posix.join(home, '.local', 'share'), 'kaito');
}

export function logDir(dir = dataDir()) {
  return path.join(dir, 'logs');
}

/** ランチャーのログ（1 行 1 件の JSON。APIキー等は書かない）。2MB を超えたら 1 世代だけ残して作り直す */
export function logLauncher(event, detail = {}, dir = dataDir()) {
  try {
    const d = logDir(dir);
    mkdirSync(d, { recursive: true });
    const f = path.join(d, 'launcher.log');
    if (existsSync(f) && statSync(f).size > 2_000_000) renameSync(f, `${f}.1`);
    appendFileSync(f, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`, 'utf8');
  } catch {
    /* ログが書けなくても起動は続ける */
  }
}

export function readLock(dir = dataDir()) {
  try {
    const v = JSON.parse(readFileSync(path.join(dir, LOCK_FILE), 'utf8'));
    return v && Number.isInteger(v.pid) && Number.isInteger(v.port) && typeof v.instanceId === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/** /api/health に問い合わせる。KAITO なら { app:'kaito', instanceId, pid, ... }、違えば { foreign:true }、無応答なら null */
export async function probe(port, timeoutMs = 1500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ac.signal });
    const body = await res.json().catch(() => null);
    if (body && body.app === 'kaito') return body;
    return { foreign: true };
  } catch (e) {
    // 接続できない＝そのポートは使われていない（または応答しない）
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 今の状態を判定する。
 *  running：KAITO のサーバーが動いている（ロックの PID が生きていて、同じ識別子が応答した）
 *  stale：ロックはあるが、そのサーバーは動いていない（異常終了の跡。消してよい）
 *  port-busy：ロックは無い／古いが、ポートを KAITO 以外が使っている
 *  free：起動してよい
 */
export async function inspect(dir = dataDir(), port = DEFAULT_PORT) {
  const lock = readLock(dir);
  if (lock && pidAlive(lock.pid)) {
    const h = await probe(lock.port);
    if (h && !h.foreign && h.instanceId === lock.instanceId) return { state: 'running', lock, health: h };
  }
  const h = await probe(port);
  if (h && !h.foreign) return { state: 'running', lock: lock ?? { pid: h.pid, port, instanceId: h.instanceId }, health: h };
  if (h && h.foreign) return { state: 'port-busy', lock: lock && !pidAlive(lock.pid) ? lock : null };
  return { state: lock ? 'stale' : 'free', lock };
}

/** ランチャー同士の同時実行防止（5 回連続クリック対策）。取れなければ null。古い（PID が死んでいる／60 秒以上）ものは取り直す */
export function acquireLaunchLock(dir = dataDir(), now = Date.now()) {
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, LAUNCH_LOCK);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(f, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now }));
      closeSync(fd);
      return { release: () => rmSync(f, { force: true }) };
    } catch {
      try {
        const v = JSON.parse(readFileSync(f, 'utf8'));
        if (pidAlive(v.pid) && now - v.at < 60_000) return null;
      } catch {
        /* 壊れたロックは取り直す */
      }
      rmSync(f, { force: true });
    }
  }
  return null;
}

/** プロセスのコマンドラインに KAITO のサーバーが含まれるか（強制終了の前の確認） */
export function isKaitoServerProcess(pid, platform = process.platform) {
  let cmd = '';
  try {
    if (platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      cmd = r.stdout ?? '';
    } else {
      cmd = readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8').replace(/\0/g, ' ');
    }
  } catch {
    return false;
  }
  return /server[\\/]index\.ts/.test(cmd) && /personal-voice-assistant|kaito/i.test(cmd);
}

/** Chrome の場所（見つからなければ null → 既定のブラウザで開く） */
export function findChrome(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return null;
  const c = [
    path.win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.win32.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ].filter(Boolean);
  return c.find((p) => existsSync(p)) ?? null;
}

/** KAITO の画面を開く（Chrome があれば専用ウィンドウ＝アプリモード） */
export function openUi(url, platform = process.platform) {
  if (process.env.KAITO_NO_BROWSER === '1') return; // 自動テスト用：画面を開かない
  const chrome = findChrome();
  if (chrome) {
    spawn(chrome, [`--app=${url}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } else if (platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

/** すでに開いている KAITO のウィンドウを前に出す（Windows のみ。タイトルが「KAITO」で始まるウィンドウ） */
export function focusUi(platform = process.platform) {
  if (platform !== 'win32') return false;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(New-Object -ComObject WScript.Shell).AppActivate('KAITO')"], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  return /True/i.test(r.stdout ?? '');
}

/** Windows のメッセージ（起動失敗の理由など）。ほかの OS ではコンソールに出す */
export function showMessage(text, platform = process.platform) {
  if (platform !== 'win32') {
    console.error(text);
    return;
  }
  const esc = text.replace(/'/g, "''");
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${esc}', 'KAITO') | Out-Null`], { windowsHide: true, timeout: 120000 });
}

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** 自動起動で登録するコマンド（ランチャーを --autostart で起動） */
export function autostartCommand(appDir, nodePath = process.execPath) {
  return `"${nodePath}" "${path.join(appDir, 'launcher', 'kaito-launcher.mjs')}" start --autostart`;
}
