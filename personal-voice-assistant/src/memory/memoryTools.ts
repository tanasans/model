import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { checkSaveRequest, MEMORY_CATEGORIES } from '../../shared/memory';

/**
 * 音声の記憶操作（Function Calling）。処理はローカルサーバー（SQLite）で行い、OpenAI には結果の要点だけが渡る。
 * save_memory は、この会話でユーザーの確定した発言があり、保存を頼まれた場合だけ実行する（誤起動・頼まれていない保存の防止）。
 */
export interface MemoryToolContext {
  /** 今の会話の記録（会話履歴の保存 ID・確定したユーザー発言） */
  current: () => { sessionId: string | null; userFinalCount: number; recentUserTexts: string[] } | null;
  fetchImpl?: typeof fetch;
}

export async function callMemoryTool(name: string, args: Record<string, unknown>, sessionId: string | null, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<Record<string, unknown>> {
  try {
    const res = await fetchImpl(`/api/memory/tool/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args, sessionId }),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return body ?? { ok: false, error: `記憶の処理に失敗しました（HTTP ${res.status}）。` };
  } catch {
    return { ok: false, error: 'ローカルサーバーに接続できないため、記憶を使えません。「確認できません」と答えてください。' };
  }
}

/** save_memory の実行前の確認（テスト用に分けている） */
export function gateSave(ctx: MemoryToolContext, explicitRequest: boolean) {
  const cur = ctx.current();
  return checkSaveRequest({ userFinalCount: cur?.userFinalCount ?? 0, recentUserTexts: cur?.recentUserTexts ?? [], explicitRequest });
}

export function createMemoryTools(ctx: MemoryToolContext) {
  const sid = () => ctx.current()?.sessionId ?? null;
  const category = z.enum(MEMORY_CATEGORIES);

  const save = tool({
    name: 'save_memory',
    description:
      '長期記憶に保存する。ユーザーが「覚えておいて」「メモして」などと明示的に頼んだときだけ使う。頼まれていない内容や会話全体を保存しない。同じ内容がすでにあれば保存しない。',
    parameters: z.object({
      content: z.string().describe('保存する内容を、後で読んで分かる短い文で（例：「開発の次の段階は長期記憶。11月中に完成予定」）'),
      category: category.describe('preference=好み、decision=決定事項、schedule=予定、other=その他'),
      explicit_request: z.boolean().describe('ユーザーが保存をはっきり頼んだ、または保存してよいか確認して了承を得た場合 true'),
      sensitive_confirmed: z.boolean().describe('健康・お金などの機微な情報について、保存してよいとユーザーの了承を得た場合だけ true'),
    }),
    execute: async (input) => {
      const g = gateSave(ctx, input.explicit_request);
      if (!g.ok) return { ok: false, error: g.reason };
      return callMemoryTool('save_memory', input, sid(), ctx.fetchImpl);
    },
  });

  const search = tool({
    name: 'search_memory',
    description:
      '長期記憶と会話履歴を検索する。過去の会話・以前に決めたこと・好み・予定を聞かれたら必ず使い、その結果だけで答える。見つからなければ「確認できません」と答える。',
    parameters: z.object({
      query: z.string().describe('検索する言葉（例：「開発予定」）。日付だけで探すときは空文字'),
      target: z.enum(['memories', 'history', 'both']).describe('memories=保存した記憶、history=会話履歴、both=両方'),
      category: category.nullable().describe('記憶の分類で絞る場合のみ。なければ null'),
      date_from: z.string().nullable().describe('開始日。today / yesterday / YYYY-MM-DD。なければ null'),
      date_to: z.string().nullable().describe('終了日（その日を含む）。today / yesterday / YYYY-MM-DD。なければ null'),
    }),
    execute: async (input) => callMemoryTool('search_memory', input, sid(), ctx.fetchImpl),
  });

  const update = tool({
    name: 'update_memory',
    description: '保存済みの記憶を訂正する。search_memory で対象の memory_id を確かめ、どれを直すかユーザーに確認してから使う。',
    parameters: z.object({
      memory_id: z.string().describe('search_memory の結果の memory_id'),
      content: z.string().nullable().describe('新しい内容。変えない場合は null'),
      category: category.nullable().describe('新しい分類。変えない場合は null'),
      sensitive_confirmed: z.boolean().describe('機微な情報について了承を得た場合だけ true'),
    }),
    execute: async (input) => callMemoryTool('update_memory', input, sid(), ctx.fetchImpl),
  });

  const remove = tool({
    name: 'delete_memory',
    description: '保存済みの記憶を削除する。search_memory で対象を特定し、「この記憶を消してええ？」と確認して了承を得てから confirmed=true で使う。',
    parameters: z.object({
      memory_id: z.string().describe('search_memory の結果の memory_id'),
      confirmed: z.boolean().describe('ユーザーが削除を了承した場合だけ true'),
    }),
    execute: async (input) => callMemoryTool('delete_memory', input, sid(), ctx.fetchImpl),
  });

  return [save, search, update, remove];
}
