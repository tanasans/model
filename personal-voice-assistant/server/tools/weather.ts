/**
 * 時間別天気予報（Open-Meteo、API キー不要・非商用無料・CC BY 4.0）。
 * https://open-meteo.com/
 */
import type { WeatherForecast, WeatherHour } from '../../shared/tools.js';
import { ToolError, type DataTool, type ToolContext } from './types.js';

export interface WeatherArgs {
  /** 話された都市名（例: 大阪） */
  city: string;
  /** ローマ字・英語表記（例: Osaka）。日本語の短い地名は検索できないことがあるため */
  cityEn: string | null;
  /** today / tomorrow / day_after_tomorrow / YYYY-MM-DD */
  date: string;
}

// 接続先はテスト時のみ環境変数で差し替え可能（通常は公式 API）
const GEO_URL = process.env.OPEN_METEO_GEOCODING_URL || 'https://geocoding-api.open-meteo.com/v1/search';
const FC_URL = process.env.OPEN_METEO_FORECAST_URL || 'https://api.open-meteo.com/v1/forecast';
const MAX_DAYS_AHEAD = 15; // Open-Meteo の予報は 16 日分
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: WeatherForecast }>();

export const weatherTool: DataTool<WeatherArgs, WeatherForecast> = {
  name: 'weather',
  source: { name: 'Open-Meteo', url: 'https://open-meteo.com/', license: 'CC BY 4.0' },

  parse(raw) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const city = typeof a.city === 'string' ? a.city.trim() : '';
    const cityEn = typeof a.cityEn === 'string' && a.cityEn.trim() ? a.cityEn.trim() : null;
    const date = typeof a.date === 'string' ? a.date.trim() : 'today';
    if (!city || city.length > 40) throw new ToolError('BAD_INPUT', '都市名が指定されていません。');
    if (cityEn && (cityEn.length > 60 || !/^[\p{L}\p{M}\s.'-]+$/u.test(cityEn))) throw new ToolError('BAD_INPUT', '都市名の表記が不正です。');
    return { city, cityEn, date };
  },

  async run(args, ctx) {
    const place = await geocode(args, ctx);
    const date = resolveDate(args.date, ctx.now, place.timezone);
    const key = `${place.latitude.toFixed(3)},${place.longitude.toFixed(3)},${date}`;
    const hit = cache.get(key);
    if (hit && ctx.now.getTime() - hit.at < CACHE_MS) return hit.value;

    const url = new URL(FC_URL);
    url.searchParams.set('latitude', String(place.latitude));
    url.searchParams.set('longitude', String(place.longitude));
    url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,weather_code');
    url.searchParams.set('timezone', place.timezone);
    url.searchParams.set('start_date', date);
    url.searchParams.set('end_date', date);
    const body = (await getJson(url, ctx)) as OpenMeteoForecast;
    const value = buildForecast(place, date, body);
    cache.set(key, { at: ctx.now.getTime(), value });
    return value;
  },
};

// ---------- 地名検索 ----------
interface Place {
  name: string;
  admin1: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
  timezone: string;
}

/** 話された名前 → 「〜市」を付けた名前 → ローマ字表記 の順に探す（推測で別の都市にしない） */
export async function geocode(args: WeatherArgs, ctx: ToolContext): Promise<Place> {
  const tries = [args.city];
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(args.city) && !/[市町村区都道府県]$/.test(args.city)) tries.push(`${args.city}市`);
  if (args.cityEn) tries.push(args.cityEn);
  for (const name of tries) {
    const url = new URL(GEO_URL);
    url.searchParams.set('name', name);
    url.searchParams.set('count', '5');
    url.searchParams.set('language', 'ja');
    url.searchParams.set('format', 'json');
    const body = (await getJson(url, ctx)) as { results?: GeoResult[] };
    const best = pickPlace(body.results ?? []);
    if (best) return best;
  }
  throw new ToolError('NOT_FOUND', `「${args.city}」の場所が見つかりませんでした。`);
}

interface GeoResult {
  name: string;
  admin1?: string;
  country?: string;
  country_code?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  population?: number;
}

/** 日本の地点を優先し、その中で人口の多いものを選ぶ */
export function pickPlace(results: GeoResult[]): Place | null {
  const valid = results.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && r.timezone);
  if (!valid.length) return null;
  const jp = valid.filter((r) => r.country_code === 'JP');
  const pool = jp.length ? jp : valid;
  const best = [...pool].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0]!;
  return { name: best.name, admin1: best.admin1 ?? null, country: best.country ?? null, latitude: best.latitude, longitude: best.longitude, timezone: best.timezone! };
}

// ---------- 日付 ----------
/** today / tomorrow / day_after_tomorrow / YYYY-MM-DD を、その地点の現地日付に変換。予報範囲外はエラー */
export function resolveDate(input: string, now: Date, timeZone: string): string {
  const today = localDate(now, timeZone);
  const words: Record<string, number> = { today: 0, tomorrow: 1, day_after_tomorrow: 2, 今日: 0, 明日: 1, 明後日: 2 };
  let target: string;
  if (input in words) target = addDays(today, words[input]!);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(input) && !Number.isNaN(Date.parse(`${input}T00:00:00Z`))) target = input;
  else throw new ToolError('BAD_INPUT', `日付「${input}」を解釈できません。`);
  const diff = daysBetween(today, target);
  if (diff < 0) throw new ToolError('OUT_OF_RANGE', '過去の日付の予報は取得できません。');
  if (diff > MAX_DAYS_AHEAD) throw new ToolError('OUT_OF_RANGE', `予報は ${MAX_DAYS_AHEAD} 日先までしか取得できません。`);
  return target;
}

function localDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function addDays(ymd: string, n: number): string {
  const t = new Date(`${ymd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// ---------- 予報の整形 ----------
interface OpenMeteoForecast {
  timezone?: string;
  hourly?: { time?: string[]; temperature_2m?: Array<number | null>; precipitation_probability?: Array<number | null>; weather_code?: Array<number | null> };
}

/** API の値をそのまま並べる。欠けている値は null のまま（前後から補間しない） */
export function buildForecast(place: Place, date: string, body: OpenMeteoForecast): WeatherForecast {
  const h = body.hourly;
  if (!h?.time?.length) throw new ToolError('UPSTREAM_ERROR', '予報データが返されませんでした。');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const hourly: WeatherHour[] = h.time
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.startsWith(date))
    .map(({ t, i }) => ({
      time: t.slice(11, 16),
      temperature: num(h.temperature_2m?.[i]),
      precipitationProbability: num(h.precipitation_probability?.[i]),
      weatherCode: num(h.weather_code?.[i]),
    }));
  if (!hourly.length) throw new ToolError('UPSTREAM_ERROR', '指定日の予報データがありませんでした。');
  const temps = hourly.map((x) => x.temperature).filter((v): v is number => v !== null);
  const probs = hourly.map((x) => x.precipitationProbability).filter((v): v is number => v !== null);
  return {
    location: place,
    date,
    hourly,
    summary: {
      maxTemp: temps.length ? Math.max(...temps) : null,
      minTemp: temps.length ? Math.min(...temps) : null,
      maxPrecipProb: probs.length ? Math.max(...probs) : null,
      missingHours: hourly.filter((x) => x.temperature === null || x.precipitationProbability === null || x.weatherCode === null).length,
    },
  };
}

async function getJson(url: URL, ctx: ToolContext): Promise<unknown> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new ToolError(e instanceof Error && e.name === 'TimeoutError' ? 'TIMEOUT' : 'UPSTREAM_ERROR', '天気データの取得に失敗しました（通信エラー）。');
  }
  if (res.status === 429) {
    // Open-Meteo の無料枠（IP ごとの利用上限）に達した
    const body = (await res.json().catch(() => null)) as { reason?: string } | null;
    throw new ToolError('RATE_LIMITED', `Open-Meteo の利用上限に達しました${body?.reason ? `（${body.reason}）` : ''}。時間をおいてお試しください。`);
  }
  if (!res.ok) throw new ToolError('UPSTREAM_ERROR', `天気データの取得に失敗しました（HTTP ${res.status}）。`);
  const json = (await res.json()) as { error?: boolean; reason?: string };
  if (json && json.error) throw new ToolError('UPSTREAM_ERROR', `天気データの取得に失敗しました（${json.reason ?? '詳細不明'}）。`);
  return json;
}

/** テスト用：キャッシュを空にする */
export function clearWeatherCache(): void {
  cache.clear();
}
