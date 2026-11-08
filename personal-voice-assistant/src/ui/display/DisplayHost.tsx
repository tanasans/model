import type { ComponentType, ReactNode } from 'react';
import { WeatherPanel } from '../panels/WeatherPanel';

/**
 * 中央の情報表示領域。
 * 今は AI コアだけを表示するが、将来は音声の指示で「天気予報」「出馬表」「株価チャート」などの
 * パネルに切り替えられるよう、表示内容を DisplayView で指定し、パネルはレジストリに登録する構成にしている。
 * 第 1 弾は天気予報（Open-Meteo）。ダミーのデータは表示しない
 */
export type DisplayView = { kind: 'core' } | { kind: 'panel'; id: string; params?: Record<string, unknown> };

export interface DisplayPanelProps {
  params?: Record<string, unknown>;
  /** パネルを閉じて AI コアに戻る */
  onClose: () => void;
}

/** 表示パネルの登録（将来: 'race-card' 出馬表、'stock-chart' 株価チャート など） */
export const DISPLAY_PANELS: Record<string, ComponentType<DisplayPanelProps>> = {
  weather: WeatherPanel,
};

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
