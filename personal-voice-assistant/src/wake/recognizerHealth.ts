/**
 * 音声認識（Vosk）の健康管理。PC の処理が一時的に追いつかないと、未処理の音声（遅れ）がたまり、
 * 呼びかけから何十秒も後に認識されることがある（実機で確認。PC の再起動で解消、長時間の待機で再発することがある）。
 *
 * 1. 古い呼びかけで起動しない：遅れが STALE_SEC を超えているときの認識結果では起動しない
 * 2. 遅れがたまったら作り直す：遅れが REBUILD_SEC を超えた状態が REBUILD_HOLD_MS 続き、しかも静かな（誰も話していない）とき、
 *    音声認識を止めて読み込み直す（たまった音声を捨てる）。REBUILD_WINDOW_MS の間に REBUILD_MAX 回を超えたら、
 *    繰り返さずに音声待機を止めて理由を表示する
 * 3. 定期的な作り直し：待機が REFRESH_AFTER_MS 続いたら、静かなときに認識器だけを作り直す（数十 ms。OpenAI には接続しない）
 * どれも、遅れがない普段の待機中には何もしない。
 */
export const STALE_SEC = 2.5;
export const REBUILD_SEC = 4;
export const REBUILD_HOLD_MS = 3000;
export const REBUILD_WINDOW_MS = 5 * 60_000;
export const REBUILD_MAX = 3;
export const REFRESH_AFTER_MS = 60 * 60_000;

export type HealthAction = 'none' | 'rebuild' | 'refresh' | 'give-up';

export class RecognizerHealth {
  private overSince: number | null = null;
  private rebuilds: number[] = [];

  /** 1. 遅れが大きすぎて、この認識結果では起動しない */
  isStale(backlogSec: number): boolean {
    return backlogSec > STALE_SEC;
  }

  /**
   * 定期的に呼ぶ（約 100ms ごと）。
   * @param runningMs 今の認識器で待機している時間
   * @param quiet 直近 1 秒、周囲の騒音より大きい音（声）がない
   */
  check(now: number, backlogSec: number, runningMs: number, quiet: boolean): HealthAction {
    if (backlogSec > REBUILD_SEC) this.overSince ??= now;
    else this.overSince = null;
    if (this.overSince !== null && now - this.overSince >= REBUILD_HOLD_MS && quiet) {
      this.overSince = null;
      this.rebuilds = [...this.rebuilds.filter((t) => now - t < REBUILD_WINDOW_MS), now];
      if (this.rebuilds.length > REBUILD_MAX) {
        this.rebuilds = [];
        return 'give-up';
      }
      return 'rebuild';
    }
    if (runningMs >= REFRESH_AFTER_MS && quiet && backlogSec < 0.5) return 'refresh';
    return 'none';
  }
}
