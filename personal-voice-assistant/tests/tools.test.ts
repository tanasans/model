import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runTool } from '../server/tools/registry.ts';
import { buildForecast, clearWeatherCache, pickPlace, resolveDate } from '../server/tools/weather.ts';
import { describeWeatherCode, type WeatherForecast } from '../shared/tools.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/open-meteo-osaka.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-11-08T04:00:00Z'); // 日本時間 2026-11-08 13:00

/** Open-Meteo の代わり：記録した実際の応答を返す。呼ばれた URL を記録する */
function mockFetch(opts: { geoEmptyFor?: string[]; forecast?: unknown; status?: number } = {}) {
  const calls: string[] = [];
  const f = (async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (opts.status) return new Response(JSON.stringify({ error: true, reason: 'Daily API request limit exceeded.' }), { status: opts.status });
    if (url.hostname.startsWith('geocoding')) {
      const name = url.searchParams.get('name')!;
      return Response.json(opts.geoEmptyFor?.includes(name) ? {} : FX.geocodingOsaka);
    }
    return Response.json(opts.forecast ?? FX.forecast);
  }) as typeof fetch;
  return { f, calls };
}

test('天気: 実際の応答から時間別の気温・降水確率・天気コードをそのまま返す（出典・取得日時つき）', async () => {
  clearWeatherCache();
  const m = mockFetch();
  const r = await runTool('weather', { city: '大阪', cityEn: 'Osaka', date: 'tomorrow' }, { now: NOW, fetch: m.f });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  const d = r.data as WeatherForecast;
  assert.equal(d.location.name, '大阪市');
  assert.equal(d.date, '2026-11-09');
  assert.equal(d.hourly.length, 24);
  const raw = FX.forecast.hourly;
  d.hourly.forEach((h, i) => {
    assert.equal(h.time, raw.time[i].slice(11, 16));
    assert.equal(h.temperature, raw.temperature_2m[i]);
    assert.equal(h.precipitationProbability, raw.precipitation_probability[i]);
    assert.equal(h.weatherCode, raw.weather_code[i]);
  });
  assert.equal(d.summary.maxTemp, Math.max(...raw.temperature_2m));
  assert.equal(d.summary.minTemp, Math.min(...raw.temperature_2m));
  assert.equal(r.source.name, 'Open-Meteo');
  assert.equal(r.source.license, 'CC BY 4.0');
  assert.equal(r.fetchedAt, NOW.toISOString());
  // 予報の要求は指定日・時間別・現地時間帯
  const fc = new URL(m.calls.find((c) => c.includes('/forecast'))!);
  assert.equal(fc.searchParams.get('start_date'), '2026-11-09');
  assert.equal(fc.searchParams.get('hourly'), 'temperature_2m,precipitation_probability,weather_code');
  assert.equal(fc.searchParams.get('timezone'), 'Asia/Tokyo');
});

test('天気: 日本語の短い地名で見つからなければ「〜市」→ローマ字の順に探す', async () => {
  clearWeatherCache();
  const m = mockFetch({ geoEmptyFor: ['大阪', '大阪市'] });
  const r = await runTool('weather', { city: '大阪', cityEn: 'Osaka', date: 'tomorrow' }, { now: NOW, fetch: m.f });
  assert.ok(r.ok, JSON.stringify(r));
  const names = m.calls.filter((c) => c.includes('geocoding')).map((c) => new URL(c).searchParams.get('name'));
  assert.deepEqual(names, ['大阪', '大阪市', 'Osaka']);
});

test('天気: 場所が見つからなければ NOT_FOUND（別の都市で代用しない）', async () => {
  clearWeatherCache();
  const m = mockFetch({ geoEmptyFor: ['架空町', '架空町市'] });
  const r = await runTool('weather', { city: '架空町', date: 'today' }, { now: NOW, fetch: m.f });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'NOT_FOUND');
  assert.ok(!m.calls.some((c) => c.includes('/forecast')), '予報は取得しない');
});

test('天気: 欠けている値は null のまま（補間しない）。集計は取得できた値だけ', () => {
  const fc = structuredClone(FX.forecast);
  fc.hourly.temperature_2m[10] = null;
  fc.hourly.precipitation_probability[11] = null;
  fc.hourly.weather_code[12] = null;
  const place = pickPlace(FX.geocodingOsaka.results)!;
  const d = buildForecast(place, '2026-11-09', fc);
  assert.equal(d.hourly[10]!.temperature, null);
  assert.equal(d.hourly[11]!.precipitationProbability, null);
  assert.equal(d.hourly[12]!.weatherCode, null);
  assert.equal(d.summary.missingHours, 3);
  const temps = fc.hourly.temperature_2m.filter((v: number | null) => v !== null);
  assert.equal(d.summary.maxTemp, Math.max(...temps));
  // 全部欠けていれば集計も null
  const empty = structuredClone(FX.forecast);
  empty.hourly.temperature_2m = empty.hourly.temperature_2m.map(() => null);
  assert.equal(buildForecast(place, '2026-11-09', empty).summary.maxTemp, null);
});

test('天気: 同名の地点は日本を優先し、その中で人口の多い地点を選ぶ', () => {
  const p = pickPlace(FX.geocodingOsaka.results)!;
  assert.equal(p.name, '大阪市');
  assert.equal(p.timezone, 'Asia/Tokyo');
});

test('日付: 今日・明日・明後日・日付指定を現地日付に。過去と 16 日以上先はエラー', () => {
  assert.equal(resolveDate('today', NOW, 'Asia/Tokyo'), '2026-11-08');
  assert.equal(resolveDate('tomorrow', NOW, 'Asia/Tokyo'), '2026-11-09');
  assert.equal(resolveDate('day_after_tomorrow', NOW, 'Asia/Tokyo'), '2026-11-10');
  assert.equal(resolveDate('2026-11-20', NOW, 'Asia/Tokyo'), '2026-11-20');
  // 日本時間の 0 時をまたぐ境界（UTC では前日）
  assert.equal(resolveDate('today', new Date('2026-11-08T15:30:00Z'), 'Asia/Tokyo'), '2026-11-09');
  assert.throws(() => resolveDate('2026-11-01', NOW, 'Asia/Tokyo'), /過去/);
  assert.throws(() => resolveDate('2026-12-31', NOW, 'Asia/Tokyo'), /15 日先/);
  assert.throws(() => resolveDate('来週の金曜', NOW, 'Asia/Tokyo'), /解釈できません/);
});

test('天気: Open-Meteo の利用上限（429）は RATE_LIMITED として理由を伝える', async () => {
  clearWeatherCache();
  const m = mockFetch({ status: 429 });
  const r = await runTool('weather', { city: '大阪', cityEn: 'Osaka', date: 'today' }, { now: NOW, fetch: m.f });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'RATE_LIMITED');
    assert.match(r.error.message, /利用上限/);
  }
});

test('天気: 指定日のデータが応答に無ければ、別の日で代用せずエラー', async () => {
  clearWeatherCache();
  const m = mockFetch(); // 記録した応答は 11/9 分だけ
  const r = await runTool('weather', { city: '大阪', cityEn: 'Osaka', date: 'today' }, { now: NOW, fetch: m.f });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'UPSTREAM_ERROR');
});

test('天気: 入力の検証と未登録ツール', async () => {
  const bad = await runTool('weather', { city: '', date: 'today' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'BAD_INPUT');
  const inj = await runTool('weather', { city: '大阪', cityEn: 'Osaka<script>', date: 'today' });
  assert.equal(inj.ok, false);
  const unknown = await runTool('race-card', {});
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'UNKNOWN_TOOL');
});

test('天気コード: WMO コードを日本語とアイコンに。未知・欠損は「不明」', () => {
  assert.deepEqual(describeWeatherCode(0), { label: '快晴', icon: 'clear' });
  assert.equal(describeWeatherCode(3).icon, 'cloudy');
  assert.equal(describeWeatherCode(63).icon, 'rain');
  assert.equal(describeWeatherCode(81).label, 'にわか雨');
  assert.equal(describeWeatherCode(73).icon, 'snow');
  assert.equal(describeWeatherCode(95).icon, 'thunder');
  assert.equal(describeWeatherCode(null).label, '不明');
  assert.equal(describeWeatherCode(42).icon, 'unknown');
});
