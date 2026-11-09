import { useRef, useState } from 'react';
import {
  CATEGORY_LABEL,
  formatLocal,
  MEMORY_CATEGORIES,
  MEMORY_LIMITS,
  TRANSCRIPT_STATUS_LABEL,
  type MemoryCategory,
  type MemoryRecord,
  type MessageRecord,
  type SessionRecord,
} from '../../shared/memory';
import type { MemoryController, MemoryFilter } from '../memory/useMemory';
import { Toggle } from './parts';

type Tab = 'memories' | 'history' | 'settings';
const TABS: Array<[Tab, string]> = [
  ['memories', '長期記憶'],
  ['history', '会話履歴'],
  ['settings', '設定・バックアップ'],
];
const TRIGGER_LABEL = { manual: 'ボタン', clap: '拍手', wake: '呼びかけ' } as const;

/** 記憶管理（MEMORY タブ）。データはこのパソコンの SQLite だけにあり、ここからは OpenAI に送らない */
export function MemoryPanel({ m, busy }: { m: MemoryController; busy: boolean }) {
  const [tab, setTab] = useState<Tab>('memories');
  const s = m.status;
  return (
    <div className="mp">
      <div className="pp-modes" role="tablist" aria-label="記憶の表示">
        {TABS.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`btn btn-small ${tab === t ? 'is-on' : 'btn-ghost'}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      {!s && !m.error && <p className="muted small">読み込み中…</p>}
      {s && !s.available && <p className="vp-error">{s.error}</p>}
      {s?.warnings.map((w) => (
        <p key={w} className="vp-error small">
          {w}
        </p>
      ))}
      {m.error && <p className="vp-error">{m.error}</p>}
      {m.message && <p className="pp-ok">{m.message}</p>}
      {s?.available && tab === 'memories' && <MemoriesView m={m} />}
      {s?.available && tab === 'history' && <HistoryView m={m} />}
      {s && tab === 'settings' && <SettingsView m={m} busy={busy} />}
    </div>
  );
}

function FilterBar({ value, onSearch, withCategory }: { value: MemoryFilter; onSearch: (f: MemoryFilter) => void; withCategory?: boolean }) {
  const [f, setF] = useState(value);
  return (
    <form
      className="mp-filter"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(f);
      }}
    >
      <input className="pp-input" placeholder="キーワード" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="キーワード" />
      <div className="mp-filter-row">
        <input className="pp-input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="開始日" />
        <span className="muted">〜</span>
        <input className="pp-input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="終了日" />
        {withCategory && (
          <select className="pp-input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as MemoryCategory | '' })} aria-label="分類">
            <option value="">すべての分類</option>
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="row-actions">
        <button className="btn btn-small" type="submit">
          検索
        </button>
        <button
          className="btn btn-small btn-ghost"
          type="button"
          onClick={() => {
            const empty = { q: '', from: '', to: '', category: '' as const };
            setF(empty);
            onSearch(empty);
          }}
        >
          条件を消す
        </button>
      </div>
    </form>
  );
}

function ConfirmButton({ label, confirmText, onConfirm, disabled }: { label: string; confirmText: string; onConfirm: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button className="btn btn-small btn-ghost" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  return (
    <div className="vp-confirm">
      <p>{confirmText}</p>
      <div className="row-actions">
        <button
          className="btn btn-small btn-accent"
          onClick={() => {
            setOpen(false);
            onConfirm();
          }}
        >
          実行する
        </button>
        <button className="btn btn-small" onClick={() => setOpen(false)}>
          やめる
        </button>
      </div>
    </div>
  );
}

function MemoriesView({ m }: { m: MemoryController }) {
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<MemoryCategory>('other');
  return (
    <>
      <FilterBar value={m.memFilter} onSearch={m.searchMemories} withCategory />
      <p className="muted small">
        {m.memories.length} 件{m.memFilter.q || m.memFilter.from || m.memFilter.to || m.memFilter.category ? '（検索結果）' : ''}
      </p>
      <ul className="mp-list">
        {m.memories.map((x) => (
          <MemoryItem key={x.id} x={x} m={m} />
        ))}
      </ul>
      {m.memories.length === 0 && <p className="muted small">記憶はありません。会話で「覚えておいて」と頼むと保存されます。</p>}
      <details className="mp-add">
        <summary>記憶を手入力で追加</summary>
        <textarea className="pp-text" rows={2} maxLength={MEMORY_LIMITS.contentChars} value={content} onChange={(e) => setContent(e.target.value)} aria-label="追加する記憶" />
        <div className="row-actions">
          <select className="pp-input mp-cat" value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)} aria-label="追加する記憶の分類">
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <button
            className="btn btn-small btn-accent"
            disabled={m.busy || !content.trim()}
            onClick={() => void m.addMemory(content, category).then((ok) => ok && setContent(''))}
          >
            追加
          </button>
        </div>
      </details>
      <ConfirmButton
        label="長期記憶をすべて削除"
        confirmText="長期記憶をすべて削除します。元に戻せません（バックアップファイルを作っていた場合、その中には残ります）。"
        onConfirm={() => void m.deleteAllMemories()}
        disabled={m.busy || (m.status?.counts.memories ?? 0) === 0}
      />
    </>
  );
}

function MemoryItem({ x, m }: { x: MemoryRecord; m: MemoryController }) {
  const [edit, setEdit] = useState(false);
  const [content, setContent] = useState(x.content);
  const [category, setCategory] = useState<MemoryCategory>(x.category);
  return (
    <li className="mp-item">
      <div className="mp-item-head">
        <span className="pp-badge is-local">{CATEGORY_LABEL[x.category]}</span>
        {x.sensitive && <span className="pp-badge is-dirty">機微</span>}
        <span className="muted small">
          保存 {formatLocal(x.createdAt)}
          {x.updatedAt !== x.createdAt ? ` ／ 更新 ${formatLocal(x.updatedAt)}` : ''}
          {x.origin === 'voice' ? ' ／ 会話から' : x.origin === 'import' ? ' ／ 復元' : ' ／ 手入力'}
        </span>
      </div>
      {edit ? (
        <>
          <textarea className="pp-text" rows={2} maxLength={MEMORY_LIMITS.contentChars} value={content} onChange={(e) => setContent(e.target.value)} aria-label="記憶の内容" />
          <div className="row-actions">
            <select className="pp-input mp-cat" value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)} aria-label="分類">
              {MEMORY_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
            <button
              className="btn btn-small btn-accent"
              disabled={m.busy || !content.trim()}
              onClick={() => void m.updateMemory(x.id, { content, category }).then((ok) => ok && setEdit(false))}
            >
              保存
            </button>
            <button
              className="btn btn-small"
              onClick={() => {
                setEdit(false);
                setContent(x.content);
                setCategory(x.category);
              }}
            >
              取り消す
            </button>
          </div>
        </>
      ) : (
        <p className="mp-content">{x.content}</p>
      )}
      {!edit && (
        <div className="row-actions">
          <button className="btn btn-small" onClick={() => setEdit(true)}>
            編集
          </button>
          <ConfirmButton label="削除" confirmText="この記憶を削除します。今後の検索や会話には使われません。" onConfirm={() => void m.deleteMemory(x.id)} disabled={m.busy} />
        </div>
      )}
    </li>
  );
}

function HistoryView({ m }: { m: MemoryController }) {
  return (
    <>
      <FilterBar value={m.sesFilter} onSearch={m.searchSessions} />
      <p className="muted small">
        {m.sessions.length} 件の会話{m.status?.settings.historyEnabled ? '' : '（会話履歴の保存は OFF です）'}
      </p>
      <ul className="mp-list">
        {m.sessions.map((s) => (
          <SessionItem key={s.id} s={s} m={m} />
        ))}
      </ul>
      {m.sessions.length === 0 && <p className="muted small">会話履歴はありません。あなたの発言が確定した会話だけが保存されます。</p>}
      <ConfirmButton
        label="会話履歴をすべて削除"
        confirmText="会話履歴をすべて削除します。元に戻せません（長期記憶は残ります。バックアップファイルの中には残ります）。"
        onConfirm={() => void m.deleteAllSessions()}
        disabled={m.busy || (m.status?.counts.sessions ?? 0) === 0}
      />
    </>
  );
}

function SessionItem({ s, m }: { s: SessionRecord; m: MemoryController }) {
  const [msgs, setMsgs] = useState<MessageRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <li className="mp-item">
      <details
        onToggle={(e) => {
          if ((e.target as HTMLDetailsElement).open && !msgs)
            m.loadMessages(s.id).then(setMsgs, (x: unknown) => setErr(x instanceof Error ? x.message : '読み込めませんでした。'));
        }}
      >
        <summary className="mp-item-head">
          <span className="pp-badge">{TRIGGER_LABEL[s.trigger]}</span>
          <span>{formatLocal(s.startedAt)}</span>
          <span className="muted small">{s.messageCount} 発言</span>
        </summary>
        {err && <p className="vp-error small">{err}</p>}
        {msgs && (
          <ol className="mp-msgs">
            {msgs.map((x) => (
              <li key={x.seq} className={`mp-msg is-${x.role}`}>
                <span className="mp-who">{x.role === 'user' ? 'あなた' : 'KAITO'}</span>
                {x.text ? <span>{x.text}</span> : <span className="muted">（文字起こしを取得できませんでした）</span>}
                {x.status !== 'final' && <span className="pp-badge is-dirty">{TRANSCRIPT_STATUS_LABEL[x.status]}</span>}
              </li>
            ))}
          </ol>
        )}
        <ConfirmButton label="この会話を削除" confirmText="この会話の履歴を削除します。" onConfirm={() => void m.deleteSession(s.id)} disabled={m.busy} />
      </details>
    </li>
  );
}

function SettingsView({ m, busy }: { m: MemoryController; busy: boolean }) {
  const s = m.status!;
  const file = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  return (
    <>
      {s.available && (
        <section className="mp-sec">
          <Toggle label="会話履歴を保存する" checked={s.settings.historyEnabled} onChange={(v) => void m.updateSettings({ historyEnabled: v })} />
          <p className="muted small">確定した文字起こしだけを保存します（音声は保存しません）。あなたの発言がない会話（誤起動など）は保存しません。</p>
          <Toggle label="会話の最初に「好み」を渡す（最大5件）" checked={s.settings.includePreferences} onChange={(v) => void m.updateSettings({ includePreferences: v })} />
          <p className="muted small">それ以外の記憶と会話履歴は、必要なときだけ KAITO が検索します（全履歴を毎回 OpenAI に送ることはありません）。機微な情報は渡しません。</p>
          <Toggle label="会話からの自動記憶（次期版）" checked={false} onChange={() => undefined} disabled />
          <p className="muted small">v1 では、あなたが「覚えておいて」と頼んだ内容だけを保存します。</p>
        </section>
      )}
      <section className="mp-sec">
        <h3 className="mp-h">保存先</h3>
        <p className="mp-path">{s.dbPath}</p>
        <p className="muted small">
          このパソコンのユーザー専用フォルダです。GitHub には含まれず、新しい ZIP に入れ替えても消えません。
          {s.available ? `（記憶 ${s.counts.memories} 件・会話 ${s.counts.sessions} 件・発言 ${s.counts.messages} 件・データ形式 v${s.schemaVersion}）` : ''}
        </p>
        <p className="muted small">Node.js {s.nodeVersion}</p>
      </section>
      {s.available && (
        <section className="mp-sec">
          <h3 className="mp-h">バックアップと復元（JSON）</h3>
          <button className="btn btn-small" disabled={m.busy} onClick={() => void m.downloadBackup()}>
            バックアップを保存
          </button>
          <p className="muted small">
            バックアップには、その時点の長期記憶と会話履歴がそのまま入ります（削除済みの記憶は含みません）。後で KAITO 上で削除しても、作成済みのバックアップファイルの中には残ります。不要になったファイルは自分で削除してください。
          </p>
          <div className="row-actions">
            <select className="pp-input mp-cat" value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace')} aria-label="復元の方法">
              <option value="merge">追加（今の記憶は残す）</option>
              <option value="replace">入れ替え（今の記憶を置き換える）</option>
            </select>
            <button className="btn btn-small" disabled={m.busy || busy} onClick={() => file.current?.click()}>
              バックアップから復元
            </button>
          </div>
          {mode === 'replace' && <p className="muted small">入れ替えの前に、今の内容を保存先の backups フォルダへ自動で書き出します。</p>}
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void m.restore(f, mode);
            }}
          />
        </section>
      )}
    </>
  );
}
