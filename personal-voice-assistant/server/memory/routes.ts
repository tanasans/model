/**
 * 記憶管理の API（ローカル専用）。OpenAI には接続しない。本文はログに出さない。
 */
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import path from 'node:path';
import { isMemoryCategory, resolveRange, type MemoryStatus, type SessionTrigger } from '../../shared/memory.js';
import { runMemoryTool, isMemoryToolName } from './service.js';
import { MemoryError, SCHEMA_VERSION, type MemoryStore } from './store.js';

export interface MemoryHolder {
  store: MemoryStore | null;
  error: string | null;
  warnings: string[];
  dataDir: string;
  dbPath: string;
}

type Log = (msg: string) => void;

const TOOL_WINDOW_MS = 60_000;
const TOOL_MAX = 60;

export function memoryRouter(h: MemoryHolder, guard: (req: Request, res: Response, next: NextFunction) => void, log: Log): Router {
  const r = express.Router();
  let toolCalls: number[] = [];

  const need = (res: Response): MemoryStore | null => {
    if (!h.store) {
      res.status(503).json({ code: 'UNAVAILABLE', message: h.error ?? '記憶機能が使えません。' });
      return null;
    }
    return h.store;
  };
  const fail = (res: Response, e: unknown, what: string) => {
    if (e instanceof MemoryError) {
      res.status(e.code === 'NOT_FOUND' ? 404 : 400).json({ code: e.code, message: e.message });
      return;
    }
    log(`memory ${what} failed: ${e instanceof Error ? e.name : 'error'}`);
    res.status(500).json({ code: 'INTERNAL', message: '記憶の処理に失敗しました。保存先の権限や空き容量を確認してください。' });
  };
  const q = (v: unknown) => (typeof v === 'string' ? v : null);

  r.get('/status', guard, (_req, res) => {
    const s = h.store;
    const body: MemoryStatus = {
      available: Boolean(s),
      error: h.error,
      warnings: h.warnings,
      dataDir: h.dataDir,
      dbPath: h.dbPath,
      schemaVersion: s ? SCHEMA_VERSION : 0,
      settings: s ? s.getSettings() : { historyEnabled: false, includePreferences: false, autoExtract: false },
      counts: s ? s.counts() : { memories: 0, sessions: 0, messages: 0 },
      nodeVersion: process.version,
    };
    res.json(body);
  });

  r.put('/settings', guard, express.json({ limit: '2kb' }), (req, res) => {
    const s = need(res);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    res.json(s.updateSettings({
      ...(typeof b.historyEnabled === 'boolean' ? { historyEnabled: b.historyEnabled } : {}),
      ...(typeof b.includePreferences === 'boolean' ? { includePreferences: b.includePreferences } : {}),
    }));
  });

  // ---------- 長期記憶 ----------
  r.get('/memories', guard, (req, res) => {
    const s = need(res);
    if (!s) return;
    const range = resolveRange(q(req.query.from), q(req.query.to), new Date());
    const category = isMemoryCategory(req.query.category) ? req.query.category : null;
    res.json(s.searchMemories({ query: q(req.query.q), category, from: range.from, to: range.to, limit: 500 }));
  });

  r.post('/memories', guard, express.json({ limit: '8kb' }), (req, res) => {
    const s = need(res);
    if (!s) return;
    try {
      const b = req.body ?? {};
      const out = s.addMemory({ content: b.content, category: isMemoryCategory(b.category) ? b.category : 'other', sensitive: b.sensitive === true, origin: 'manual' });
      res.json(out);
    } catch (e) {
      fail(res, e, 'add');
    }
  });

  r.patch('/memories/:id', guard, express.json({ limit: '8kb' }), (req, res) => {
    const s = need(res);
    if (!s) return;
    try {
      const b = req.body ?? {};
      res.json(s.updateMemory(String(req.params.id), {
        content: typeof b.content === 'string' ? b.content : null,
        category: isMemoryCategory(b.category) ? b.category : null,
        ...(typeof b.sensitive === 'boolean' ? { sensitive: b.sensitive } : {}),
      }));
    } catch (e) {
      fail(res, e, 'update');
    }
  });

  r.delete('/memories/:id', guard, (req, res) => {
    const s = need(res);
    if (!s) return;
    res.json({ deleted: s.deleteMemory(String(req.params.id)) });
  });

  r.post('/memories/delete-all', guard, express.json({ limit: '1kb' }), (req, res) => {
    const s = need(res);
    if (!s) return;
    if (req.body?.confirm !== 'DELETE') {
      res.status(400).json({ code: 'BAD_REQUEST', message: '確認の指定がありません。' });
      return;
    }
    const n = s.deleteAllMemories();
    log(`memory: all memories deleted (${n})`);
    res.json({ deleted: n });
  });

  // ---------- 会話履歴 ----------
  r.get('/sessions', guard, (req, res) => {
    const s = need(res);
    if (!s) return;
    const range = resolveRange(q(req.query.from), q(req.query.to), new Date());
    res.json(s.listSessions({ query: q(req.query.q), from: range.from, to: range.to, limit: 300 }));
  });

  r.get('/sessions/:id', guard, (req, res) => {
    const s = need(res);
    if (!s) return;
    res.json(s.getMessages(String(req.params.id)));
  });

  r.delete('/sessions/:id', guard, (req, res) => {
    const s = need(res);
    if (!s) return;
    res.json({ deleted: s.deleteSession(String(req.params.id)) });
  });

  r.post('/sessions/delete-all', guard, express.json({ limit: '1kb' }), (req, res) => {
    const s = need(res);
    if (!s) return;
    if (req.body?.confirm !== 'DELETE') {
      res.status(400).json({ code: 'BAD_REQUEST', message: '確認の指定がありません。' });
      return;
    }
    const n = s.deleteAllSessions();
    log(`memory: all sessions deleted (${n})`);
    res.json({ deleted: n });
  });

  /** 会話の記録を始める（会話履歴の保存が OFF なら記録しない） */
  r.post('/sessions', guard, express.json({ limit: '1kb' }), (req, res) => {
    const s = need(res);
    if (!s) return;
    if (!s.getSettings().historyEnabled) {
      res.json({ id: null, historyEnabled: false });
      return;
    }
    const trigger: SessionTrigger = ['manual', 'clap', 'wake'].includes(req.body?.trigger) ? req.body.trigger : 'manual';
    const startedAt = Number.isFinite(req.body?.startedAt) && Math.abs(req.body.startedAt - Date.now()) < 3_600_000 ? Number(req.body.startedAt) : Date.now();
    res.json({ id: s.startSession(trigger, startedAt), historyEnabled: true });
  });

  r.post('/sessions/:id/messages', guard, express.json({ limit: '32kb' }), (req, res) => {
    const s = need(res);
    if (!s) return;
    const b = req.body ?? {};
    if (typeof b.itemId !== 'string' || b.itemId.length > 128 || !Number.isInteger(b.seq) || (b.role !== 'user' && b.role !== 'assistant') || !['final', 'failed', 'interrupted'].includes(b.status) || !(b.text === null || typeof b.text === 'string')) {
      res.status(400).json({ code: 'BAD_REQUEST', message: '発言の形式が不正です。' });
      return;
    }
    if (!s.getSettings().historyEnabled) {
      res.status(204).end(); // 途中で OFF にした場合は以後保存しない
      return;
    }
    try {
      s.putMessage(String(req.params.id), b);
      res.status(204).end();
    } catch (e) {
      fail(res, e, 'message');
    }
  });

  r.post('/sessions/:id/end', guard, (req, res) => {
    h.store?.endSession(String(req.params.id));
    res.status(204).end();
  });

  // ---------- 音声の記憶操作（Function Calling） ----------
  r.post('/tool/:name', guard, express.json({ limit: '8kb' }), (req, res) => {
    const name = req.params.name;
    if (!isMemoryToolName(name)) {
      res.status(404).json({ ok: false, error: '不明な操作です。' });
      return;
    }
    const now = Date.now();
    toolCalls = toolCalls.filter((t) => now - t < TOOL_WINDOW_MS);
    if (toolCalls.length >= TOOL_MAX) {
      res.status(429).json({ ok: false, error: '短時間に操作が多すぎます。' });
      return;
    }
    toolCalls.push(now);
    const args = (req.body?.args ?? {}) as Record<string, unknown>;
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : null;
    const out = runMemoryTool(h.store, name, args, { sessionId, now: new Date() });
    log(`memory tool ${name} ${out.ok ? 'ok' : 'refused'}`);
    res.json(out);
  });

  // ---------- バックアップ・復元 ----------
  r.get('/backup', guard, (_req, res) => {
    const s = need(res);
    if (!s) return;
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="kaito-memory-backup-${stamp}.json"`);
    res.json(s.exportBackup());
  });

  r.post('/restore', guard, express.json({ limit: '20mb' }), (req, res) => {
    const s = need(res);
    if (!s) return;
    const mode = req.body?.mode === 'replace' ? 'replace' : 'merge';
    try {
      let snapshot: string | null = null;
      if (mode === 'replace') snapshot = s.snapshot(path.join(h.dataDir, 'backups'), 'before-restore');
      const out = s.restoreBackup(req.body?.backup, mode);
      log(`memory restored (${mode}) memories=${out.memories} sessions=${out.sessions}`);
      res.json({ ...out, mode, snapshot });
    } catch (e) {
      fail(res, e, 'restore');
    }
  });

  return r;
}
