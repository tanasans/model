import type { DataSource, ToolErrorCode } from '../../shared/tools.js';

/**
 * データ取得ツールの共通インターフェース。
 * 新しいデータ源（例: JRA-VAN Data Lab. の出馬表、株式分析システム）は、これを実装して registry に登録する。
 * - parse: 入力の検証（不正なら ToolError('BAD_INPUT')）
 * - run  : 取得。取得できない値は null のまま返し、推測で補わない
 */
export interface DataTool<A, T> {
  name: string;
  source: DataSource;
  parse(args: unknown): A;
  run(args: A, ctx: ToolContext): Promise<T>;
}

export interface ToolContext {
  now: Date;
  fetch: typeof fetch;
}

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
  }
}
