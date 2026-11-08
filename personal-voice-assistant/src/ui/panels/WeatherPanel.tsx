import { describeWeatherCode, type ToolResult, type WeatherForecast } from '../../../shared/tools';
import type { DisplayPanelProps } from '../display/DisplayHost';
import { WeatherIcon } from './WeatherIcon';

/**
 * 時間別天気予報の表示。値は取得結果（ToolResult）そのもの。欠けた値は「—」と表示し、補わない。
 * AI の音声回答も同じ ToolResult から作られる（src/tools/toolBridge.ts）。
 */
export function WeatherPanel({ params, onClose }: DisplayPanelProps) {
  const result = params?.result as ToolResult<WeatherForecast> | undefined;
  if (!result || !result.ok) return null;
  const d = result.data;
  const date = new Date(`${d.date}T00:00:00`);
  const dateLabel = date.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
  const fetched = new Date(result.fetchedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmt = (v: number | null, unit: string) => (v === null ? '—' : `${Math.round(v * 10) / 10}${unit}`);

  return (
    <section className="wp" aria-label={`${d.location.name}の天気予報`}>
      <header className="wp-head">
        <div>
          <div className="wp-kicker">WEATHER FORECAST</div>
          <h2 className="wp-title">
            {d.location.name}
            {d.location.admin1 && d.location.admin1 !== d.location.name && <span className="wp-admin">{d.location.admin1}</span>}
          </h2>
          <div className="wp-date">{dateLabel}</div>
        </div>
        <dl className="wp-summary">
          <div>
            <dt>最高</dt>
            <dd className="hot">{fmt(d.summary.maxTemp, '°')}</dd>
          </div>
          <div>
            <dt>最低</dt>
            <dd>{fmt(d.summary.minTemp, '°')}</dd>
          </div>
          <div>
            <dt>降水確率 最大</dt>
            <dd>{fmt(d.summary.maxPrecipProb, '%')}</dd>
          </div>
        </dl>
        <button className="btn wp-close" onClick={onClose} aria-label="司令室画面に戻る">
          ◀ 戻る
        </button>
      </header>

      <ol className="wp-hours">
        {d.hourly.map((h) => {
          const w = describeWeatherCode(h.weatherCode);
          return (
            <li key={h.time} className="wp-hour" title={w.label}>
              <span className="wp-time">{h.time.slice(0, 2)}時</span>
              <WeatherIcon kind={w.icon} size={34} />
              <span className="wp-temp">{fmt(h.temperature, '°')}</span>
              <span className="wp-prob">
                <span className="wp-bar" style={{ height: `${h.precipitationProbability ?? 0}%` }} />
              </span>
              <span className="wp-prob-v">{fmt(h.precipitationProbability, '%')}</span>
            </li>
          );
        })}
      </ol>

      <footer className="wp-foot">
        <span>
          情報源：
          <a href={result.source.url} target="_blank" rel="noreferrer">
            {result.source.name}
          </a>
          {result.source.license && `（${result.source.license}）`}
        </span>
        <span>取得：{fetched}</span>
        <span>
          地点：{d.location.latitude.toFixed(2)}, {d.location.longitude.toFixed(2)}（{d.location.timezone}）
        </span>
        {d.summary.missingHours > 0 && <span className="wp-missing">データなし：{d.summary.missingHours} 時間分</span>}
      </footer>
    </section>
  );
}
