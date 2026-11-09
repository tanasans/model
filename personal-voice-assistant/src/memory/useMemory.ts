import { useCallback, useEffect, useState } from 'react';
import type { MemoryCategory, MemoryRecord, MemorySettings, MemoryStatus, MessageRecord, SessionRecord } from '../../shared/memory';

/**
 * 記憶管理画面のロジック（ローカルサーバーの /api/memory だけを呼ぶ。OpenAI には接続しない）。
 */
interface ErrorBody {
  message?: string;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('ローカルサーバーに接続できません。');
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as (T & ErrorBody) | null;
  if (!res.ok || body === null) throw new Error((body as ErrorBody | null)?.message ?? `処理に失敗しました（HTTP ${res.status}）。`);
  return body;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export interface MemoryFilter {
  q: string;
  from: string;
  to: string;
  category: MemoryCategory | '';
}

const qs = (f: Partial<MemoryFilter>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const RESTORE_MAX_BYTES = 20 * 1024 * 1024;

export function useMemory(enabled: boolean) {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [memFilter, setMemFilter] = useState<MemoryFilter>({ q: '', from: '', to: '', category: '' });
  const [sesFilter, setSesFilter] = useState<MemoryFilter>({ q: '', from: '', to: '', category: '' });

  const run = useCallback(async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const m = await fn();
      if (m) setMessage(m);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '処理に失敗しました。');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    const s = await call<MemoryStatus>('/api/memory/status');
    setStatus(s);
    return s;
  }, []);
  const loadMemories = useCallback(async (f: MemoryFilter) => setMemories(await call<MemoryRecord[]>(`/api/memory/memories${qs(f)}`)), []);
  const loadSessions = useCallback(async (f: MemoryFilter) => setSessions(await call<SessionRecord[]>(`/api/memory/sessions${qs({ q: f.q, from: f.from, to: f.to })}`)), []);

  const reload = useCallback(
    () =>
      run(async () => {
        const s = await loadStatus();
        if (!s.available) return;
        await Promise.all([loadMemories(memFilter), loadSessions(sesFilter)]);
      }),
    [run, loadStatus, loadMemories, loadSessions, memFilter, sesFilter],
  );

  useEffect(() => {
    if (enabled) void reload();
    // タブを開いたときだけ読み込む
  }, [enabled]);

  const after = async (msg: string) => {
    await loadStatus();
    await Promise.all([loadMemories(memFilter), loadSessions(sesFilter)]);
    return msg;
  };

  return {
    status,
    memories,
    sessions,
    busy,
    error,
    message,
    memFilter,
    sesFilter,
    reload,
    searchMemories: (f: MemoryFilter) => {
      setMemFilter(f);
      return run(async () => void (await loadMemories(f)));
    },
    searchSessions: (f: MemoryFilter) => {
      setSesFilter(f);
      return run(async () => void (await loadSessions(f)));
    },
    addMemory: (content: string, category: MemoryCategory) =>
      run(async () => {
        const r = await call<{ duplicate: boolean }>('/api/memory/memories', json('POST', { content, category }));
        return after(r.duplicate ? '同じ内容の記憶がすでにあるため、追加しませんでした。' : '記憶を追加しました。次の会話から使われます。');
      }),
    updateMemory: (id: string, p: { content?: string; category?: MemoryCategory }) =>
      run(async () => {
        await call('/api/memory/memories/' + encodeURIComponent(id), json('PATCH', p));
        return after('記憶を更新しました。次の会話から反映されます。');
      }),
    deleteMemory: (id: string) =>
      run(async () => {
        await call('/api/memory/memories/' + encodeURIComponent(id), { method: 'DELETE' });
        return after('記憶を削除しました。今後の検索や会話には使われません。');
      }),
    deleteAllMemories: () =>
      run(async () => {
        const r = await call<{ deleted: number }>('/api/memory/memories/delete-all', json('POST', { confirm: 'DELETE' }));
        return after(`記憶を ${r.deleted} 件すべて削除しました。`);
      }),
    loadMessages: (id: string) => call<MessageRecord[]>('/api/memory/sessions/' + encodeURIComponent(id)),
    deleteSession: (id: string) =>
      run(async () => {
        await call('/api/memory/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
        return after('会話履歴を削除しました。');
      }),
    deleteAllSessions: () =>
      run(async () => {
        const r = await call<{ deleted: number }>('/api/memory/sessions/delete-all', json('POST', { confirm: 'DELETE' }));
        return after(`会話履歴を ${r.deleted} 件すべて削除しました。`);
      }),
    updateSettings: (p: Partial<MemorySettings>) =>
      run(async () => {
        await call('/api/memory/settings', json('PUT', p));
        await loadStatus();
        return '設定を保存しました。';
      }),
    /** バックアップ（JSON）をダウンロード。内容はブラウザ内で受け取り、外部へは送らない */
    downloadBackup: () =>
      run(async () => {
        const data = await call<unknown>('/api/memory/backup');
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `kaito-memory-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return 'バックアップを保存しました。このファイルには記憶と会話履歴がそのまま入っています。安全な場所に保管してください。';
      }),
    restore: (file: File, mode: 'merge' | 'replace') =>
      run(async () => {
        if (file.size > RESTORE_MAX_BYTES) throw new Error('ファイルが大きすぎます（20MB まで）。');
        let backup: unknown;
        try {
          backup = JSON.parse(await file.text());
        } catch {
          throw new Error('JSON として読み込めませんでした。');
        }
        const r = await call<{ memories: number; sessions: number; skipped: number; snapshot: string | null }>('/api/memory/restore', json('POST', { backup, mode }));
        return after(
          `復元しました：記憶 ${r.memories} 件・会話 ${r.sessions} 件（既にあったため追加しなかったもの ${r.skipped} 件）。` +
            (r.snapshot ? ` 入れ替え前の内容は ${r.snapshot} に保存しました。` : ''),
        );
      }),
  };
}

export type MemoryController = ReturnType<typeof useMemory>;
