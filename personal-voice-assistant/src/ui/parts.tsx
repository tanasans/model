import { useEffect, useRef, type ReactNode } from 'react';

/** 表示用の共通部品と書式（ロジックは持たない） */

export function dbToPct(db: number): number {
  return Math.min(100, Math.max(0, ((db + 80) / 80) * 100));
}
export function fmtDb(db: number): string {
  return `${Math.max(-99, Math.round(db))}dB`;
}
export function fmtNum(n: number): string {
  return Math.abs(n) >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <label className={`k-toggle ${checked ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="k-toggle-track" aria-hidden>
        <span className="k-toggle-thumb" />
      </span>
      <span className="k-toggle-text">
        <span className="k-toggle-label">{label}</span>
        <span className="k-toggle-state">{checked ? 'ON' : 'OFF'}</span>
        {hint && <span className="k-toggle-hint">{hint}</span>}
      </span>
    </label>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="k-slider">
      <span className="k-slider-head">
        <span>{label}</span>
        <span className="k-slider-value">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ '--pct': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** 実測レベルを 10 回/秒で表示するメーター（値が無ければ「未使用」と表示し、偽の値は出さない） */
export function LiveMeter({ read, label }: { read: () => number | null; label?: string }) {
  const fill = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      const db = read();
      if (fill.current) fill.current.style.width = db === null ? '0%' : `${dbToPct(db)}%`;
      if (text.current) text.current.textContent = db === null ? 'マイク未使用' : fmtDb(db);
    }, 100);
    return () => window.clearInterval(id);
  }, [read]);
  return (
    <div className="k-meter">
      {label && <span className="k-meter-label">{label}</span>}
      <div className="k-meter-bar">
        <div className="k-meter-fill" ref={fill} />
      </div>
      <span className="k-meter-value" ref={text}>
        マイク未使用
      </span>
    </div>
  );
}

export function LevelBar({ levelDb, floorDb, gateDb }: { levelDb: number; floorDb?: number | null; gateDb?: number | null }) {
  return (
    <div className="meter-bar">
      <div className="meter-fill" style={{ width: `${dbToPct(levelDb)}%` }} />
      {floorDb != null && <div className="meter-floor" style={{ left: `${dbToPct(floorDb)}%` }} title="環境音の基準値" />}
      {gateDb != null && <div className="meter-th" style={{ left: `${dbToPct(gateDb)}%` }} title="拍手判定しきい値" />}
    </div>
  );
}

