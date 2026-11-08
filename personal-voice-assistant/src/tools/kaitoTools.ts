import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import type { DisplayView } from '../ui/display/DisplayHost';
import { bridgeWeather, callServerTool } from './toolBridge';

/**
 * Realtime API の Function Calling で使うツール。
 * 会話中に AI が呼び出し、取得はローカルサーバー経由（API キーが必要なデータ源もサーバー側で扱う）。
 * 新しいデータ源（出馬表・株価など）は、サーバーの tools/registry と、ここにツールを 1 つずつ追加する。
 */
export function createKaitoTools(show: (v: DisplayView) => void) {
  const weather = tool({
    name: 'get_weather_forecast',
    description:
      '指定した都市・日付の時間別天気予報（気温・降水確率・天気）を Open-Meteo から取得し、画面に表示する。天気・気温・雨・傘などを聞かれたら必ずこれを使う。',
    parameters: z.object({
      city: z.string().describe('話された都市名（日本語、例: 大阪、札幌、箱根）'),
      city_en: z.string().describe('同じ都市のローマ字・英語表記（例: Osaka, Sapporo, Hakone）。分からなければ空文字'),
      date: z
        .string()
        .describe('today / tomorrow / day_after_tomorrow のいずれか、または YYYY-MM-DD（今日から15日先まで）'),
    }),
    execute: async ({ city, city_en, date }) => {
      const result = await callServerTool('weather', { city, cityEn: city_en || null, date });
      const out = bridgeWeather(result);
      if (out.display) show(out.display);
      return out.forModel;
    },
  });

  const mainScreen = tool({
    name: 'show_main_screen',
    description: '天気などの表示を閉じて、元の司令室画面（AI コア）に戻す。「元の画面に戻して」「閉じて」などと言われたら使う。',
    parameters: z.object({}),
    execute: async () => {
      show({ kind: 'core' });
      return { ok: true };
    },
  });

  return [weather, mainScreen];
}
