import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import type { DisplayView } from '../ui/display/DisplayHost';
import { ForecastStore } from './forecastStore';
import { bridgeWeather, callServerTool, lookupHours } from './toolBridge';

/**
 * Realtime API の Function Calling で使うツール。
 * 処理本体は WeatherActions（画面・テスト・開発用フックからも同じものを使う）。
 */
export interface ToolDeps {
  show: (v: DisplayView) => void;
  store: ForecastStore;
  fetchImpl?: typeof fetch;
}

export function createWeatherActions({ show, store, fetchImpl }: ToolDeps) {
  return {
    /** 取得（同じ都市・日付は 10 分間、取得済みデータを再利用） */
    async forecast(args: { city: string; city_en: string; date: string }) {
      const key = ForecastStore.queryKey(args.city, args.city_en || null, args.date);
      const cached = store.reuse(key);
      const result = cached ? cached.result : await callServerTool('weather', { city: args.city, cityEn: args.city_en || null, date: args.date }, fetchImpl);
      const out = bridgeWeather(result, store, key, Boolean(cached));
      if (out.display) show(out.display);
      return out.forModel;
    },
    /** 取得済みデータから時刻を指定して参照（再取得しない） */
    hours(args: { forecast_id?: string | null; from_hour?: number | null; to_hour?: number | null }) {
      return lookupHours(store, { forecastId: args.forecast_id ?? null, fromHour: args.from_hour ?? null, toHour: args.to_hour ?? null });
    },
    mainScreen() {
      store.displayedId = null;
      show({ kind: 'core' });
      return { ok: true };
    },
  };
}

export function createKaitoTools(deps: ToolDeps) {
  const a = createWeatherActions(deps);
  const weather = tool({
    name: 'get_weather_forecast',
    description:
      '指定した都市・日付の時間別天気予報（1 時間ごとの気温・降水確率・天気）を取得し、画面に表示する。天気・気温・雨・傘などを聞かれたら必ず使う。同じ都市・日付は取得済みデータを再利用する。',
    parameters: z.object({
      city: z.string().describe('話された都市名（日本語、例: 大阪、札幌、箱根）'),
      city_en: z.string().describe('同じ都市のローマ字・英語表記（例: Osaka, Sapporo, Hakone）。分からなければ空文字'),
      date: z.string().describe('today / tomorrow / day_after_tomorrow のいずれか、または YYYY-MM-DD（今日から15日先まで）'),
    }),
    execute: (input) => a.forecast(input),
  });

  const hours = tool({
    name: 'get_weather_hours',
    description:
      '取得済みの天気予報から、指定した時刻（予報地点の現地時刻、0〜23 時）の気温・降水確率・天気を正確に取り出す。「14時の気温は？」「13時から17時まで」「画面の天気を詳しく」などに使う。再取得はしない。範囲を省略すると 1 日分すべて。',
    parameters: z.object({
      forecast_id: z.string().nullable().describe('get_weather_forecast の結果の forecast_id。省略（null）なら画面に表示中の予報'),
      from_hour: z.number().int().min(0).max(23).nullable().describe('開始時刻（時）。例: 14。null なら 0'),
      to_hour: z.number().int().min(0).max(23).nullable().describe('終了時刻（時、その時刻を含む）。例: 17。null なら 23'),
    }),
    execute: async (input) => a.hours(input),
  });

  const mainScreen = tool({
    name: 'show_main_screen',
    description: '天気などの表示を閉じて、元の司令室画面（AI コア）に戻す。「元の画面に戻して」「閉じて」などと言われたら使う。',
    parameters: z.object({}),
    execute: async () => a.mainScreen(),
  });

  return [weather, hours, mainScreen];
}
