import type { ReactNode } from 'react';

export type DrawerTab = 'voice' | 'persona' | 'memory' | 'detail' | 'diag';
const TABS: Array<[DrawerTab, string]> = [
  ['voice', '音声'],
  ['persona', 'KAITO設定'],
  ['memory', 'MEMORY'],
  ['detail', '詳細設定'],
  ['diag', '診断・履歴'],
];

/** 右側の引き出しパネル（標準は閉じる）。画面の上に重ねて開くので、中央の AI コアは動かない */
export function SideDrawer({ tab, onTab, onClose, alert, children }: { tab: DrawerTab | null; onTab: (t: DrawerTab) => void; onClose: () => void; alert: boolean; children: ReactNode }) {
  return (
    <aside className={`sd ${tab ? 'is-open' : ''}`} aria-hidden={!tab} aria-label="設定・診断">
      <div className="sd-head">
        <div className="sd-tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => onTab(id)}>
              {label}
              {id === 'diag' && alert && <span className="tab-dot" aria-label="エラーあり" />}
            </button>
          ))}
        </div>
        <button className="btn btn-small" onClick={onClose} aria-label="閉じる">
          ✕
        </button>
      </div>
      <div className="sd-body">{tab && children}</div>
    </aside>
  );
}
