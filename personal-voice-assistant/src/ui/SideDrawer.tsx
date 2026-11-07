import type { ReactNode } from 'react';

/** 右側の引き出しパネル。画面の上に重ねて開くため、中央の AI コアは動かない */
export function SideDrawer({
  tab,
  onTab,
  onClose,
  children,
}: {
  tab: 'log' | 'settings' | null;
  onTab: (t: 'log' | 'settings') => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside className={`sd ${tab ? 'is-open' : ''}`} aria-hidden={!tab} aria-label="パネル">
      <div className="sd-head">
        <div className="sd-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'log'} className={tab === 'log' ? 'is-on' : ''} onClick={() => onTab('log')}>
            履歴・状態
          </button>
          <button role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'is-on' : ''} onClick={() => onTab('settings')}>
            設定
          </button>
        </div>
        <button className="btn btn-small" onClick={onClose} aria-label="パネルを閉じる">
          閉じる
        </button>
      </div>
      <div className="sd-body">{tab && children}</div>
    </aside>
  );
}
