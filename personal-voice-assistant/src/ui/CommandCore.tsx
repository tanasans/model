import { useEffect, useRef } from 'react';
import type { CoreView } from './coreState';

/**
 * 中央の AI コア（3 層リング）。状態変化で変わるのはコアの光と動きだけ（背景は独立）。
 * - 待機（STANDBY / LISTENING）: オリーブ系でゆっくり明滅（約 6 秒周期）
 * - 呼びかけ認識・起動     : burstKey が変わるとアンバーのリングが 1 回広がる
 * - 拍手 1 回目            : pulseKey が変わると外周リングが瞬間的に反応
 * - 接続中                 : 小さな光が外周を移動
 * - 会話中                 : readLevel（実測のマイク入力 0〜1）に合わせて発光。測っていなければ反応しない
 * - エラー                 : 赤の静かな警告表示（点滅なし）
 */
export function CommandCore({
  view,
  readLevel,
  burstKey,
  pulseKey,
  detail,
}: {
  view: CoreView;
  readLevel: () => number | null;
  burstKey: number;
  pulseKey: number;
  detail?: string | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const { state } = view;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (state !== 'ACTIVE' && state !== 'LISTENING') {
      el.style.setProperty('--lvl', '0');
      return;
    }
    let raf = 0;
    let last = 0;
    let smooth = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop); // 非表示のタブではブラウザが自動で止める
      if (t - last < 33) return;
      last = t;
      const v = readLevel();
      smooth = v === null ? smooth * 0.85 : smooth * 0.6 + v * 0.4;
      el.style.setProperty('--lvl', smooth.toFixed(3));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [state, readLevel]);

  return (
    <div className={`cc cc-${state.toLowerCase()} ${view.connecting ? 'cc-connecting' : ''}`} ref={root} role="img" aria-label={`AIコア ${state} ${view.sub}`}>
      <div className="cc-ring cc-outer" aria-hidden>
        {pulseKey > 0 && <span className="cc-pulse" key={`p${pulseKey}`} />}
      </div>
      <div className="cc-ring cc-ticks" aria-hidden />
      {view.connecting && (
        <div className="cc-orbit" aria-hidden>
          <span />
        </div>
      )}
      <div className="cc-ring cc-mid" aria-hidden />
      <div className="cc-glow" aria-hidden />
      <div className="cc-ring cc-inner" aria-hidden />
      {burstKey > 0 && <div className="cc-burst" key={`b${burstKey}`} aria-hidden />}
      <div className="cc-center">
        <div className="cc-state">{state}</div>
        {view.sub && <div className="cc-sub">{view.sub}</div>}
        {detail && <div className="cc-detail">{detail}</div>}
      </div>
    </div>
  );
}
