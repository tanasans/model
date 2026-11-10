/**
 * 長期記憶（v1）の共有定義。サーバーとクライアントの両方で使う純粋な関数だけを置く。
 * - 会話履歴：確定した文字起こしだけ。音声は保存しない
 * - 長期記憶：本人が明示的に頼んだものを保存。自動抽出は設定で有効にするまで行わない（v1 では未実装）
 */

export const MEMORY_CATEGORIES = ['preference', 'decision', 'schedule', 'other'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  preference: '好み',
  decision: '決定事項',
  schedule: '予定',
  other: 'その他',
};
export function isMemoryCategory(v: unknown): v is MemoryCategory {
  return typeof v === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(v);
}

export type TranscriptStatus = 'final' | 'failed' | 'interrupted';
export const TRANSCRIPT_STATUS_LABEL: Record<TranscriptStatus, string> = {
  final: '確定',
  failed: '文字起こし失敗',
  interrupted: '途中で中断',
};
export type SessionTrigger = 'manual' | 'clap' | 'wake';

export const MEMORY_LIMITS = {
  contentChars: 500,
  messageChars: 4000,
  /** AI に渡す検索結果の上限（トークンと個人情報の送信を抑える） */
  toolMemories: 10,
  toolMessages: 12,
  toolSnippetChars: 160,
  /** 会話開始時に渡す「好み」の上限 */
  startPreferences: 5,
  startPreferenceChars: 600,
} as const;

export interface MemoryRecord {
  id: string;
  content: string;
  category: MemoryCategory;
  createdAt: number;
  updatedAt: number;
  sourceSessionId: string | null;
  /** 健康・お金などの機微な情報（本人の確認を得て保存したもの）。会話開始時には渡さない */
  sensitive: boolean;
  origin: 'voice' | 'manual' | 'import';
}

export interface MessageRecord {
  seq: number;
  role: 'user' | 'assistant';
  text: string | null;
  status: TranscriptStatus;
  createdAt: number;
}

export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt: number | null;
  trigger: SessionTrigger;
  messageCount: number;
}

export interface MemorySettings {
  /** 会話履歴を保存する */
  historyEnabled: boolean;
  /** 会話の最初に「好み」の記憶（最大 5 件・機微な情報を除く）を渡す */
  includePreferences: boolean;
  /** 会話全体からの自動的な記憶抽出（v1 では未実装。常に false） */
  autoExtract: boolean;
  /** 会話の自動要約（会話の終了後、文字起こしを OpenAI に送って 2〜3 文に要約。少額の料金。既定 OFF） */
  summaryEnabled: boolean;
  /** 意味で探す検索（記憶を OpenAI の埋め込みで数値化。言葉が一致しなくても近い内容を探す。少額の料金。既定 OFF） */
  semanticEnabled: boolean;
}

export interface MemoryStatus {
  available: boolean;
  /** 使えない理由（Node.js の版が古い、ファイルにアクセスできない等） */
  error: string | null;
  warnings: string[];
  dataDir: string;
  dbPath: string;
  schemaVersion: number;
  settings: MemorySettings;
  counts: { memories: number; sessions: number; messages: number };
  nodeVersion: string;
  /** 要約・意味検索に使える OpenAI の設定があるか（APIキー） */
  aiAvailable: boolean;
  aiModels: { summary: string; embedding: string } | null;
}

// ---------- 文字列の正規化・類似度（日本語は単語の区切りが無いため 2 文字ずつで比べる） ----------

/** 比較用に正規化：全角半角・大文字小文字・カタカナ/ひらがなをそろえ、空白と記号を除く */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s、。，．,.!?！？・「」『』（）()[\]{}【】〈〉《》"'`~〜…:：;；\-ー_/\\|]+/g, '');
}

export function bigrams(norm: string): Set<string> {
  const out = new Set<string>();
  if (norm.length === 1) out.add(norm);
  for (let i = 0; i + 1 < norm.length; i++) out.add(norm.slice(i, i + 2));
  return out;
}

/** 2 つの文の似ている度合い（0〜1、Jaccard） */
export function similarity(a: string, b: string): number {
  const A = bigrams(normalizeText(a));
  const B = bigrams(normalizeText(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 検索語がどれだけ含まれるか（0〜1）。検索語の 2 文字の組のうち、本文に含まれる割合 */
export function matchScore(query: string, text: string): number {
  const q = bigrams(normalizeText(query));
  if (!q.size) return 0;
  const t = normalizeText(text);
  let hit = 0;
  for (const x of q) if (t.includes(x)) hit++;
  return hit / q.size;
}

/** 重複とみなす類似度 */
export const DUPLICATE_SIMILARITY = 0.85;

/** 重複とみなすか：ほぼ同じ文、または一方が他方を含み長さがほぼ同じ（「〜が好き」と「〜が好きです」など） */
export function isNearDuplicate(a: string, b: string): boolean {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.includes(short) && short.length / long.length >= 0.75) return true;
  return similarity(a, b) >= DUPLICATE_SIMILARITY;
}

// ---------- 機微な情報 ----------

const HEALTH = /(病気|病院|通院|入院|手術|診断|持病|症状|薬|服薬|処方|血圧|血糖|アレルギー|障害|妊娠|うつ|メンタル|精神科|心療内科|がん|癌|検査結果|体重|health|medical)/i;
const MONEY = /(口座|暗証|カード番号|借金|ローン|年収|給料|資産額|預金)/;

/** 機微な情報らしいか（保存前に本人の確認が必要） */
export function detectSensitive(text: string): string | null {
  if (HEALTH.test(text)) return '健康に関する情報';
  if (MONEY.test(text)) return 'お金に関する情報';
  return null;
}

// ---------- 保存の依頼の確認（誤起動・頼まれていない保存を防ぐ） ----------

const SAVE_REQUEST = /(覚え|おぼえ|記憶し|記憶に|メモ|忘れん|忘れない|わすれない|控えて|登録し|残して|残しと|残しとい)/;

/** 「覚えてる？」（思い出す質問）は保存の依頼ではない。「覚えといて」「覚えとって」「メモして」は依頼 */
const RECALL_QUESTION = /(覚え|おぼえ)(てる|ている|てます|てません|とる|とります|てない|とらん)/;
const IMPERATIVE = /((覚え|おぼえ)(て(お|と)?いて|とって|といて|ておいて|ておいてね|て(ね|な|ください|くれ))|記憶して|メモして|メモしと|控えて|残して|残しと|忘れんよう|忘れないよう|忘れないで|登録して)/;

export function isSaveRequest(text: string): boolean {
  if (IMPERATIVE.test(text)) return true;
  if (RECALL_QUESTION.test(text)) return false;
  return SAVE_REQUEST.test(text);
}

export type SaveGate = { ok: true } | { ok: false; reason: string };

/**
 * save_memory を実行してよいか。
 * - この会話でユーザーの発言（確定した文字起こし）が 1 回もなければ保存しない（誤起動の会話から登録しない）
 * - 直近のユーザー発言に「覚えて」等が無く、AI も明示的な依頼と申告していなければ保存しない
 */
export function checkSaveRequest(o: { userFinalCount: number; recentUserTexts: string[]; explicitRequest: boolean }): SaveGate {
  if (o.userFinalCount === 0) return { ok: false, reason: 'この会話ではユーザーの発言を確認できていないため、保存しませんでした。' };
  const asked = o.recentUserTexts.slice(-3).some(isSaveRequest);
  if (!asked && !o.explicitRequest) {
    return { ok: false, reason: '保存を頼まれていません。保存してよいかユーザーに確認し、了承を得たときだけ explicit_request=true で保存してください。' };
  }
  return { ok: true };
}

// ---------- 日付 ----------

const DAY_MS = 86_400_000;

/** 'today' / 'yesterday' / 'YYYY-MM-DD' を、その日の 0 時（ローカル時刻）の時刻に。不正なら null */
export function resolveDay(v: string | null | undefined, now: Date): number | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (s === 'today' || s === '今日') return start;
  if (s === 'yesterday' || s === '昨日') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (s === 'day_before_yesterday' || s === '一昨日' || s === 'おととい') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2).getTime();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d.getTime() : null;
}

/** 範囲 [from, to)：to は指定日の翌日 0 時 */
export function resolveRange(from: string | null | undefined, to: string | null | undefined, now: Date): { from: number | null; to: number | null } {
  const f = resolveDay(from, now);
  const t = resolveDay(to, now);
  return { from: f, to: t === null ? null : t + DAY_MS };
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
export function formatLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}（${WEEK[d.getDay()]}）${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 会話の指示に加える「長期記憶」の決まり ----------

export function buildMemoryInstructions(o: { available: boolean; now: Date; preferences: Array<{ content: string }> }): string {
  const today = formatLocal(o.now.getTime());
  if (!o.available) {
    return [
      '# 長期記憶',
      `- 現在の日時：${today}（このパソコンの時刻）`,
      '- 現在、記憶機能は使えません。過去の会話や以前に決めたことを聞かれたら、覚えているふりをせず「確認できません」と答えてください。',
    ].join('\n');
  }
  const lines = [
    '# 長期記憶',
    `- 現在の日時：${today}（このパソコンの時刻）。「昨日」「先週」などは日付（YYYY-MM-DD）に直して使ってください。`,
    '- 過去の会話・以前に決めたこと・好み・予定を聞かれたら、必ず search_memory で調べ、その結果だけで答えてください。見つからなければ「確認できません」と答え、覚えているふりをしないでください。',
    '- 会話履歴の検索結果は、確定した文字起こしだけです。「文字起こし失敗」の発言の内容は推測しないでください。',
    '- save_memory は、ユーザーが「覚えておいて」などと明示的に頼んだときだけ使ってください。頼まれていないのに保存しないでください。',
    '- 健康・お金などの機微な情報は、保存してよいかユーザーに確認し、了承を得たときだけ sensitive_confirmed=true で保存してください。パスワード・APIキーなどの認証情報は保存しないでください。',
    '- 記憶を直すとき：search_memory で対象を特定し、どの記憶を直すかユーザーに確認してから update_memory を使ってください。',
    '- 記憶を消すとき：search_memory で対象を特定し、「この記憶を消してええ？」と確認して了承を得てから delete_memory（confirmed=true）を使ってください。',
    '- すでに同じ内容がある場合は、新しく保存せず、必要なら update_memory で直してください。',
  ];
  if (o.preferences.length) {
    lines.push('', '# 保存済みの好み（参考。ユーザーが以前に保存を頼んだもの）');
    let total = 0;
    for (const p of o.preferences.slice(0, MEMORY_LIMITS.startPreferences)) {
      const c = p.content.slice(0, 200);
      if (total + c.length > MEMORY_LIMITS.startPreferenceChars) break;
      total += c.length;
      lines.push(`- ${c}`);
    }
  }
  return lines.join('\n');
}
