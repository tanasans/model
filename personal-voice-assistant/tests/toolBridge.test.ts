import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickPlace, buildForecast } from '../server/tools/weather.ts';
import { bridgeWeather } from '../src/tools/toolBridge.ts';
import { createKaitoTools } from '../src/tools/kaitoTools.ts';
import type { ToolResult, WeatherForecast } from '../shared/tools.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/open-meteo-osaka.json', import.meta.url), 'utf8'));
const data = buildForecast(pickPlace(FX.geocodingOsaka.results)!, '2026-11-09', FX.forecast);
const ok: ToolResult<WeatherForecast> = {
  ok: true,
  tool: 'weather',
  data,
  source: { name: 'Open-Meteo', url: 'https://open-meteo.com/', license: 'CC BY 4.0' },
  fetchedAt: '2026-11-08T04:00:00.000Z',
};

test('画面と音声回答は同じ取得結果から作る（画面は結果そのもの、AI への値も同じ結果から計算）', () => {
  const out = bridgeWeather(ok);
  assert.deepEqual(out.display, { kind: 'panel', id: 'weather', params: { result: ok } });
  assert.equal((out.display as { params: { result: unknown } }).params.result, ok, '同じオブジェクト');
  const m = out.forModel as { summary: Record<string, number | null>; every3h: Array<{ time: string; tempC: number | null; precipProbPct: number | null }>; source: string; fetchedAt: string };
  assert.equal(m.summary.maxTempC, data.summary.maxTemp);
  assert.equal(m.summary.minTempC, data.summary.minTemp);
  assert.equal(m.summary.maxPrecipProbPct, data.summary.maxPrecipProb);
  for (const h of m.every3h) {
    const src = data.hourly.find((x) => x.time === h.time)!;
    assert.equal(h.tempC, src.temperature);
    assert.equal(h.precipProbPct, src.precipitationProbability);
  }
  assert.equal(m.every3h.length, 8);
  assert.match(m.source, /Open-Meteo/);
  assert.equal(m.fetchedAt, ok.fetchedAt);
  assert.match(String((out.forModel as { instruction: string }).instruction), /推測で補わない/);
});

test('取得に失敗したら画面は切り替えず、AI には推測しないよう伝える', () => {
  const out = bridgeWeather({ ok: false, tool: 'weather', error: { code: 'NOT_FOUND', message: '「架空町」の場所が見つかりませんでした。' } });
  assert.equal(out.display, null);
  assert.equal(out.forModel.ok, false);
  assert.match(String(out.forModel.error), /見つかりません/);
  assert.match(String(out.forModel.instruction), /推測/);
});

test('欠けた値は AI への値でも null のまま', () => {
  const fc = structuredClone(FX.forecast);
  fc.hourly.temperature_2m[9] = null;
  const d2 = buildForecast(pickPlace(FX.geocodingOsaka.results)!, '2026-11-09', fc);
  const out = bridgeWeather({ ...ok, data: d2 });
  const h9 = (out.forModel.every3h as Array<{ time: string; tempC: number | null }>).find((h) => h.time === '09:00')!;
  assert.equal(h9.tempC, null);
});

test('Function Calling のツール定義：天気の取得と、元の画面に戻す', () => {
  const tools = createKaitoTools(() => {});
  assert.deepEqual(
    tools.map((t) => t.name),
    ['get_weather_forecast', 'show_main_screen'],
  );
  const schema = JSON.stringify((tools[0] as unknown as { parameters: unknown }).parameters);
  for (const k of ['city', 'city_en', 'date']) assert.match(schema, new RegExp(`"${k}"`));
});

test('会話の開始時に、2 つのツールが Realtime API へ送られる設定になっている', async () => {
  const { RealtimeAgent, RealtimeSession } = await import('@openai/agents/realtime');
  const agent = new RealtimeAgent({ name: 'KAITO', instructions: 'x', tools: createKaitoTools(() => {}) });
  const cfg = (await RealtimeSession.computeInitialSessionConfig(agent, { model: 'gpt-realtime-2.1' } as never)) as { tools?: Array<{ type: string; name: string }> };
  assert.deepEqual(
    cfg.tools?.map((t) => `${t.type}:${t.name}`),
    ['function:get_weather_forecast', 'function:show_main_screen'],
  );
});
