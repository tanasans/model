import type { DoubleClapDetail, TransientInfo } from './clapDetector';

/**
 * 拍手で起動したときの履歴（判定の根拠と、その後に本当に話しかけたか）。
 * - 保存するのは判定値（数値）だけ。音声・会話内容・個人情報は保存しない
 * - このブラウザの localStorage のみ（外部送信なし）。最新 20 件
 * - 「起動したのに話しかけなかった」が続いたら誤起動とみなし、拍手待機を自動で止める（不要な Realtime API 接続を減らす）
 */
export const CLAP_HISTORY_KEY = 'pva.clapHistory.v1';
export const CLAP_HISTORY_MAX = 20;
/** この時間内に「話しかけなし」の拍手起動が GUARD_COUNT 回続いたら拍手待機を止める */
export const GUARD_WINDOW_MS = 10 * 60_000;
export const GUARD_COUNT = 2;

export type ClapOutcome =
  /** 会話を開始中・会話中 */
  | 'pending'
  /** 会話で話しかけた（正しい起動） */
  | 'spoke'
  /** 話しかけないまま自動終了（誤起動の可能性が高い） */
  | 'no-speech'
  /** 会話を開始できなかった（エラー等） */
  | 'not-started'
  /** テストモード（会話は開始していない） */
  | 'test';

export interface SoundSummary {
  levelDb: number;
  jumpDb: number;
  riseMs: number;
  decayDb: number;
  centroidHz: number;
  crest: number;
  tailDb: number;
  /** キーボード音との違い（登録がある場合のみ） */
  kbd: number | null;
}

export interface ClapTriggerRecord {
  id: string;
  at: number;
  intervalMs: number;
  quietBeforeMs: number;
  softBefore: number;
  floorDb: number;
  triggerDb: number;
  sensitivity: number;
  profileKind: string;
  usedSignature: boolean;
  sounds: [SoundSummary, SoundSummary];
  outcome: ClapOutcome;
}

const OUTCOMES: ClapOutcome[] = ['pending', 'spoke', 'no-speech', 'not-started', 'test'];

export const OUTCOME_LABEL: Record<ClapOutcome, string> = {
  pending: '会話中',
  spoke: '会話あり',
  'no-speech': '話しかけなし（誤起動の可能性）',
  'not-started': '会話を開始できず',
  test: 'テストモード',
};

function summarize(i: TransientInfo): SoundSummary {
  return {
    levelDb: i.levelDb,
    jumpDb: i.jumpDb,
    riseMs: i.riseMs,
    decayDb: i.decayDb,
    centroidHz: i.centroidHz,
    crest: i.crest,
    tailDb: i.tailDb,
    kbd: i.checks.find((c) => c.key === 'kbd')?.value ?? null,
  };
}

export function recordFromDetail(
  d: DoubleClapDetail,
  o: { at: number; profileKind: string; outcome: ClapOutcome; id?: string },
): ClapTriggerRecord {
  return {
    id: o.id ?? `${o.at.toString(36)}-${Math.round(d.intervalMs)}`,
    at: o.at,
    intervalMs: d.intervalMs,
    quietBeforeMs: d.quietBeforeMs,
    softBefore: d.softBefore,
    floorDb: d.floorDb,
    triggerDb: d.triggerDb,
    sensitivity: d.sensitivity,
    profileKind: o.profileKind,
    usedSignature: d.usedSignature,
    sounds: [summarize(d.first), summarize(d.second)],
    outcome: o.outcome,
  };
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validSound(v: unknown): v is SoundSummary {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return ['levelDb', 'jumpDb', 'riseMs', 'decayDb', 'centroidHz', 'crest', 'tailDb'].every((k) => isNum(s[k])) && (s.kbd === null || isNum(s.kbd));
}

function validRecord(v: unknown): v is ClapTriggerRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    ['at', 'intervalMs', 'quietBeforeMs', 'softBefore', 'floorDb', 'triggerDb', 'sensitivity'].every((k) => isNum(r[k])) &&
    typeof r.profileKind === 'string' &&
    typeof r.usedSignature === 'boolean' &&
    Array.isArray(r.sounds) &&
    r.sounds.length === 2 &&
    r.sounds.every(validSound) &&
    OUTCOMES.includes(r.outcome as ClapOutcome)
  );
}

export function loadClapHistory(store: KV | null = storage()): ClapTriggerRecord[] {
  try {
    const raw = JSON.parse(store?.getItem(CLAP_HISTORY_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(validRecord).slice(0, CLAP_HISTORY_MAX);
  } catch {
    return [];
  }
}

export function saveClapHistory(list: ClapTriggerRecord[], store: KV | null = storage()): void {
  try {
    store?.setItem(CLAP_HISTORY_KEY, JSON.stringify(list.slice(0, CLAP_HISTORY_MAX)));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

/** 新しい記録を先頭に追加（最新 20 件） */
export function addRecord(list: ClapTriggerRecord[], rec: ClapTriggerRecord): ClapTriggerRecord[] {
  return [rec, ...list.filter((r) => r.id !== rec.id)].slice(0, CLAP_HISTORY_MAX);
}

export function setOutcome(list: ClapTriggerRecord[], id: string, outcome: ClapOutcome): ClapTriggerRecord[] {
  return list.map((r) => (r.id === id ? { ...r, outcome } : r));
}

/**
 * 誤起動が続いているか：sinceMs 以降の会話を開始した拍手起動のうち、直近 GUARD_COUNT 件がすべて
 * 「話しかけなし」で、GUARD_WINDOW_MS 以内に収まっている。
 */
export function shouldPauseClap(list: ClapTriggerRecord[], now: number, sinceMs = 0): boolean {
  const live = list.filter((r) => r.at >= sinceMs && r.outcome !== 'test' && r.outcome !== 'pending' && r.outcome !== 'not-started');
  const recent = live.slice(0, GUARD_COUNT);
  if (recent.length < GUARD_COUNT) return false;
  return recent.every((r) => r.outcome === 'no-speech') && now - recent[recent.length - 1]!.at <= GUARD_WINDOW_MS;
}
