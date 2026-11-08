import { describeWeatherCode, type ToolResult, type WeatherForecast, type WeatherHour } from '../../shared/tools';
import type { DisplayView } from '../ui/display/DisplayHost';
import { ForecastStore, type StoredForecast, type WeatherOk } from './forecastStore';

/**
 * 会話（Function Calling）と画面表示の橋渡し。
 * 取得結果は ForecastStore に保存し、画面も AI も同じ保存データ（1 時間ごとの元データ）を参照する。
 * - AI には 24 時間分すべてを渡す（間引きしない）。特定時刻は get_weather_hours で再参照できる
 * - 取得できなかった値は null のまま。データがある時刻を「確認できません」と答えないよう指示する
 */
export interface BridgeOutput {
  display: DisplayView | null;
  forModel: Record<string, unknown>;
}

export async function callServerTool(name: string, args: unknown, fetchImpl: typeof fetch = fetch): Promise<ToolResult<unknown>> {
  try {
    const res = await fetchImpl(`/api/tools/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }),
    });
    return (await res.json()) as ToolResult<unknown>;
  } catch {
    return { ok: false, tool: name, error: { code: 'UPSTREAM_ERROR', message: 'ローカルサーバーに接続できませんでした。' } };
  }
}

/** 1 時間分を AI 向けの形に（値はそのまま。null は null） */
export function hourForModel(h: WeatherHour) {
  return {
    time: h.time,
    tempC: h.temperature,
    precipProbPct: h.precipitationProbability,
    weather: h.weatherCode === null ? null : describeWeatherCode(h.weatherCode).label,
  };
}

function header(entry: StoredForecast) {
  const r = entry.result;
  const d = r.data;
  return {
    forecast_id: entry.id,
    location: [d.location.name, d.location.admin1].filter(Boolean).join('・'),
    date: d.date,
    timezone: d.location.timezone,
    source: `${r.source.name}（${r.source.license ?? ''}）`,
    fetchedAt: r.fetchedAt,
  };
}

/** 天気の取得結果 → 保存・画面・AI 向けの内容 */
export function bridgeWeather(result: ToolResult<unknown>, store: ForecastStore, queryKey?: string, reused = false): BridgeOutput {
  if (!result.ok) {
    return {
      display: null,
      forModel: { ok: false, error: result.error.message, instruction: '取得できなかったことをそのまま伝え、天気を推測で答えないこと。' },
    };
  }
  const entry = store.put(result as WeatherOk, queryKey);
  store.displayedId = entry.id;
  const d = entry.result.data as WeatherForecast;
  return {
    display: { kind: 'panel', id: 'weather', params: { forecastId: entry.id, result: entry.result } },
    forModel: {
      ok: true,
      ...header(entry),
      reused,
      instruction:
        'hourly に指定日の 1 時間ごとの全データ（予報地点の現地時刻）が入っている。特定の時刻はこの値どおりに答えること。' +
        '概要は数時間ごとにまとめてよいが、聞かれた時刻のデータがあるのに「確認できません」と答えないこと。' +
        'null の値だけ「データなし」と伝え、推測しないこと。画面にも同じデータを表示済み。',
      summary: {
        maxTempC: d.summary.maxTemp,
        minTempC: d.summary.minTemp,
        maxPrecipProbPct: d.summary.maxPrecipProb,
        hoursWithMissingData: d.summary.missingHours,
      },
      hourly: d.hourly.map(hourForModel),
    },
  };
}

/**
 * 取得済み予報から指定時刻（現地時刻の時）を取り出す。再取得はしない。
 * forecastId 省略時は画面に表示中の予報（無ければ最後に取得した予報）。
 */
export function lookupHours(store: ForecastStore, q: { forecastId?: string | null; fromHour?: number | null; toHour?: number | null }): Record<string, unknown> {
  const entry = (q.forecastId ? store.get(q.forecastId) : null) ?? store.displayed() ?? store.latest();
  if (!entry) {
    return { ok: false, error: 'まだ天気予報を取得していません。', instruction: '先に get_weather_forecast で取得すること。推測で答えないこと。' };
  }
  const hours = entry.result.data.hourly;
  const from = q.fromHour ?? 0;
  const to = q.toHour ?? 23;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 23 || from > to) {
    return { ok: false, error: `時刻の指定（${from}〜${to}時）が不正です。0〜23 で指定してください。` };
  }
  const picked = hours.filter((h) => {
    const hh = Number(h.time.slice(0, 2));
    return hh >= from && hh <= to;
  });
  const missing: number[] = [];
  for (let hh = from; hh <= to; hh++) if (!picked.some((h) => Number(h.time.slice(0, 2)) === hh)) missing.push(hh);
  return {
    ok: true,
    ...header(entry),
    displayed: store.displayedId === entry.id,
    instruction: 'hours の値どおりに答えること。null は「データなし」。missingHours に挙がった時刻だけは予報データ自体が無いので、その旨を伝える。',
    hours: picked.map(hourForModel),
    missingHours: missing,
  };
}
