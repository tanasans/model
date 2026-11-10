/**
 * デスクトップ常駐（KAITO Desktop v1）のサーバー側。
 * - 多重起動防止のロックファイル（ユーザー専用フォルダの kaito-server.json：PID・ポート・識別子）
 * - 画面との連絡（ハートビート）：画面が開いているか、終了の合図
 * - 終了の順番：画面に待機・マイク・会話の停止を伝える → 画面の完了を待つ（最大 4 秒）→ 会話の切断・記憶の保存 → サーバー停止
 * - 自動起動（Windows のログイン時）の登録は、ランチャー（launcher/kaito-launcher.mjs）に任せる
 * ログに APIキー・トークン・会話の内容は出さない。
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';

export const LOCK_FILE = 'kaito-server.json';

export interface DesktopState {
  instanceId: string;
  startedAt: number;
  lastHeartbeat: number;
  shuttingDown: boolean;
  pageStopped: boolean;
}

export function newDesktopState(): DesktopState {
  return { instanceId: randomUUID(), startedAt: Date.now(), lastHeartbeat: 0, shuttingDown: false, pageStopped: false };
}

/** 画面が開いているか（直近 6 秒以内にハートビートがある。画面は 2 秒ごとに送る） */
export function uiOpen(s: DesktopState, now = Date.now()): boolean {
  return now - s.lastHeartbeat < 6_000;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LockInfo {
  pid: number;
  port: number;
  instanceId: string;
  startedAt: number;
  appDir: string;
  version: string;
}

export function readLock(dataDir: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(path.join(dataDir, LOCK_FILE), 'utf8')) as LockInfo;
    return Number.isInteger(v.pid) && Number.isInteger(v.port) && typeof v.instanceId === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** 起動前の確認：ほかの KAITO サーバーが動いていれば、その情報を返す（古いロックは消す） */
export async function otherInstance(dataDir: string, fetchImpl: typeof fetch = fetch): Promise<LockInfo | null> {
  const lock = readLock(dataDir);
  if (!lock || lock.pid === process.pid) return null;
  if (!pidAlive(lock.pid)) {
    rmSync(path.join(dataDir, LOCK_FILE), { force: true });
    return null;
  }
  try {
    const res = await fetchImpl(`http://127.0.0.1:${lock.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const h = (await res.json()) as { app?: string; instanceId?: string };
    if (h.app === 'kaito' && h.instanceId === lock.instanceId) return lock;
  } catch {
    /* 応答しない＝そのサーバーは動いていない（PID が別のプロセスに再利用された等） */
  }
  rmSync(path.join(dataDir, LOCK_FILE), { force: true });
  return null;
}

export function writeLock(dataDir: string, info: LockInfo): void {
  writeFileSync(path.join(dataDir, LOCK_FILE), JSON.stringify(info), 'utf8');
}

export function removeLock(dataDir: string, instanceId: string): void {
  const l = readLock(dataDir);
  if (l && l.instanceId === instanceId) rmSync(path.join(dataDir, LOCK_FILE), { force: true });
}

/** ランチャーのログから、起動・終了のエラーの履歴（最新 10 件） */
export function recentLauncherErrors(dataDir: string): Array<{ at: string; event: string; message?: string }> {
  const f = path.join(dataDir, 'logs', 'launcher.log');
  if (!existsSync(f)) return [];
  try {
    return readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .slice(-500)
      .map((l) => {
        try {
          return JSON.parse(l) as { at: string; event: string; message?: string };
        } catch {
          return null;
        }
      })
      .filter((x): x is { at: string; event: string; message?: string } => Boolean(x) && /failed|refused|force-kill/.test(x!.event))
      .slice(-10)
      .reverse();
  } catch {
    return [];
  }
}

export interface DesktopDeps {
  state: DesktopState;
  appDir: string;
  dataDir: string;
  port: number;
  version: string;
  desktopMode: boolean;
  guard: (req: Request, res: Response, next: NextFunction) => void;
  /** 会話の切断・記憶の保存・ロックの削除・サーバー停止 */
  exit: (reason: string) => void;
  log: (m: string) => void;
}

function launcher(appDir: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(appDir, 'launcher', 'kaito-launcher.mjs'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
}

export function autostartStatus(appDir: string): { supported: boolean; enabled: boolean; command: string | null; matchesThisFolder: boolean } {
  if (process.platform !== 'win32') return { supported: false, enabled: false, command: null, matchesThisFolder: false };
  try {
    const out = JSON.parse(launcher(appDir, 'autostart', 'status').stdout) as { enabled: boolean; command: string | null; expected: string };
    return { supported: true, enabled: out.enabled, command: out.command, matchesThisFolder: out.command === out.expected };
  } catch {
    return { supported: true, enabled: false, command: null, matchesThisFolder: false };
  }
}

export function desktopRouter(d: DesktopDeps): Router {
  const r = express.Router();
  r.get('/status', d.guard, (_req, res) => {
    res.json({
      version: d.version,
      desktopMode: d.desktopMode,
      pid: process.pid,
      port: d.port,
      startedAt: d.state.startedAt,
      uptimeSec: Math.round((Date.now() - d.state.startedAt) / 1000),
      memoryMB: Math.round(process.memoryUsage().rss / 1_048_576),
      nodeVersion: process.version,
      appDir: d.appDir,
      dataDir: d.dataDir,
      logDir: path.join(d.dataDir, 'logs'),
      autostart: autostartStatus(d.appDir),
      errors: recentLauncherErrors(d.dataDir),
    });
  });

  /** 画面からの定期連絡。終了の合図を返す。stopped=true は「画面側の停止（待機・マイク・会話）が終わった」 */
  r.post('/heartbeat', d.guard, express.json({ limit: '1kb' }), (req, res) => {
    d.state.lastHeartbeat = Date.now();
    if (req.body?.stopped === true) d.state.pageStopped = true;
    res.json({ shutdown: d.state.shuttingDown });
  });

  r.post('/shutdown', d.guard, (_req, res) => {
    if (!d.state.shuttingDown) {
      d.state.shuttingDown = true;
      d.log('desktop: shutdown requested');
      const begin = Date.now();
      // 画面が開いていれば、画面側の停止（待機・マイク・会話の終了、会話履歴の送信）を最大 6 秒待つ
      const wait = () => {
        if (d.state.pageStopped || !uiOpen(d.state) || Date.now() - begin > 6000) d.exit('desktop-shutdown');
        else setTimeout(wait, 100);
      };
      setTimeout(wait, 100);
    }
    res.json({ ok: true });
  });

  r.put('/autostart', d.guard, express.json({ limit: '1kb' }), (req, res) => {
    if (process.platform !== 'win32') {
      res.status(400).json({ message: '自動起動の登録は Windows のみです。' });
      return;
    }
    const on = req.body?.enabled === true;
    const out = launcher(d.appDir, 'autostart', on ? 'on' : 'off');
    d.log(`desktop: autostart ${on ? 'on' : 'off'} (${out.status === 0 ? 'ok' : 'failed'})`);
    res.status(out.status === 0 ? 200 : 500).json(autostartStatus(d.appDir));
  });

  r.post('/install-shortcut', d.guard, (_req, res) => {
    if (process.platform !== 'win32') {
      res.status(400).json({ message: 'ショートカットの作成は Windows のみです。' });
      return;
    }
    const out = launcher(d.appDir, 'install');
    res.status(out.status === 0 ? 200 : 500).json({ ok: out.status === 0, message: (out.stdout || out.stderr || '').trim().slice(0, 300) });
  });
  return r;
}
