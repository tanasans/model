import { useEffect, useRef, useState } from 'react';
import { PERSONA_SECTIONS, renderPersonaMarkdown, type PersonaKey, type PersonaSections } from '../../shared/persona';
import type { PersonaController } from '../persona/usePersona';

type Mode = 'edit' | 'base' | 'local' | 'system';
const MODES: Array<[Mode, string]> = [
  ['edit', '編集'],
  ['base', '基本設定'],
  ['local', '個人設定'],
  ['system', '固定ルール'],
];

/**
 * KAITO 設定（KAITO.md ＝ 基本設定、local/KAITO.local.md ＝ 個人設定）の閲覧・編集。
 * 変更は次の会話から反映。GitHub への反映は行わない（README の手順で明示的に行う）。
 */
export function PersonaPanel({ p }: { p: PersonaController }) {
  const [mode, setMode] = useState<Mode>('edit');
  const [draft, setDraft] = useState<PersonaSections | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const view = p.view;

  // サーバーの内容が変わったら（保存・初期化・取り込み後）下書きを置き換える
  useEffect(() => {
    if (view) setDraft({ ...view.effective });
  }, [view]);

  if (!view || !draft) {
    return <div className="pp">{p.error ? <p className="vp-error">{p.error}</p> : <p className="muted small">読み込み中…</p>}</div>;
  }

  const dirtyKeys = PERSONA_SECTIONS.filter((s) => draft[s.key] !== view.effective[s.key]).map((s) => s.key);
  const overridden = (k: PersonaKey) => view.overrides[k] !== undefined;
  const set = (k: PersonaKey, v: string) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  return (
    <div className="pp">
      <div className="pp-status">
        <span>
          基本設定 <b>{view.baseSource === 'file' ? 'KAITO.md' : '内蔵の初期設定'}</b>
        </span>
        <span>
          個人設定 <b>{Object.keys(view.overrides).length}</b> 項目
        </span>
      </div>
      {view.warnings.map((w) => (
        <p key={w} className="vp-error small">
          {w}
        </p>
      ))}

      <div className="pp-modes" role="tablist" aria-label="表示する設定">
        {MODES.map(([m, label]) => (
          <button key={m} role="tab" aria-selected={mode === m} className={`btn btn-small ${mode === m ? 'is-on' : 'btn-ghost'}`} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>

      {mode === 'edit' && (
        <>
          {PERSONA_SECTIONS.map(({ key, title, maxChars }) => (
            <div key={key} className="pp-sec">
              <div className="pp-sec-head">
                <span className="pp-title">{title}</span>
                <span className={`pp-badge ${overridden(key) ? 'is-local' : ''}`}>{overridden(key) ? '個人' : '基本'}</span>
                {dirtyKeys.includes(key) && <span className="pp-badge is-dirty">未保存</span>}
                {overridden(key) && (
                  <button className="btn btn-small btn-ghost pp-reset1" disabled={p.busy} onClick={() => void p.reset([key])}>
                    基本に戻す
                  </button>
                )}
              </div>
              {key === 'greeting' ? (
                <input
                  className="pp-input"
                  value={draft.greeting}
                  maxLength={maxChars}
                  placeholder="空欄なら挨拶しない"
                  onChange={(e) => set('greeting', e.target.value)}
                  aria-label={title}
                />
              ) : (
                <textarea
                  className="pp-text"
                  value={draft[key]}
                  rows={Math.min(10, Math.max(3, draft[key].split('\n').length + 1))}
                  onChange={(e) => set(key, e.target.value)}
                  aria-label={title}
                />
              )}
              <span className={`pp-count ${draft[key].length > maxChars ? 'is-over' : ''}`}>
                {draft[key].length} / {maxChars}
              </span>
            </div>
          ))}
          <div className="row-actions pp-actions">
            <button className="btn btn-accent" disabled={p.busy || dirtyKeys.length === 0} onClick={() => void p.save(Object.fromEntries(dirtyKeys.map((k) => [k, draft[k]])))}>
              保存
            </button>
            <button className="btn" disabled={p.busy || dirtyKeys.length === 0} onClick={() => setDraft({ ...view.effective })}>
              取り消す
            </button>
          </div>
          <p className="muted small">起動時の挨拶は、会話の最初に一度だけ話します（会話の途中では言いません）。</p>
        </>
      )}

      {mode === 'base' && <pre className="pp-pre">{renderPersonaMarkdown(view.base)}</pre>}
      {mode === 'local' &&
        (Object.keys(view.overrides).length ? (
          <pre className="pp-pre">{renderPersonaMarkdown(view.overrides, { title: 'KAITO 個人設定' })}</pre>
        ) : (
          <p className="muted small">個人設定はありません（すべて基本設定 KAITO.md のとおり）。</p>
        ))}
      {mode === 'system' && (
        <>
          <p className="muted small">安全・天気・会話の終了に関する決まりです。画面からは変更できず、常に会話に含まれます。</p>
          <pre className="pp-pre">{view.systemRules}</pre>
        </>
      )}

      {p.error && <p className="vp-error">{p.error}</p>}
      {p.message && <p className="pp-ok">{p.message}</p>}

      <div className="row-actions pp-actions">
        <button className="btn btn-small" disabled={p.busy} onClick={p.exportMarkdown}>
          エクスポート（.md）
        </button>
        <button className="btn btn-small" disabled={p.busy} onClick={() => fileRef.current?.click()}>
          インポート（.md）
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".md,text/markdown,text/plain"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void p.importFile(f);
          }}
        />
      </div>

      {confirmReset ? (
        <div className="vp-confirm">
          <p>個人設定をすべて削除し、基本設定（KAITO.md）に戻します。</p>
          <div className="row-actions">
            <button
              className="btn btn-accent"
              onClick={() => {
                setConfirmReset(false);
                void p.reset();
              }}
            >
              初期状態に戻す
            </button>
            <button className="btn" onClick={() => setConfirmReset(false)}>
              やめる
            </button>
          </div>
        </div>
      ) : (
        <button className="btn btn-small btn-ghost" disabled={p.busy || Object.keys(view.overrides).length === 0} onClick={() => setConfirmReset(true)}>
          すべて初期状態に戻す
        </button>
      )}
      <p className="muted small">保存先はこのパソコンの local/KAITO.local.md です（GitHub には送られません）。変更は次の会話から反映されます。</p>
    </div>
  );
}
