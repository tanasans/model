import type { ReactElement } from 'react';
import type { WeatherIcon as IconKind } from '../../../shared/tools';

/** 天気アイコン（オリジナルの線画。ゴールドと赤） */
export function WeatherIcon({ kind, size = 40 }: { kind: IconKind; size?: number }) {
  const sun = (
    <g className="wi-sun">
      <circle cx="20" cy="18" r="6" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <line key={a} x1="20" y1="8" x2="20" y2="5" transform={`rotate(${a} 20 18)`} />
      ))}
    </g>
  );
  const cloud = <path className="wi-cloud" d="M11 30h17a6 6 0 0 0 0-12 8 8 0 0 0-15.3 2.6A5 5 0 0 0 11 30z" />;
  const drops = (n: number) => (
    <g className="wi-rain">
      {Array.from({ length: n }, (_, i) => (
        <line key={i} x1={14 + i * 6} y1="33" x2={12 + i * 6} y2="37" />
      ))}
    </g>
  );
  const content: Record<IconKind, ReactElement> = {
    clear: sun,
    partly: (
      <>
        <g transform="translate(-4 -4) scale(0.8)">{sun}</g>
        {cloud}
      </>
    ),
    cloudy: cloud,
    fog: (
      <g className="wi-cloud">
        <line x1="8" y1="18" x2="32" y2="18" />
        <line x1="6" y1="24" x2="34" y2="24" />
        <line x1="10" y1="30" x2="30" y2="30" />
      </g>
    ),
    drizzle: (
      <>
        {cloud}
        {drops(2)}
      </>
    ),
    rain: (
      <>
        {cloud}
        {drops(3)}
      </>
    ),
    snow: (
      <>
        {cloud}
        <g className="wi-snow">
          <circle cx="15" cy="35" r="1.4" />
          <circle cx="21" cy="37" r="1.4" />
          <circle cx="27" cy="35" r="1.4" />
        </g>
      </>
    ),
    thunder: (
      <>
        {cloud}
        <path className="wi-bolt" d="M21 30l-4 6h4l-2 5 6-8h-4l2-3z" />
      </>
    ),
    unknown: <text x="20" y="25" textAnchor="middle" className="wi-unknown">?</text>,
  };
  return (
    <svg className={`wi wi-${kind}`} viewBox="0 0 40 40" width={size} height={size} aria-hidden>
      {content[kind]}
    </svg>
  );
}
