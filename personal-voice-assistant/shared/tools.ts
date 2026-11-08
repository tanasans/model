/**
 * 外部データ取得の共通型（サーバーとブラウザで共有）。
 * 音声回答と画面表示は、必ず同じ ToolResult から作る（どちらかだけ推測で補わない）。
 */
export interface DataSource {
  /** 表示名（例: Open-Meteo） */
  name: string;
  url: string;
  /** 利用条件の表示（例: CC BY 4.0） */
  license?: string;
}

export type ToolResult<T> =
  | { ok: true; tool: string; data: T; source: DataSource; fetchedAt: string }
  | { ok: false; tool: string; error: { code: ToolErrorCode; message: string } };

export type ToolErrorCode = 'BAD_INPUT' | 'NOT_FOUND' | 'OUT_OF_RANGE' | 'UPSTREAM_ERROR' | 'TIMEOUT' | 'RATE_LIMITED' | 'UNKNOWN_TOOL';

// ---------- 天気（Open-Meteo） ----------
export interface WeatherHour {
  /** 現地時刻 "HH:MM" */
  time: string;
  /** 気温（°C）。取得できなければ null（補完しない） */
  temperature: number | null;
  /** 降水確率（%）。取得できなければ null */
  precipitationProbability: number | null;
  /** WMO 天気コード。取得できなければ null */
  weatherCode: number | null;
}

export interface WeatherForecast {
  location: { name: string; admin1: string | null; country: string | null; latitude: number; longitude: number; timezone: string };
  /** 対象日（現地、YYYY-MM-DD） */
  date: string;
  hourly: WeatherHour[];
  /** 取得できた値だけから計算（全て欠けていれば null） */
  summary: { maxTemp: number | null; minTemp: number | null; maxPrecipProb: number | null; missingHours: number };
}

/** WMO 天気コード → 日本語・アイコン種別 */
export type WeatherIcon = 'clear' | 'partly' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'thunder' | 'unknown';
export function describeWeatherCode(code: number | null): { label: string; icon: WeatherIcon } {
  if (code === null || !Number.isFinite(code)) return { label: '不明', icon: 'unknown' };
  if (code === 0) return { label: '快晴', icon: 'clear' };
  if (code === 1) return { label: '晴れ', icon: 'clear' };
  if (code === 2) return { label: '晴れ時々曇り', icon: 'partly' };
  if (code === 3) return { label: '曇り', icon: 'cloudy' };
  if (code === 45 || code === 48) return { label: '霧', icon: 'fog' };
  if (code >= 51 && code <= 57) return { label: '霧雨', icon: 'drizzle' };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { label: code >= 80 ? 'にわか雨' : '雨', icon: 'rain' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: '雪', icon: 'snow' };
  if (code >= 95 && code <= 99) return { label: '雷雨', icon: 'thunder' };
  return { label: '不明', icon: 'unknown' };
}
