/**
 * 長期記憶のデータベース（SQLite。Node.js 組み込みの node:sqlite を使い、追加のネイティブモジュールは不要）。
 * - データはユーザー専用のローカル領域に保存（dataDir.ts）。OpenAI には接続しない
 * - 既存のデータベースを上書きしない。壊れていた場合は別名で残してから新しく作る
 * - 削除した記憶は内容を消して「削除済み」の印だけ残す（検索・AI への提供・バックアップに再登場しない）
 * - ログに記憶や会話の内容を出さない
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  isMemoryCategory,
  isNearDuplicate,
  bigrams,
  MEMORY_LIMITS,
  normalizeText,
  type MemoryCategory,
  type MemoryRecord,
  type MemorySettings,
  type MessageRecord,
  type SessionRecord,
  type SessionTrigger,
  type TranscriptStatus,
} from '../../shared/memory.js';

/**
 * データ形式の版。v1：初版。v2：発言の検索用の正規化済み文字列（messages.norm）と、会話の開始日時の索引を追加（検索の高速化）
 */
export const SCHEMA_VERSION = 3;
export const DB_FILE = 'kaito-memory.sqlite';

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual','clap','wake'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT,
  status TEXT NOT NULL CHECK (status IN ('final','failed','interrupted')),
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  norm TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('preference','decision','schedule','other')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','deleted')),
  deleted_at INTEGER,
  sensitive INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL CHECK (origin IN ('voice','manual','import'))
);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status, updated_at);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS: MemorySettings = { historyEnabled: true, includePreferences: true, autoExtract: false, summaryEnabled: false, semanticEnabled: false };

export class MemoryError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'NOT_FOUND' | 'DUPLICATE' | 'UNAVAILABLE' | 'SECRET',
    message: string,
  ) {
    super(message);
  }
}

type Row = Record<string, SQLInputValue>;

/** node:sqlite の読み込み（Node.js 22.13 未満では使えない → 記憶機能だけを無効にする） */
export async function loadSqlite(): Promise<typeof import('node:sqlite') | null> {
  // 「実験的機能」の警告を 1 回だけ抑える（動作には影響しない）
  const orig = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    const text = typeof w === 'string' ? w : w.message;
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
    (orig as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import('node:sqlite');
  } catch {
    return null;
  } finally {
    process.emitWarning = orig;
  }
}

export interface OpenResult {
  store: MemoryStore | null;
  error: string | null;
  warnings: string[];
}

/** データベースを開く（無ければ作る）。失敗しても例外は投げず、理由を返す */
export async function openMemoryStore(dataDir: string, now = () => Date.now()): Promise<OpenResult> {
  const warnings: string[] = [];
  const sqlite = await loadSqlite();
  if (!sqlite) {
    return {
      store: null,
      warnings,
      error: `この Node.js（${process.version}）では SQLite を使えないため、記憶機能は無効です。Node.js 22.13 以上（推奨 24 LTS）に更新してください。ほかの機能は使えます。`,
    };
  }
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (e) {
    return { store: null, warnings, error: `保存先のフォルダを作れませんでした（${describe(e)}）：${dataDir}` };
  }
  const file = path.join(dataDir, DB_FILE);
  const open = (): DatabaseSync => {
    const db = new sqlite.DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;');
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== 'ok') {
      db.close();
      throw new CorruptError(String(check?.quick_check ?? 'unknown'));
    }
    return db;
  };
  let db: DatabaseSync;
  try {
    db = open();
  } catch (e) {
    const corrupt = e instanceof CorruptError || /not a database|malformed|corrupt/i.test(describe(e));
    if (!corrupt || !existsSync(file)) {
      return { store: null, warnings, error: `記憶データベースを開けませんでした（${describe(e)}）。ほかのアプリが使用中でないか、保存先の権限を確認してください：${file}` };
    }
    // 壊れたファイルは消さずに別名で残し、新しいデータベースを作る
    const keep = path.join(dataDir, `kaito-memory.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.sqlite`);
    try {
      renameSync(file, keep);
      for (const ext of ['-wal', '-shm']) if (existsSync(file + ext)) renameSync(file + ext, keep + ext);
      db = open();
      warnings.push(`記憶データベースが壊れていたため、新しく作り直しました。元のファイルは ${keep} に残しています。`);
    } catch (e2) {
      return { store: null, warnings, error: `壊れた記憶データベースを作り直せませんでした（${describe(e2)}）：${file}` };
    }
  }
  try {
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version > SCHEMA_VERSION) {
      db.close();
      return { store: null, warnings, error: `記憶データは新しい版の KAITO で作られています（データ形式 ${version}）。データを壊さないよう、この版では記憶機能を無効にしました。新しい版を使ってください。` };
    }
    if (version < 1) {
      db.exec('BEGIN');
      db.exec(SCHEMA_V1);
      db.exec('PRAGMA user_version = 1');
      db.exec('COMMIT');
    }
    if (version < 2) migrateToV2(db);
    if (version < 3) migrateToV3(db);
    db.exec('PRAGMA journal_mode = WAL');
  } catch (e) {
    try {
      db.close();
    } catch {
      /* 閉じられなくても続行 */
    }
    return { store: null, warnings, error: `記憶データベースの準備に失敗しました（${describe(e)}）。` };
  }
  return { store: new MemoryStore(db, file, now), warnings, error: null };
}

class CorruptError extends Error {}

/** v2 → v3：会話の要約（sessions.summary）と、記憶の埋め込み（memories.embedding）を追加。既存の内容は変えない */
export function migrateToV3(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const has = (t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).some((x) => x.name === c);
    if (!has('sessions', 'summary')) db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT');
    if (!has('memories', 'embedding')) db.exec('ALTER TABLE memories ADD COLUMN embedding BLOB');
    db.exec('PRAGMA user_version = 3');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** v1 → v2：既存の発言にも検索用の正規化済み文字列を付ける（内容は変えない）。途中で失敗したら元に戻す */
export function migrateToV2(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'norm')) db.exec('ALTER TABLE messages ADD COLUMN norm TEXT');
    const upd = db.prepare('UPDATE messages SET norm = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, text FROM messages WHERE text IS NOT NULL AND norm IS NULL').all() as Array<{ id: number; text: string }>) {
      upd.run(normalizeText(r.text), r.id);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)');
    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function describe(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, ' ').slice(0, 160);
}

export interface SearchMemoriesInput {
  query?: string | null;
  category?: MemoryCategory | null;
  from?: number | null;
  to?: number | null;
  limit?: number;
  includeSensitive?: boolean;
  /** 検索語との一致度の下限（既定 0.5。見つからないときに緩めて探し直す） */
  minScore?: number;
}

export interface MessageHit extends MessageRecord {
  sessionId: string;
  sessionStartedAt: number;
}

export interface BackupData {
  format: 'kaito-memory-backup';
  version: 1;
  exportedAt: string;
  settings: MemorySettings;
  memories: MemoryRecord[];
  sessions: Array<SessionRecord & { messages: MessageRecord[] }>;
}

export class MemoryStore {
  constructor(
    private readonly db: DatabaseSync,
    readonly file: string,
    private readonly now: () => number,
  ) {}

  close(): void {
    this.db.close();
  }

  private all(sql: string, ...p: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  private get(sql: string, ...p: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }
  private run(sql: string, ...p: SQLInputValue[]): { changes: number | bigint } {
    return this.db.prepare(sql).run(...p);
  }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- 設定 ----------
  getSettings(): MemorySettings {
    const rows = this.all('SELECT key, value FROM settings');
    const m = new Map(rows.map((r) => [String(r.key), String(r.value)]));
    const b = (k: string, d: boolean) => (m.has(k) ? m.get(k) === '1' : d);
    return {
      historyEnabled: b('history_enabled', DEFAULT_SETTINGS.historyEnabled),
      includePreferences: b('include_preferences', DEFAULT_SETTINGS.includePreferences),
      autoExtract: false, // 未実装（有効にできない）
      summaryEnabled: b('summary_enabled', false),
      semanticEnabled: b('semantic_enabled', false),
    };
  }
  updateSettings(p: Partial<MemorySettings>): MemorySettings {
    const set = (k: string, v: boolean) => this.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v ? '1' : '0');
    if (typeof p.historyEnabled === 'boolean') set('history_enabled', p.historyEnabled);
    if (typeof p.includePreferences === 'boolean') set('include_preferences', p.includePreferences);
    if (typeof p.summaryEnabled === 'boolean') set('summary_enabled', p.summaryEnabled);
    if (typeof p.semanticEnabled === 'boolean') set('semantic_enabled', p.semanticEnabled);
    return this.getSettings();
  }

  counts(): { memories: number; sessions: number; messages: number } {
    const n = (sql: string) => Number(this.get(sql)?.n ?? 0);
    return {
      memories: n("SELECT COUNT(*) n FROM memories WHERE status = 'active'"),
      sessions: n('SELECT COUNT(*) n FROM sessions'),
      messages: n('SELECT COUNT(*) n FROM messages'),
    };
  }

  // ---------- 長期記憶 ----------
  private toMemory(r: Row): MemoryRecord {
    return {
      id: String(r.id),
      content: String(r.content),
      category: String(r.category) as MemoryCategory,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      sourceSessionId: r.source_session_id === null ? null : String(r.source_session_id),
      sensitive: Number(r.sensitive) === 1,
      origin: String(r.origin) as MemoryRecord['origin'],
    };
  }

  getMemory(id: string): MemoryRecord | null {
    const r = this.get("SELECT * FROM memories WHERE id = ? AND status = 'active'", id);
    return r ? this.toMemory(r) : null;
  }

  /** 同じ（またはほぼ同じ）内容の有効な記憶 */
  findDuplicate(content: string, exceptId?: string): MemoryRecord | null {
    const norm = normalizeText(content);
    const rows = this.all("SELECT * FROM memories WHERE status = 'active'");
    for (const r of rows) {
      if (exceptId && r.id === exceptId) continue;
      if (String(r.norm) === norm || isNearDuplicate(String(r.content), content)) return this.toMemory(r);
    }
    return null;
  }

  addMemory(i: { content: string; category: MemoryCategory; sourceSessionId?: string | null; sensitive?: boolean; origin: MemoryRecord['origin'] }): { memory: MemoryRecord; duplicate: boolean } {
    const content = cleanContent(i.content);
    if (!isMemoryCategory(i.category)) throw new MemoryError('BAD_REQUEST', '分類が不正です。');
    const dup = this.findDuplicate(content);
    if (dup) return { memory: dup, duplicate: true };
    const id = randomUUID();
    const t = this.now();
    const src = i.sourceSessionId && this.sessionExists(i.sourceSessionId) ? i.sourceSessionId : null;
    this.run(
      "INSERT INTO memories (id, content, norm, category, created_at, updated_at, source_session_id, status, sensitive, origin) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
      id, content, normalizeText(content), i.category, t, t, src, i.sensitive ? 1 : 0, i.origin,
    );
    return { memory: this.getMemory(id)!, duplicate: false };
  }

  updateMemory(id: string, p: { content?: string | null; category?: MemoryCategory | null; sensitive?: boolean }): MemoryRecord {
    const cur = this.getMemory(id);
    if (!cur) throw new MemoryError('NOT_FOUND', '指定された記憶は見つかりません（削除済みの可能性があります）。');
    const content = p.content == null ? cur.content : cleanContent(p.content);
    if (p.category != null && !isMemoryCategory(p.category)) throw new MemoryError('BAD_REQUEST', '分類が不正です。');
    const dup = p.content == null ? null : this.findDuplicate(content, id);
    if (dup) throw new MemoryError('DUPLICATE', '同じ内容の記憶がすでにあります。');
    this.run(
      // 内容が変わったら埋め込みは作り直す（古い内容で意味検索に出ないように消す）
      'UPDATE memories SET content = ?, norm = ?, category = ?, sensitive = ?, updated_at = ?, embedding = CASE WHEN content = ? THEN embedding ELSE NULL END WHERE id = ?',
      content, normalizeText(content), p.category ?? cur.category, (p.sensitive ?? cur.sensitive) ? 1 : 0, this.now(), content, id,
    );
    return this.getMemory(id)!;
  }

  /** 削除：内容を消し、削除済みの印だけ残す（復元・検索・AI への提供・バックアップの対象外） */
  // ---------- 意味検索（埋め込み）・会話の要約 ----------
  setEmbedding(id: string, v: Float32Array): void {
    this.run("UPDATE memories SET embedding = ? WHERE id = ? AND status = 'active'", new Uint8Array(v.buffer, v.byteOffset, v.byteLength), id);
  }

  /** 埋め込みがまだ無い有効な記憶（最大 limit 件） */
  memoriesWithoutEmbedding(limit = 200): Array<{ id: string; content: string }> {
    return this.all("SELECT id, content FROM memories WHERE status = 'active' AND embedding IS NULL LIMIT ?", limit).map((r) => ({ id: String(r.id), content: String(r.content) }));
  }

  /** 意味の近い記憶（コサイン類似度が minSim 以上、上位 limit 件） */
  semanticSearch(q: Float32Array, opts: { limit?: number; minSim?: number; category?: MemoryCategory | null } = {}): Array<MemoryRecord & { score: number }> {
    const rows = this.all("SELECT * FROM memories WHERE status = 'active' AND embedding IS NOT NULL" + (opts.category ? ' AND category = ?' : ''), ...(opts.category ? [opts.category] : []));
    const qn = Math.hypot(...q);
    const out: Array<MemoryRecord & { score: number }> = [];
    for (const r of rows) {
      const b = r.embedding as Uint8Array;
      const v = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      if (v.length !== q.length) continue;
      let dot = 0;
      let vn = 0;
      for (let i = 0; i < v.length; i++) {
        dot += v[i]! * q[i]!;
        vn += v[i]! * v[i]!;
      }
      const sim = dot / (Math.sqrt(vn) * qn || 1);
      if (sim >= (opts.minSim ?? 0.35)) out.push({ ...this.toMemory(r), score: sim });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 5);
  }

  setSummary(sessionId: string, summary: string): void {
    this.run('UPDATE sessions SET summary = ? WHERE id = ?', summary.slice(0, 600), sessionId);
  }

  getSummary(sessionId: string): string | null {
    const r = this.get('SELECT summary FROM sessions WHERE id = ?', sessionId);
    return r && r.summary !== null ? String(r.summary) : null;
  }

  /** 要約に渡す文字起こし（確定した発言だけ。最大 maxChars 文字） */
  transcriptFor(sessionId: string, maxChars = 6000): string {
    return this.getMessages(sessionId)
      .filter((m) => m.text)
      .map((m) => `${m.role === 'user' ? 'ユーザー' : 'KAITO'}：${m.text}`)
      .join('\n')
      .slice(-maxChars);
  }

  /** 要約の検索（検索語の一致度で） */
  searchSummaries(i: { query?: string | null; from?: number | null; to?: number | null; limit?: number }): Array<{ sessionId: string; startedAt: number; summary: string }> {
    const where = ['summary IS NOT NULL'];
    const p: SQLInputValue[] = [];
    if (i.from != null) {
      where.push('started_at >= ?');
      p.push(i.from);
    }
    if (i.to != null) {
      where.push('started_at < ?');
      p.push(i.to);
    }
    const rows = this.all(`SELECT id, started_at, summary FROM sessions WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT 500`, ...p);
    const words = queryWords((i.query ?? '').trim());
    return rows
      .map((r) => ({ sessionId: String(r.id), startedAt: Number(r.started_at), summary: String(r.summary), score: words.length ? scoreNorm(words, normalizeText(String(r.summary))) : 1 }))
      .filter((x) => x.score >= 0.5)
      .slice(0, i.limit ?? 5)
      .map(({ score: _s, ...x }) => x);
  }

  deleteMemory(id: string): boolean {
    const r = this.run("UPDATE memories SET status = 'deleted', content = '', norm = '', embedding = NULL, source_session_id = NULL, deleted_at = ?, updated_at = ? WHERE id = ? AND status = 'active'", this.now(), this.now(), id);
    return Number(r.changes) > 0;
  }

  /** 全件削除：記憶の行そのものを消す */
  deleteAllMemories(): number {
    const active = this.counts().memories;
    this.run('DELETE FROM memories');
    this.vacuum();
    return active;
  }

  searchMemories(i: SearchMemoriesInput = {}): Array<MemoryRecord & { score: number }> {
    const where = ["status = 'active'"];
    const p: SQLInputValue[] = [];
    if (i.category) {
      where.push('category = ?');
      p.push(i.category);
    }
    if (i.from != null) {
      where.push('updated_at >= ?');
      p.push(i.from);
    }
    if (i.to != null) {
      where.push('created_at < ?');
      p.push(i.to);
    }
    if (i.includeSensitive === false) where.push('sensitive = 0');
    const q = (i.query ?? '').trim();
    const limit = i.limit ?? 100;
    const words = queryWords(q);
    // 検索語の 2 文字の組を 1 つも含まない記憶は、SQLite の中で先に除く（JavaScript での採点を減らす）
    if (words.length) {
      const grams = [...new Set(words.flatMap((w) => [...w]))].slice(0, 60);
      where.push(`(${grams.map(() => 'instr(norm, ?) > 0').join(' OR ')})`);
      p.push(...grams);
    }
    const rows = this.all(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`, ...p);
    if (!words.length) return rows.slice(0, limit).map((r) => ({ ...this.toMemory(r), score: 1 }));
    return rows
      .map((r) => ({ ...this.toMemory(r), score: scoreNorm(words, String(r.norm)) }))
      .filter((m) => m.score >= (i.minScore ?? 0.5))
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  /** 会話の最初に渡す「好み」（機微な情報を除く・新しい順） */
  startPreferences(): MemoryRecord[] {
    return this.searchMemories({ category: 'preference', includeSensitive: false, limit: MEMORY_LIMITS.startPreferences });
  }

  // ---------- 会話履歴 ----------
  sessionExists(id: string): boolean {
    return Boolean(this.get('SELECT 1 x FROM sessions WHERE id = ?', id));
  }

  startSession(trigger: SessionTrigger, startedAt: number): string {
    const id = randomUUID();
    this.run('INSERT INTO sessions (id, started_at, trigger) VALUES (?, ?, ?)', id, startedAt, trigger);
    return id;
  }

  endSession(id: string): void {
    this.run('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL', this.now(), id);
  }

  /** 発言を記録（同じ発言 ID は上書き。確定した文字起こしだけを受け付ける） */
  putMessage(sessionId: string, m: { itemId: string; seq: number; role: 'user' | 'assistant'; text: string | null; status: TranscriptStatus }): void {
    if (!this.sessionExists(sessionId)) throw new MemoryError('NOT_FOUND', '会話が見つかりません。');
    const text = m.status === 'failed' ? null : (m.text ?? '').slice(0, MEMORY_LIMITS.messageChars).trim() || null;
    this.run(
      `INSERT INTO messages (session_id, item_id, seq, role, text, norm, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, item_id) DO UPDATE SET text = excluded.text, norm = excluded.norm, status = excluded.status`,
      sessionId, m.itemId, m.seq, m.role, text, text === null ? null : normalizeText(text), text === null ? 'failed' : m.status, this.now(),
    );
  }

  listSessions(i: { query?: string | null; from?: number | null; to?: number | null; limit?: number } = {}): SessionRecord[] {
    const where: string[] = [];
    const p: SQLInputValue[] = [];
    if (i.from != null) {
      where.push('s.started_at >= ?');
      p.push(i.from);
    }
    if (i.to != null) {
      where.push('s.started_at < ?');
      p.push(i.to);
    }
    const rows = this.all(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n FROM sessions s ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.started_at DESC LIMIT ?`,
      ...p, i.limit ?? 200,
    );
    let sessions = rows.map((r) => ({
      id: String(r.id),
      startedAt: Number(r.started_at),
      endedAt: r.ended_at === null ? null : Number(r.ended_at),
      trigger: String(r.trigger) as SessionTrigger,
      messageCount: Number(r.n),
    }));
    const q = (i.query ?? '').trim();
    if (q) {
      const hitIds = new Set(this.searchMessages({ query: q, from: i.from, to: i.to, limit: 1000 }).map((h) => h.sessionId));
      sessions = sessions.filter((s) => hitIds.has(s.id));
    }
    return sessions;
  }

  getMessages(sessionId: string): MessageRecord[] {
    return this.all('SELECT * FROM messages WHERE session_id = ? ORDER BY seq, id', sessionId).map(toMessage);
  }

  /** 発言の検索（確定した文字起こしだけ）。検索語なしなら、期間内の発言を古い順に */
  searchMessages(i: { query?: string | null; from?: number | null; to?: number | null; limit?: number; minScore?: number }): Array<MessageHit & { score: number }> {
    const where = ['m.text IS NOT NULL'];
    const p: SQLInputValue[] = [];
    if (i.from != null) {
      where.push('s.started_at >= ?');
      p.push(i.from);
    }
    if (i.to != null) {
      where.push('s.started_at < ?');
      p.push(i.to);
    }
    const q = (i.query ?? '').trim();
    const limit = i.limit ?? 50;
    const words = queryWords(q);
    const hit = (r: Row, score: number) => ({ ...toMessage(r), sessionId: String(r.session_id), sessionStartedAt: Number(r.s_started), score });
    if (!words.length) {
      // 検索語なし（日付だけ）：期間内の発言を新しい方から limit 件、古い順に並べて返す
      const rows = this.all(
        `SELECT m.*, s.started_at AS s_started FROM messages m JOIN sessions s ON s.id = m.session_id WHERE ${where.join(' AND ')} ORDER BY s.started_at DESC, m.seq DESC LIMIT ?`,
        ...p, limit,
      );
      return rows.map((r) => hit(r, 1)).reverse();
    }
    // 検索語の 2 文字の組を 1 つも含まない発言は SQLite の中で除く。件数の上限なしで全期間を検索する
    const grams = [...new Set(words.flatMap((w) => [...w]))].slice(0, 60);
    where.push(`(${grams.map(() => 'instr(m.norm, ?) > 0').join(' OR ')})`);
    p.push(...grams);
    // 1 段目：採点に必要な列だけを読む（本文全体は読まない） → 2 段目：上位だけ本文を読む
    const light = this.all(`SELECT m.id AS id, m.norm AS norm, m.seq AS seq, s.started_at AS s_started FROM messages m JOIN sessions s ON s.id = m.session_id WHERE ${where.join(' AND ')}`, ...p);
    const minScore = i.minScore ?? 0.5;
    const top: Array<{ id: number; score: number; started: number; seq: number }> = [];
    for (const r of light) {
      const score = scoreNorm(words, String(r.norm ?? ''));
      if (score >= minScore) top.push({ id: Number(r.id), score, started: Number(r.s_started), seq: Number(r.seq) });
    }
    top.sort((a, b) => b.score - a.score || b.started - a.started || a.seq - b.seq);
    const picked = top.slice(0, limit);
    if (!picked.length) return [];
    const full = new Map(
      this.all(`SELECT m.*, s.started_at AS s_started FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id IN (${picked.map(() => '?').join(',')})`, ...picked.map((x) => x.id)).map((r) => [Number(r.id), r]),
    );
    return picked.filter((x) => full.has(x.id)).map((x) => hit(full.get(x.id)!, x.score));
  }

  deleteSession(id: string): boolean {
    const r = this.run('DELETE FROM sessions WHERE id = ?', id);
    // 記憶の情報源の参照も外す（会話の内容は残さない）
    this.run('UPDATE memories SET source_session_id = NULL WHERE source_session_id = ?', id);
    return Number(r.changes) > 0;
  }

  deleteAllSessions(): number {
    const r = this.run('DELETE FROM sessions');
    this.run('UPDATE memories SET source_session_id = NULL');
    this.vacuum();
    return Number(r.changes);
  }

  private vacuum(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      this.db.exec('VACUUM');
    } catch {
      /* 失敗しても削除自体は完了している */
    }
  }

  // ---------- バックアップ・復元 ----------
  exportBackup(): BackupData {
    const sessions = this.listSessions({ limit: 1_000_000 }).map((s) => ({ ...s, messages: this.getMessages(s.id) }));
    return {
      format: 'kaito-memory-backup',
      version: 1,
      exportedAt: new Date(this.now()).toISOString(),
      settings: this.getSettings(),
      memories: this.searchMemories({ limit: 1_000_000 }).map(({ score: _s, ...m }) => m),
      sessions,
    };
  }

  /** 復元。merge＝既存を残して無いものだけ追加（同じ ID・同じ内容は追加しない）、replace＝全部入れ替え */
  restoreBackup(raw: unknown, mode: 'merge' | 'replace'): { memories: number; sessions: number; skipped: number } {
    const data = validateBackup(raw);
    return this.tx(() => {
      if (mode === 'replace') {
        this.run('DELETE FROM sessions');
        this.run('DELETE FROM memories');
      }
      let sessions = 0;
      let memories = 0;
      let skipped = 0;
      for (const s of data.sessions) {
        if (this.sessionExists(s.id)) {
          skipped++;
          continue;
        }
        this.run('INSERT INTO sessions (id, started_at, ended_at, trigger) VALUES (?, ?, ?, ?)', s.id, s.startedAt, s.endedAt, s.trigger);
        s.messages.forEach((m, i) => {
          this.run(
            'INSERT INTO messages (session_id, item_id, seq, role, text, norm, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            s.id, `restored-${i}`, m.seq, m.role, m.text, m.text === null ? null : normalizeText(m.text), m.text === null ? 'failed' : m.status, m.createdAt,
          );
        });
        sessions++;
      }
      for (const m of data.memories) {
        if (this.get('SELECT 1 x FROM memories WHERE id = ?', m.id) || this.findDuplicate(m.content)) {
          skipped++;
          continue;
        }
        const src = m.sourceSessionId && this.sessionExists(m.sourceSessionId) ? m.sourceSessionId : null;
        this.run(
          "INSERT INTO memories (id, content, norm, category, created_at, updated_at, source_session_id, status, sensitive, origin) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
          m.id, m.content, normalizeText(m.content), m.category, m.createdAt, m.updatedAt, src, m.sensitive ? 1 : 0, m.origin,
        );
        memories++;
      }
      if (mode === 'replace') this.updateSettings(data.settings);
      return { memories, sessions, skipped };
    });
  }

  /** 入れ替え前などに、現在の内容を JSON で保存（dataDir/backups/） */
  snapshot(dir: string, label: string): string {
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `kaito-memory-${label}-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(f, JSON.stringify(this.exportBackup(), null, 1), 'utf8');
    return f;
  }
}

function toMessage(r: Row): MessageRecord {
  return {
    seq: Number(r.seq),
    role: String(r.role) as 'user' | 'assistant',
    text: r.text === null ? null : String(r.text),
    status: String(r.status) as TranscriptStatus,
    createdAt: Number(r.created_at),
  };
}

function cleanContent(s: unknown): string {
  if (typeof s !== 'string') throw new MemoryError('BAD_REQUEST', '記憶の内容が不正です。');
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) throw new MemoryError('BAD_REQUEST', '記憶の内容が空です。');
  if (t.length > MEMORY_LIMITS.contentChars) throw new MemoryError('BAD_REQUEST', `記憶の内容が長すぎます（${MEMORY_LIMITS.contentChars} 文字まで）。`);
  return t;
}

/** 検索語（空白区切りは AND）を、正規化した 2 文字の組の集合にする */
function queryWords(query: string): Array<Set<string>> {
  return query
    .split(/[\s　,、]+/)
    .map((w) => bigrams(normalizeText(w)))
    .filter((g) => g.size > 0);
}

/** 正規化済みの本文に対する一致度（検索語ごとの「含まれる 2 文字の組の割合」の最小値） */
function scoreNorm(words: Array<Set<string>>, norm: string): number {
  let min = 1;
  for (const g of words) {
    let hit = 0;
    for (const x of g) if (norm.includes(x)) hit++;
    min = Math.min(min, hit / g.size);
  }
  return min;
}

function validateBackup(raw: unknown): BackupData {
  const bad = (m: string) => new MemoryError('BAD_REQUEST', `バックアップの形式が正しくありません（${m}）。`);
  if (!raw || typeof raw !== 'object') throw bad('JSON ではありません');
  const d = raw as Record<string, unknown>;
  if (d.format !== 'kaito-memory-backup' || d.version !== 1) throw bad('KAITO の記憶バックアップではありません');
  if (!Array.isArray(d.memories) || !Array.isArray(d.sessions)) throw bad('memories / sessions がありません');
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const memories = d.memories.map((m, i) => {
    const r = m as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.content !== 'string' || !r.content.trim() || r.content.length > MEMORY_LIMITS.contentChars || !isMemoryCategory(r.category) || !num(r.createdAt) || !num(r.updatedAt)) throw bad(`記憶 ${i + 1} 件目`);
    return {
      id: r.id,
      content: r.content.trim(),
      category: r.category,
      createdAt: r.createdAt as number,
      updatedAt: r.updatedAt as number,
      sourceSessionId: typeof r.sourceSessionId === 'string' ? r.sourceSessionId : null,
      sensitive: r.sensitive === true,
      origin: 'import' as const,
    };
  });
  const sessions = d.sessions.map((s, i) => {
    const r = s as Record<string, unknown>;
    if (typeof r.id !== 'string' || !num(r.startedAt) || !['manual', 'clap', 'wake'].includes(String(r.trigger)) || !Array.isArray(r.messages)) throw bad(`会話 ${i + 1} 件目`);
    const messages = r.messages.map((m, j) => {
      const x = m as Record<string, unknown>;
      if (!num(x.seq) || (x.role !== 'user' && x.role !== 'assistant') || !['final', 'failed', 'interrupted'].includes(String(x.status)) || !(x.text === null || typeof x.text === 'string') || !num(x.createdAt)) throw bad(`会話 ${i + 1} の発言 ${j + 1}`);
      return { seq: x.seq as number, role: x.role as 'user' | 'assistant', text: x.text === null ? null : String(x.text).slice(0, MEMORY_LIMITS.messageChars), status: x.status as TranscriptStatus, createdAt: x.createdAt as number };
    });
    return { id: r.id, startedAt: r.startedAt as number, endedAt: num(r.endedAt) ? (r.endedAt as number) : null, trigger: r.trigger as SessionTrigger, messageCount: messages.length, messages };
  });
  const st = (d.settings ?? {}) as Record<string, unknown>;
  return {
    format: 'kaito-memory-backup',
    version: 1,
    exportedAt: typeof d.exportedAt === 'string' ? d.exportedAt : '',
    settings: { historyEnabled: st.historyEnabled !== false, includePreferences: st.includePreferences !== false, autoExtract: false, summaryEnabled: st.summaryEnabled === true, semanticEnabled: st.semanticEnabled === true },
    memories,
    sessions,
  };
}
