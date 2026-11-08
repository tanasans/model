import { useCallback, useEffect, useState } from 'react';
import { renderPersonaMarkdown, type PersonaKey, type PersonaOverrides, type PersonaView } from '../../shared/persona';

/**
 * KAITO 設定（KAITO.md ＋ 個人設定）の取得・保存・初期化・取り込み・書き出し。
 * 保存先はローカルサーバー（local/KAITO.local.md）。GitHub には送らない。変更は次の会話から反映。
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
  const body = (await res.json().catch(() => null)) as (T & ErrorBody) | null;
  if (!res.ok || !body) throw new Error(body?.message ?? `設定の処理に失敗しました（HTTP ${res.status}）。`);
  return body;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const IMPORT_MAX_BYTES = 60_000;

export function usePersona(enabled: boolean) {
  const [view, setView] = useState<PersonaView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = useCallback(async (fn: () => Promise<{ view: PersonaView; message?: string }>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await fn();
      setView(r.view);
      if (r.message) setMessage(r.message);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '設定の処理に失敗しました。');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const reload = useCallback(() => run(async () => ({ view: await call<PersonaView>('/api/persona') })), [run]);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  const save = useCallback(
    (sections: PersonaOverrides) =>
      run(async () => ({ view: await call<PersonaView>('/api/persona', json('PUT', { sections })), message: '保存しました。次の会話から反映されます。' })),
    [run],
  );

  const reset = useCallback(
    (keys?: PersonaKey[]) =>
      run(async () => ({
        view: await call<PersonaView>('/api/persona/reset', json('POST', keys ? { keys } : {})),
        message: keys ? '基本設定に戻しました。次の会話から反映されます。' : 'すべて初期状態（KAITO.md）に戻しました。次の会話から反映されます。',
      })),
    [run],
  );

  const importFile = useCallback(
    (file: File) =>
      run(async () => {
        if (file.size > IMPORT_MAX_BYTES) throw new Error('ファイルが大きすぎます（60KB まで）。');
        const markdown = await file.text();
        const r = await call<{ view: PersonaView; imported: string[]; ignored: string[] }>('/api/persona/import', json('POST', { markdown }));
        const ignored = r.ignored.length ? `（取り込まなかった見出し：${r.ignored.join('、')}）` : '';
        return { view: r.view, message: `${r.imported.length} 項目を取り込みました${ignored}。次の会話から反映されます。` };
      }),
    [run],
  );

  /** 実際に使う設定を Markdown でダウンロード（ブラウザ内で作成。サーバーや外部には送らない） */
  const exportMarkdown = useCallback(() => {
    if (!view) return;
    const md = renderPersonaMarkdown(view.effective, {
      title: 'KAITO 設定（エクスポート）',
      note: '画面の「KAITO設定」→「インポート」で取り込めます。個人設定を含む場合があるため、GitHub などに公開する前に内容を確認してください。',
    });
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    const d = new Date();
    a.href = url;
    a.download = `KAITO-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [view]);

  return { view, busy, error, message, reload, save, reset, importFile, exportMarkdown };
}

export type PersonaController = ReturnType<typeof usePersona>;
