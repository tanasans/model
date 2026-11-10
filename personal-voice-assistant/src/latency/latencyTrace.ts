/**
 * 応答時間の計測（このブラウザ内だけ。数値のみを保存し、外部へは送らない）。
 *
 * 起動（wake / clap / manual）：
 *   speechEnd   呼びかけの言葉の終わり（Vosk の単語の終了時刻から推定）
 *   recognized  Vosk の認識確定
 *   decided     呼びかけと判定（起動処理の開始を依頼）
 *   trigger     起動処理の開始（起動音・画面の発光）
 *   micReady    会話用マイクの準備完了
 *   tokenStart / tokenDone  一時キー（client secret）の取得
 *   connected   Realtime API への接続完了（初期設定の受け付けまで）
 *   greetingRequested  挨拶の生成を依頼（Realtime の挨拶の場合）
 *   serverAudio 最初の音声データの到着（output_audio_buffer.started）
 *   firstSound  スピーカーから最初に音が出た瞬間（受信音声の実測、またはローカル挨拶の再生開始）
 *   ready       会話可能（挨拶が終わり、マイクの音を送っている）
 * サーバー内訳（Server-Timing）：persona（KAITO.md）・memory（長期記憶の読み込み）・secret（OpenAI への一時キー発行）
 *
 * 記憶検索（memory）：
 *   speechEnd    ユーザーの発言の終わり（input_audio_buffer.speech_stopped）
 *   toolRequested  AI が記憶検索を要求（ツールの実行開始）
 *   toolReturned   検索結果を AI へ返した（sqliteMs はサーバー内の検索時間）
 *   serverAudio / firstSound  AI の回答音声の開始
 */
export type TraceKind = 'wake' | 'clap' | 'manual' | 'memory';

export interface LatencyRecord {
  id: string;
  kind: TraceKind;
  at: number;
  /** t0（kind ごとの起点）からの経過 ms */
  marks: Record<string, number>;
  /** サーバー内訳など、区間ではない値（ms） */
  values: Record<string, number>;
  /** 補足（ローカル挨拶を使ったか等） */
  notes: string[];
}

export const LATENCY_KEY = 'pva.latency.v1';
export const LATENCY_MAX = 40;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class LatencyTrace {
  readonly abs: Record<string, number> = {};
  readonly values: Record<string, number> = {};
  readonly notes: string[] = [];
  private done = false;
  constructor(
    readonly kind: TraceKind,
    private readonly onFinish: (r: LatencyRecord) => void,
    readonly startedAt = Date.now(),
  ) {}

  /** 最初の 1 回だけ記録する */
  mark(name: string, t = now()): void {
    if (this.done || name in this.abs) return;
    this.abs[name] = t;
  }
  value(name: string, v: number): void {
    if (!this.done && Number.isFinite(v)) this.values[name] = Math.round(v * 10) / 10;
  }
  note(text: string): void {
    if (!this.done && !this.notes.includes(text)) this.notes.push(text);
  }
  has(name: string): boolean {
    return name in this.abs;
  }

  /** 起点：最も早い記録（発話の終わり、なければ認識・起動） */
  record(): LatencyRecord {
    const t0 = Math.min(...Object.values(this.abs));
    const marks: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.abs)) marks[k] = Math.round(v - t0);
    return { id: `${this.startedAt.toString(36)}-${this.kind}`, kind: this.kind, at: this.startedAt, marks, values: { ...this.values }, notes: [...this.notes] };
  }

  finish(): void {
    if (this.done || Object.keys(this.abs).length === 0) return;
    const r = this.record();
    this.done = true;
    this.onFinish(r);
  }
}

// ---------- 保存（数値のみ） ----------
type KV = Pick<Storage, 'getItem' | 'setItem'>;
function storage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadLatency(store: KV | null = storage()): LatencyRecord[] {
  try {
    const raw = JSON.parse(store?.getItem(LATENCY_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r): r is LatencyRecord => Boolean(r) && typeof r === 'object' && typeof (r as LatencyRecord).id === 'string' && typeof (r as LatencyRecord).marks === 'object')
      .slice(0, LATENCY_MAX);
  } catch {
    return [];
  }
}

export function saveLatency(list: LatencyRecord[], store: KV | null = storage()): void {
  try {
    store?.setItem(LATENCY_KEY, JSON.stringify(list.slice(0, LATENCY_MAX)));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

// ---------- 集計 ----------
export interface Stat {
  n: number;
  mean: number;
  median: number;
  max: number;
}

export function stat(values: number[]): Stat | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length / 2;
  const median = v.length % 2 ? v[Math.floor(mid)]! : (v[mid - 1]! + v[mid]!) / 2;
  return { n: v.length, mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length), median: Math.round(median), max: Math.round(v[v.length - 1]!) };
}

/** 区間（from → to）の値。どちらかが無ければ null */
export function span(r: LatencyRecord, from: string, to: string): number | null {
  const a = r.marks[from];
  const b = r.marks[to];
  return a === undefined || b === undefined ? null : b - a;
}

/** 起動の区間（表示・集計用） */
export const START_SPANS: Array<{ label: string; from: string; to: string }> = [
  { label: '発話の終わり → 認識確定（Vosk）', from: 'speechEnd', to: 'recognized' },
  { label: '認識確定 → 起動処理の開始', from: 'recognized', to: 'trigger' },
  { label: '起動処理 → 一時キー取得の開始', from: 'trigger', to: 'tokenStart' },
  { label: '一時キーの取得（直接接続では会話の準備のみ）', from: 'tokenStart', to: 'tokenDone' },
  { label: '会話用マイクの準備（並行）', from: 'trigger', to: 'micReady' },
  { label: '一時キー → 接続完了', from: 'tokenDone', to: 'connected' },
  { label: '　内訳：接続の申し込み → 応答（SDP）', from: 'offer', to: 'answer' },
  { label: '　内訳：通信路の確立（ICE・DTLS）', from: 'answer', to: 'pcConnected' },
  { label: '　内訳：初期設定の受け付け', from: 'pcConnected', to: 'connected' },
  { label: '接続完了 → 最初の音声データ', from: 'connected', to: 'serverAudio' },
  { label: '最初の音声データ → スピーカー再生', from: 'serverAudio', to: 'firstSound' },
  { label: '起動処理 → 最初の音（合計）', from: 'trigger', to: 'firstSound' },
  { label: '発話の終わり → 最初の音（合計）', from: 'speechEnd', to: 'firstSound' },
];

export const MEMORY_SPANS: Array<{ label: string; from: string; to: string }> = [
  { label: '発言の終わり → AI が記憶検索を要求', from: 'speechEnd', to: 'toolRequested' },
  { label: '記憶検索（ローカルサーバーとの往復）', from: 'toolRequested', to: 'toolReturned' },
  { label: '検索結果 → AI の回答音声', from: 'toolReturned', to: 'serverAudio' },
  { label: '発言の終わり → 回答音声（合計）', from: 'speechEnd', to: 'serverAudio' },
];

/** Server-Timing ヘッダー（例: persona;dur=1.2, secret;dur=410）を [名前, ms] の一覧に */
export function parseServerTiming(h: string | null): Array<[string, number]> {
  if (!h) return [];
  return h
    .split(',')
    .map((part) => {
      const [name, ...params] = part.trim().split(';');
      const dur = params.map((x) => /^\s*dur=([\d.]+)/.exec(x)).find(Boolean);
      return [name!.trim(), dur ? Number(dur[1]) : NaN] as [string, number];
    })
    .filter(([n, v]) => n && Number.isFinite(v));
}

