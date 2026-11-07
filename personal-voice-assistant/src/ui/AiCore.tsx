import { useEffect, useRef } from 'react';
import type { CoreState } from './coreState';

/**
 * 中央の AI コア（3 層リング）。
 * - STANDBY / LISTENING : 約 6 秒周期の緩やかな脈動
 * - 起動時              : burstKey が変わるとリングが 1 回広がる
 * - ACTIVE              : 実際のマイク入力レベル（readLevel）に応じて発光が変わる
 * - ERROR               : 点滅させず、落ち着いた警告色で表示
 * アニメーションは transform / opacity のみ（GPU で処理され軽量）。OS の「視差効果を減らす」設定にも従う。
 */
export function AiCore({
  state,
  sub,
  readLevel,
  burstKey,
  detail,
}: {
  state: CoreState;
  sub: string;
  /** 0〜1 の実測レベル。測っていなければ null（その場合は脈動のみで、偽の反応はしない） */
  readLevel: () => number | null;
  burstKey: number;
  detail?: string | null;
}) {
  const root = useRef<HTMLDivElement>(null);

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
      raf = requestAnimationFrame(loop);
      if (t - last < 33) return; // 約 30 回/秒で十分
      last = t;
      const v = readLevel();
      smooth = v === null ? smooth * 0.85 : smooth * 0.6 + v * 0.4;
      el.style.setProperty('--lvl', smooth.toFixed(3));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [state, readLevel]);

  return (
    <div className={`k-core core-${state.toLowerCase()}`} ref={root} role="img" aria-label={`AIコア：${state} ${sub}`}>
      {burstKey > 0 && <div className="k-core-burst" key={burstKey} aria-hidden />}
      <div className="k-ring k-ring-outer" aria-hidden />
      <div className="k-ring k-ring-ticks" aria-hidden />
      <div className="k-ring k-ring-mid" aria-hidden />
      <div className="k-ring k-ring-inner" aria-hidden />
      <div className="k-core-glow" aria-hidden />
      <div className="k-core-center">
        <div className="k-core-state">{state}</div>
        <div className="k-core-sub">{sub}</div>
        {detail && <div className="k-core-detail">{detail}</div>}
      </div>
    </div>
  );
}
