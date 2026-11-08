import type { ToolResult } from '../../shared/tools.js';
import { ToolError, type DataTool, type ToolContext } from './types.js';
import { weatherTool } from './weather.js';

/**
 * 登録済みのデータ取得ツール。
 * 将来の追加例（今回は未実装）:
 *  - 'race-card' : 既存の JRA-VAN Data Lab. 取得処理（JV-Link を使う Windows 側の処理）が出力した
 *                  データ（DB・CSV・ローカル HTTP）を読み、出馬表として返す
 *  - 'stock'     : 既存の株式分析システムの結果（読み取り専用）を返す。売買などの実行操作は行わない
 */
const TOOLS: Record<string, DataTool<any, any>> = {
  [weatherTool.name]: weatherTool,
};

export async function runTool(name: string, args: unknown, ctx: Partial<ToolContext> = {}): Promise<ToolResult<unknown>> {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, tool: name, error: { code: 'UNKNOWN_TOOL', message: '不明なツールです。' } };
  const full: ToolContext = { now: ctx.now ?? new Date(), fetch: ctx.fetch ?? fetch };
  try {
    const parsed = tool.parse(args);
    const data = await tool.run(parsed, full);
    return { ok: true, tool: name, data, source: tool.source, fetchedAt: full.now.toISOString() };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, tool: name, error: { code: e.code, message: e.message } };
    return { ok: false, tool: name, error: { code: 'UPSTREAM_ERROR', message: 'データの取得に失敗しました。' } };
  }
}

export function toolNames(): string[] {
  return Object.keys(TOOLS);
}
