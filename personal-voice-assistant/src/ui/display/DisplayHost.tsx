import type { ComponentType, ReactNode } from 'react';

/**
 * 中央の情報表示領域。
 * 今は AI コアだけを表示するが、将来は音声の指示で「天気予報」「出馬表」「株価チャート」などの
 * パネルに切り替えられるよう、表示内容を DisplayView で指定し、パネルはレジストリに登録する構成にしている。
 * （今回はダミーのデータは表示しない。パネルは未登録）
 */
export type DisplayView = { kind: 'core' } | { kind: 'panel'; id: string; params?: Record<string, unknown> };

export interface DisplayPanelProps {
  params?: Record<string, unknown>;
  /** パネルを閉じて AI コアに戻る */
  onClose: () => void;
}

/** 将来のパネル（例: 'weather', 'race-card', 'stock-chart'）をここに登録する */
export const DISPLAY_PANELS: Record<string, ComponentType<DisplayPanelProps>> = {};

export function DisplayHost({ view, core, onClose }: { view: DisplayView; core: ReactNode; onClose: () => void }) {
  if (view.kind === 'panel') {
    const Panel = DISPLAY_PANELS[view.id];
    if (Panel) {
      return (
        <div className="dh dh-panel">
          {/* パネル表示中もコアは小さく残し、状態がわかるようにする */}
          <div className="dh-mini">{core}</div>
          <Panel params={view.params} onClose={onClose} />
        </div>
      );
    }
  }
  return <div className="dh dh-core">{core}</div>;
}
