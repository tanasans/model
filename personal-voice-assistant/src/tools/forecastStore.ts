import type { ToolResult, WeatherForecast } from '../../shared/tools';

/**
 * 取得済みの天気予報（1 時間ごとの元データ）を保持する。
 * 画面表示も AI への回答も、ここに保存した同じ ToolResult を参照する（コピーや間引きをしない）。
 * 同じ問い合わせ（都市・日付）は 10 分間再利用し、再取得しない。
 */
export type WeatherOk = Extract<ToolResult<WeatherForecast>, { ok: true }>;

export interface StoredForecast {
  id: string;
  result: WeatherOk;
  storedAt: number;
}

const REUSE_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 20;

export class ForecastStore {
  private byId = new Map<string, StoredForecast>();
  private byQuery = new Map<string, { id: string; at: number }>();
  /** 画面に表示中の予報 */
  displayedId: string | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  static queryKey(city: string, cityEn: string | null, date: string): string {
    return `${city.trim()}|${(cityEn ?? '').trim().toLowerCase()}|${date.trim()}`;
  }

  /** 保存して id を返す。同じ地点・日付の予報は同じ id で上書き */
  put(result: WeatherOk, queryKey?: string): StoredForecast {
    const d = result.data;
    const id = `wx-${d.location.latitude.toFixed(2)},${d.location.longitude.toFixed(2)}-${d.date}`;
    const entry: StoredForecast = { id, result, storedAt: this.now() };
    this.byId.set(id, entry);
    if (queryKey) this.byQuery.set(queryKey, { id, at: this.now() });
    if (this.byId.size > MAX_ENTRIES) {
      const oldest = [...this.byId.values()].sort((a, b) => a.storedAt - b.storedAt)[0]!;
      this.byId.delete(oldest.id);
    }
    return entry;
  }

  /** 同じ問い合わせの取得済みデータ（10 分以内）があれば返す */
  reuse(queryKey: string): StoredForecast | null {
    const q = this.byQuery.get(queryKey);
    if (!q || this.now() - q.at > REUSE_MS) return null;
    return this.byId.get(q.id) ?? null;
  }

  get(id: string): StoredForecast | null {
    return this.byId.get(id) ?? null;
  }

  displayed(): StoredForecast | null {
    return this.displayedId ? this.get(this.displayedId) : null;
  }

  /** 最後に取得した予報 */
  latest(): StoredForecast | null {
    return [...this.byId.values()].sort((a, b) => b.storedAt - a.storedAt)[0] ?? null;
  }
}
