import { memo, useEffect, useState } from 'react';

/**
 * 常時動作する背景（戦術グリッド・レーダー走査・同心円リング・光点・走査線・装甲枠）。
 * - 音声検出・API 通信・画面の状態とは完全に独立（props は低負荷モードのみ）
 * - アニメーションは CSS の transform / opacity だけ（GPU 合成で軽量。JavaScript の毎フレーム処理なし）
 * - タブが非表示の間は一時停止。低負荷モード・OS の「アニメーションを減らす」設定では静止
 * - スマートフォンでは CSS 側でレーダー走査以外を省略
 */
const BLIPS = [
  { x: 18, y: 26, d: 7.3, delay: 0.4 },
  { x: 77, y: 18, d: 9.1, delay: 2.2 },
  { x: 86, y: 62, d: 6.7, delay: 4.1 },
  { x: 12, y: 71, d: 8.4, delay: 1.3 },
  { x: 63, y: 83, d: 10.2, delay: 5.6 },
  { x: 34, y: 12, d: 11.5, delay: 3.4 },
  { x: 92, y: 36, d: 7.9, delay: 6.8 },
];

export const TacticalBackdrop = memo(function TacticalBackdrop({ lowMotion }: { lowMotion: boolean }) {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return (
    <div className={`tb ${lowMotion ? 'tb-low' : ''} ${hidden ? 'tb-paused' : ''}`} aria-hidden>
      <div className="tb-grid" />
      <div className="tb-radar">
        <div className="tb-radar-rings" />
        <div className="tb-sweep" />
      </div>
      <div className="tb-ring tb-ring-1" />
      <div className="tb-ring tb-ring-2" />
      <div className="tb-ring tb-ring-3" />
      {BLIPS.map((b, i) => (
        <span
          key={i}
          className="tb-blip"
          style={{ left: `${b.x}%`, top: `${b.y}%`, animationDuration: `${b.d}s`, animationDelay: `${b.delay}s` }}
        />
      ))}
      <div className="tb-scan" />
      <div className="tb-frame" />
    </div>
  );
});
