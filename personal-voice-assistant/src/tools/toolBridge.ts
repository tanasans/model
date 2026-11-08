import { describeWeatherCode, type ToolResult, type WeatherForecast } from '../../shared/tools';
import type { DisplayView } from '../ui/display/DisplayHost';

/**
 * 会話（Function Calling）と画面表示の橋渡し。
 * 1 回の取得結果（ToolResult）から、画面に出す内容と、AI に返す内容の「両方」を作る。
 * → 音声回答と画面の数値が必ず同じデータに基づく。取得できなかった値は null のまま渡し、推測で補わない。
 */
export interface BridgeOutput {
  /** 画面の切り替え先（取得失敗時は null＝画面はそのまま） */
  display: DisplayView | null;
  /** AI に返す内容（この値だけを使って答えるよう指示している） */
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

export function bridgeWeather(result: ToolResult<unknown>): BridgeOutput {
  if (!result.ok) {
    return {
      display: null,
      forModel: { ok: false, error: result.error.message, instruction: '取得できなかったことをそのまま伝え、天気を推測で答えないこと。' },
    };
  }
  const d = result.data as WeatherForecast;
  return {
    display: { kind: 'panel', id: 'weather', params: { result } },
    forModel: {
      ok: true,
      instruction: 'この取得結果の数値だけを使って、結論から簡潔に答えること。null の値は「データなし」とし、推測で補わないこと。画面に同じ表を表示済み。',
      location: [d.location.name, d.location.admin1].filter(Boolean).join('・'),
      date: d.date,
      summary: {
        maxTempC: d.summary.maxTemp,
        minTempC: d.summary.minTemp,
        maxPrecipProbPct: d.summary.maxPrecipProb,
        hoursWithMissingData: d.summary.missingHours,
      },
      // 3 時間ごとに要約（全 24 時間は画面に表示）
      every3h: d.hourly
        .filter((_, i) => i % 3 === 0)
        .map((h) => ({ time: h.time, tempC: h.temperature, precipProbPct: h.precipitationProbability, weather: h.weatherCode === null ? null : describeWeatherCode(h.weatherCode).label })),
      source: `${result.source.name}（${result.source.license ?? ''}）`,
      fetchedAt: result.fetchedAt,
    },
  };
}
