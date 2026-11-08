import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runTool } from '../server/tools/registry.ts';
import { clearWeatherCache } from '../server/tools/weather.ts';
import { createKaitoTools, createWeatherActions } from '../src/tools/kaitoTools.ts';
import { ForecastStore } from '../src/tools/forecastStore.ts';
import { lookupHours } from '../src/tools/toolBridge.ts';
import type { DisplayView } from '../src/ui/display/DisplayHost.tsx';
import { describeWeatherCode, type WeatherForecast } from '../shared/tools.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/open-meteo-osaka.json', import.meta.url), 'utf8'));
const RAW = FX.forecast.hourly; // Open-Meteo の実際の応答（大阪市 2026-11-09、1 時間ごと）
const NOW = new Date('2026-11-08T04:00:00Z'); // 日本時間 11/8 13:00 → 「明日」= 11/9

/** 会話中と同じ経路：AI のツール処理 → ローカルサーバーのツール → Open-Meteo（記録した実応答） */
function setup() {
  clearWeatherCache();
  let openMeteoCalls = 0;
  const openMeteo = (async (u: URL | string) => {
    openMeteoCalls++;
    return Response.json(String(u).includes('geocoding') ? FX.geocodingOsaka : FX.forecast);
  }) as typeof fetch;
  const server = (async (_url: string, init?: RequestInit) => {
    const { args } = JSON.parse(String(init!.body));
    return Response.json(await runTool('weather', args, { now: NOW, fetch: openMeteo }));
  }) as unknown as typeof fetch;
  let display: DisplayView = { kind: 'core' };
  const store = new ForecastStore();
  const actions = createWeatherActions({ show: (v) => (display = v), store, fetchImpl: server });
  /** 画面に表示している 1 時間ごとのデータ */
  const screen = () => ((display as unknown as { params: { result: { data: WeatherForecast } } }).params.result.data);
  return { actions, store, screen, calls: () => openMeteoCalls, display: () => display };
}
type Hour = { time: string; tempC: number | null; precipProbPct: number | null; weather: string | null };
const hourOf = (hh: number) => ({ time: `${String(hh).padStart(2, '0')}:00`, tempC: RAW.temperature_2m[hh], precipProbPct: RAW.precipitation_probability[hh], weather: describeWeatherCode(RAW.weather_code[hh]).label });

test('実機テスト1「明日の大阪の14時の気温は？」：取得結果に 1 時間ごとの全データがあり、14時の値が画面と一致', async () => {
  const t = setup();
  const fc = (await t.actions.forecast({ city: '大阪', city_en: 'Osaka', date: 'tomorrow' })) as { hourly: Hour[]; timezone: string; date: string; forecast_id: string };
  assert.equal(fc.hourly.length, 24, 'AI に 24 時間すべてを渡す（3 時間間隔に間引かない）');
  assert.equal(fc.timezone, 'Asia/Tokyo');
  assert.equal(fc.date, '2026-11-09');
  const r = t.actions.hours({ from_hour: 14, to_hour: 14 }) as { hours: Hour[]; missingHours: number[] };
  assert.deepEqual(r.hours, [hourOf(14)]);
  assert.deepEqual(r.missingHours, []);
  assert.equal(r.hours[0]!.tempC, t.screen().hourly[14]!.temperature, '音声の値＝画面の値');
  assert.equal(fc.hourly[14]!.tempC, t.screen().hourly[14]!.temperature);
});

test('実機テスト2「15時の降水確率は？」：再取得せず、取得済みデータから答える', async () => {
  const t = setup();
  await t.actions.forecast({ city: '大阪', city_en: 'Osaka', date: 'tomorrow' });
  const before = t.calls();
  const r = t.actions.hours({ from_hour: 15, to_hour: 15 }) as { hours: Hour[] };
  assert.equal(t.calls(), before, 'Open-Meteo に再アクセスしない');
  assert.equal(r.hours[0]!.precipProbPct, RAW.precipitation_probability[15]);
  assert.equal(r.hours[0]!.precipProbPct, t.screen().hourly[15]!.precipitationProbability);
});

test('実機テスト3「13時から17時まで1時間ごとに」：5 時間分すべてが画面と一致', async () => {
  const t = setup();
  await t.actions.forecast({ city: '大阪', city_en: 'Osaka', date: 'tomorrow' });
  const r = t.actions.hours({ from_hour: 13, to_hour: 17 }) as { hours: Hour[] };
  assert.deepEqual(r.hours.map((h) => h.time), ['13:00', '14:00', '15:00', '16:00', '17:00']);
  r.hours.forEach((h, i) => {
    assert.deepEqual(h, hourOf(13 + i));
    const s = t.screen().hourly[13 + i]!;
    assert.equal(h.tempC, s.temperature);
    assert.equal(h.precipProbPct, s.precipitationProbability);
    assert.equal(h.weather, describeWeatherCode(s.weatherCode).label);
  });
});

test('実機テスト4「画面に表示している天気を詳しく説明して」：表示中の予報の 24 時間分を返す', async () => {
  const t = setup();
  await t.actions.forecast({ city: '大阪', city_en: 'Osaka', date: 'tomorrow' });
  const r = t.actions.hours({}) as { hours: Hour[]; displayed: boolean; location: string; source: string; fetchedAt: string };
  assert.equal(r.displayed, true);
  assert.equal(r.hours.length, 24);
  r.hours.forEach((h, i) => assert.deepEqual(h, hourOf(i)));
  assert.equal(r.location, '大阪市・大阪府');
  assert.match(r.source, /Open-Meteo/);
  assert.equal(r.fetchedAt, NOW.toISOString());
});

test('同じ地域・日付の再質問は取得済みデータを再利用（画面も同じデータ）', async () => {
  const t = setup();
  const a = (await t.actions.forecast({ city: '大阪', city_en: 'Osaka', date: 'tomorrow' })) as { reused: boolean; forecast_id: string };
  const calls = t.calls();
  const shown1 = t.screen();
  const b = (await t.actions.forecast({ city: '大阪', city_en: 'Osaka', date: 'tomorrow' })) as { reused: boolean; forecast_id: string };
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(t.calls(), calls, '再取得しない');
  assert.equal(b.forecast_id, a.forecast_id);
  assert.equal(t.screen(), shown1, '同じオブジェクトを表示');
});

test('データが本当に無い場合だけ「無い」と返す（null の時刻・予報範囲外の時刻・未取得）', () => {
  const store = new ForecastStore();
  assert.equal((lookupHours(store, { fromHour: 14, toHour: 14 }) as { ok: boolean }).ok, false, '未取得なら取得を促す');
  const data: WeatherForecast = {
    location: { name: '大阪市', admin1: '大阪府', country: '日本', latitude: 34.69, longitude: 135.5, timezone: 'Asia/Tokyo' },
    date: '2026-11-09',
    hourly: [
      { time: '13:00', temperature: 15, precipitationProbability: 2, weatherCode: 1 },
      { time: '14:00', temperature: null, precipitationProbability: 4, weatherCode: 2 },
    ],
    summary: { maxTemp: 15, minTemp: 15, maxPrecipProb: 4, missingHours: 1 },
  };
  store.put({ ok: true, tool: 'weather', data, source: { name: 'Open-Meteo', url: '' }, fetchedAt: NOW.toISOString() });
  const r = lookupHours(store, { fromHour: 13, toHour: 15 }) as { hours: Hour[]; missingHours: number[] };
  assert.equal(r.hours.length, 2);
  assert.equal(r.hours[1]!.tempC, null, '欠損値は null のまま（補わない）');
  assert.equal(r.hours[1]!.precipProbPct, 4, '同じ時刻の他の値は返す');
  assert.deepEqual(r.missingHours, [15], 'データが無い時刻を明示');
});

test('時刻の指定が不正ならエラー（推測で丸めない）', async () => {
  const t = setup();
  await t.actions.forecast({ city: '大阪', city_en: 'Osaka', date: 'tomorrow' });
  assert.equal((t.actions.hours({ from_hour: 17, to_hour: 13 }) as { ok: boolean }).ok, false);
});

test('取得に失敗したら画面は切り替えず、AI には推測しないよう伝える', async () => {
  clearWeatherCache();
  const store = new ForecastStore();
  let shown = false;
  const fail = (async () => Response.json({ ok: false, tool: 'weather', error: { code: 'NOT_FOUND', message: '「架空町」の場所が見つかりませんでした。' } })) as unknown as typeof fetch;
  const a = createWeatherActions({ show: () => (shown = true), store, fetchImpl: fail });
  const r = (await a.forecast({ city: '架空町', city_en: '', date: 'today' })) as { ok: boolean; instruction: string };
  assert.equal(r.ok, false);
  assert.equal(shown, false);
  assert.match(r.instruction, /推測/);
});

test('「元の画面に戻して」で表示中の予報を解除して AI コアに戻る', async () => {
  const t = setup();
  await t.actions.forecast({ city: '大阪', city_en: 'Osaka', date: 'tomorrow' });
  t.actions.mainScreen();
  assert.deepEqual(t.display(), { kind: 'core' });
  assert.equal(t.store.displayedId, null);
});

test('会話開始時に 3 つのツールが Realtime API へ送られる', async () => {
  const { RealtimeAgent, RealtimeSession } = await import('@openai/agents/realtime');
  const tools = createKaitoTools({ show: () => {}, store: new ForecastStore() });
  const agent = new RealtimeAgent({ name: 'KAITO', instructions: 'x', tools });
  const cfg = (await RealtimeSession.computeInitialSessionConfig(agent, { model: 'gpt-realtime-2.1' } as never)) as { tools?: Array<{ name: string; parameters: { properties: Record<string, unknown> } }> };
  assert.deepEqual(cfg.tools?.map((t) => t.name), ['get_weather_forecast', 'get_weather_hours', 'show_main_screen']);
  assert.deepEqual(Object.keys(cfg.tools![1]!.parameters.properties), ['forecast_id', 'from_hour', 'to_hour']);
});
