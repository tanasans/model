/**
 * 音声の記憶操作（Function Calling の save_memory / search_memory / update_memory / delete_memory）の処理本体。
 * - AI に返すのは必要な件数・文字数だけ（全履歴は送らない）
 * - 認証情報は保存しない。健康・お金の情報は本人の確認（sensitive_confirmed）がある場合だけ保存
 * - 削除は確認（confirmed）が必須
 */
import { secretKindIn } from '../../shared/persona.js';
import {
  CATEGORY_LABEL,
  detectSensitive,
  formatLocal,
  isMemoryCategory,
  MEMORY_LIMITS,
  resolveRange,
  TRANSCRIPT_STATUS_LABEL,
  type MemoryCategory,
  type MemoryRecord,
} from '../../shared/memory.js';
import { MemoryError, type MemoryStore } from './store.js';

export const MEMORY_TOOL_NAMES = ['save_memory', 'search_memory', 'update_memory', 'delete_memory'] as const;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];
export function isMemoryToolName(v: unknown): v is MemoryToolName {
  return typeof v === 'string' && (MEMORY_TOOL_NAMES as readonly string[]).includes(v);
}

export type ToolReply = Record<string, unknown> & { ok: boolean };

const str = (v: unknown) => (typeof v === 'string' ? v : null);

function forModel(m: MemoryRecord) {
  return {
    memory_id: m.id,
    content: m.content,
    category: CATEGORY_LABEL[m.category],
    saved: formatLocal(m.createdAt),
    ...(m.updatedAt !== m.createdAt ? { updated: formatLocal(m.updatedAt) } : {}),
    ...(m.sensitive ? { sensitive: true } : {}),
  };
}

export function runMemoryTool(store: MemoryStore | null, name: MemoryToolName, args: Record<string, unknown>, ctx: { sessionId: string | null; now: Date }): ToolReply {
  if (!store) return { ok: false, error: '記憶機能が使えません。過去の会話や記憶について聞かれたら「確認できません」と答えてください。' };
  try {
    switch (name) {
      case 'save_memory':
        return save(store, args, ctx);
      case 'search_memory':
        return search(store, args, ctx);
      case 'update_memory':
        return update(store, args);
      case 'delete_memory':
        return remove(store, args);
    }
  } catch (e) {
    if (e instanceof MemoryError) return { ok: false, error: e.message };
    return { ok: false, error: '記憶の処理に失敗しました。' };
  }
}

function save(store: MemoryStore, a: Record<string, unknown>, ctx: { sessionId: string | null }): ToolReply {
  const content = str(a.content)?.trim() ?? '';
  const category: MemoryCategory = isMemoryCategory(a.category) ? a.category : 'other';
  if (!content) return { ok: false, error: '保存する内容が空です。' };
  const secret = secretKindIn(content);
  if (secret) return { ok: false, error: `${secret}が含まれているため保存しません。パスワードや API キーは記憶に残さないでください。` };
  const sensitive = detectSensitive(content);
  if (sensitive && a.sensitive_confirmed !== true) {
    return {
      ok: false,
      needs_confirmation: true,
      error: `${sensitive}のようです。保存してよいかユーザーに確認し、了承を得たときだけ sensitive_confirmed=true で保存してください。`,
    };
  }
  const r = store.addMemory({ content, category, sourceSessionId: ctx.sessionId, sensitive: Boolean(sensitive), origin: 'voice' });
  if (r.duplicate) {
    return {
      ok: true,
      duplicate: true,
      memory: forModel(r.memory),
      instruction: '同じ内容がすでに保存されているため、新しくは保存していません。内容を変える必要があれば update_memory を使ってください。',
    };
  }
  return { ok: true, saved: true, memory: forModel(r.memory), instruction: '保存しました。何を覚えたかを短く伝えてください。' };
}

function search(store: MemoryStore, a: Record<string, unknown>, ctx: { now: Date }): ToolReply {
  const query = str(a.query)?.trim() ?? '';
  const target = a.target === 'history' || a.target === 'memories' ? a.target : 'both';
  const category = isMemoryCategory(a.category) ? a.category : null;
  const range = resolveRange(str(a.date_from), str(a.date_to), ctx.now);
  if ((a.date_from && range.from === null) || (a.date_to && range.to === null)) {
    return { ok: false, error: '日付は today / yesterday / YYYY-MM-DD で指定してください。' };
  }
  // 一度の検索で採点し（一致度 0.3 以上）、0.5 以上があればそれだけを、無ければ緩めた結果を使う
  const memHits = target === 'history' ? [] : store.searchMemories({ query, category, from: range.from, to: range.to, limit: 50, minScore: 0.3 });
  const msgHits = target === 'memories' ? [] : store.searchMessages({ query, from: range.from, to: range.to, limit: 100, minScore: 0.3 });
  const strictMem = memHits.filter((m) => m.score >= 0.5);
  const strictMsg = msgHits.filter((m) => m.score >= 0.5);
  const relaxed = Boolean(query) && strictMem.length + strictMsg.length === 0 && memHits.length + msgHits.length > 0;
  const memories = (relaxed ? memHits : strictMem).slice(0, MEMORY_LIMITS.toolMemories).map(forModel);
  const history = (relaxed ? msgHits : strictMsg).slice(0, MEMORY_LIMITS.toolMessages).map((h) => ({
    when: formatLocal(h.sessionStartedAt),
    speaker: h.role === 'user' ? 'ユーザー' : 'KAITO',
    text: (h.text ?? '').slice(0, MEMORY_LIMITS.toolSnippetChars),
    ...(h.status !== 'final' ? { note: TRANSCRIPT_STATUS_LABEL[h.status] } : {}),
  }));
  const found = memories.length + history.length;
  return {
    ok: true,
    found,
    memories,
    history,
    instruction:
      found === 0
        ? '該当する記憶・会話履歴はありません。覚えているふりをせず「確認できません」と答えてください。'
        : relaxed
          ? '完全には一致しませんでしたが、近い内容が見つかりました。質問に合う内容のときだけ、この結果を根拠に答えてください。合わなければ「確認できません」と答えてください。'
          : 'この結果に書かれていることだけを根拠に答えてください。書かれていないことは推測しないでください。',
    ...(relaxed ? { relaxed: true } : {}),
  };
}

function update(store: MemoryStore, a: Record<string, unknown>): ToolReply {
  const id = str(a.memory_id);
  if (!id) return { ok: false, error: 'memory_id を指定してください（search_memory の結果にあります）。' };
  const content = str(a.content);
  const category = isMemoryCategory(a.category) ? a.category : null;
  if (!content && !category) return { ok: false, error: '変更する内容（content または category）を指定してください。' };
  if (content) {
    const secret = secretKindIn(content);
    if (secret) return { ok: false, error: `${secret}が含まれているため保存しません。` };
    const sensitive = detectSensitive(content);
    if (sensitive && a.sensitive_confirmed !== true) {
      return { ok: false, needs_confirmation: true, error: `${sensitive}のようです。ユーザーの了承を得たときだけ sensitive_confirmed=true で更新してください。` };
    }
  }
  const m = store.updateMemory(id, { content, category, ...(content ? { sensitive: Boolean(detectSensitive(content)) } : {}) });
  return { ok: true, updated: true, memory: forModel(m), instruction: 'どう直したかを短く伝えてください。' };
}

function remove(store: MemoryStore, a: Record<string, unknown>): ToolReply {
  const id = str(a.memory_id);
  if (!id) return { ok: false, error: 'memory_id を指定してください（search_memory の結果にあります）。' };
  const m = store.getMemory(id);
  if (!m) return { ok: false, error: '指定された記憶は見つかりません（すでに削除されている可能性があります）。' };
  if (a.confirmed !== true) {
    return {
      ok: false,
      needs_confirmation: true,
      memory: forModel(m),
      error: 'まだ削除していません。この記憶を消してよいかユーザーに確認し、了承を得てから confirmed=true で実行してください。',
    };
  }
  store.deleteMemory(id);
  return { ok: true, deleted: true, instruction: '削除しました。今後この内容は参照されません。' };
}
