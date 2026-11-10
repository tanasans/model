import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * デスクトップ常駐との連絡（ローカルサーバーのみ。OpenAI には接続しない）。
 * - 2 秒ごとのハートビート：画面が開いていることを伝え、終了の合図を受け取る
 * - 終了の合図を受けたら onShutdown（待機・マイク・会話の停止、会話履歴の送信）を実行し、完了を伝える
 */
export interface DesktopStatus {
  version: string;
  desktopMode: boolean;
  pid: number;
  port: number;
  startedAt: number;
  uptimeSec: number;
  memoryMB: number;
  nodeVersion: string;
  appDir: string;
  dataDir: string;
  logDir: string;
  autostart: { supported: boolean; enabled: boolean; command: string | null; matchesThisFolder: boolean };
  errors: Array<{ at: string; event: string; message?: string }>;
}

/** 起動のしかた（URL の ?launch=desktop|autostart）。開発用（npm run dev）では null */
export function launchMode(search = typeof location === 'undefined' ? '' : location.search): 'desktop' | 'autostart' | null {
  const v = new URLSearchParams(search).get('launch');
  return v === 'desktop' || v === 'autostart' ? v : null;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

export function useDesktop(opts: { onShutdown: () => Promise<void>; loadStatus: boolean }) {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const onShutdownRef = useRef(opts.onShutdown);
  onShutdownRef.current = opts.onShutdown;
  const stoppingRef = useRef(false);

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/desktop/status');
      if (res.ok) setStatus((await res.json()) as DesktopStatus);
    } catch {
      /* サーバー停止中 */
    }
  }, []);
  useEffect(() => {
    if (opts.loadStatus) void reload();
  }, [opts.loadStatus, reload]);

  // ハートビート（画面が開いている間ずっと）
  useEffect(() => {
    let timer = 0;
    const beat = async () => {
      try {
        const res = await fetch('/api/desktop/heartbeat', json('POST', {}));
        const body = (await res.json()) as { shutdown?: boolean };
        if (body.shutdown && !stoppingRef.current) {
          stoppingRef.current = true;
          await onShutdownRef.current().catch(() => undefined);
          await fetch('/api/desktop/heartbeat', json('POST', { stopped: true })).catch(() => undefined);
          setClosed(true);
          window.setTimeout(() => window.close(), 300);
          return;
        }
      } catch {
        /* サーバーが止まっている間は何もしない */
      }
      timer = window.setTimeout(beat, stoppingRef.current ? 500 : 2000);
    };
    void beat();
    return () => window.clearTimeout(timer);
  }, []);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const m = await fn();
      if (m) setMessage(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : '処理に失敗しました。');
    } finally {
      setBusy(false);
      void reload();
    }
  };

  return {
    status,
    error,
    message,
    busy,
    closed,
    reload,
    /** KAITO を終了（画面・待機・会話を止め、記憶を保存してからサーバーを止める） */
    quit: () =>
      run(async () => {
        const res = await fetch('/api/desktop/shutdown', json('POST'));
        if (!res.ok) throw new Error('終了を開始できませんでした。');
        // 以降はハートビートが終了の合図を受け取り、停止処理を行う
        return '終了しています…';
      }),
    setAutostart: (enabled: boolean) =>
      run(async () => {
        const res = await fetch('/api/desktop/autostart', json('PUT', { enabled }));
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        if (!res.ok) throw new Error(body?.message ?? '自動起動の設定を変更できませんでした。');
        return enabled ? 'Windows のログイン時に KAITO を起動するように登録しました。' : '自動起動の登録を解除しました。';
      }),
    installShortcut: () =>
      run(async () => {
        const res = await fetch('/api/desktop/install-shortcut', json('POST'));
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        if (!res.ok) throw new Error(body?.message ?? 'ショートカットを作れませんでした。');
        return 'デスクトップのショートカットを、このフォルダの KAITO を指すように作り直しました。';
      }),
  };
}

export type DesktopController = ReturnType<typeof useDesktop>;
