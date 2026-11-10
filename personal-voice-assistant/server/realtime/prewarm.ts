/**
 * OpenAI への通信の準備（事前ウォームアップ）。
 * サーバー起動後の最初の会話だけ接続が約 1 秒遅い（名前解決・暗号化の準備・通信部品の読み込み）ため、
 * 起動時と PC のスリープ復帰時に 1 回だけ、API キーを付けずに OpenAI へ短い問い合わせ（HEAD）を送って準備しておく。
 * - API キー・会話の内容は送らない（認証なしなので API の利用・料金にはならない）
 * - 待機中に繰り返し送らない（起動時・復帰時だけ。最短でも 60 秒あける）
 * - 失敗しても何もしない（会話は従来どおり接続できる）
 */
export interface Prewarm {
  warm(reason: string): Promise<number | null>;
  /** スリープ復帰（タイマーの大きな遅れ）を検出して準備し直す。戻り値で監視を止める */
  watchResume(intervalMs?: number): () => void;
}

export function createPrewarm(opts: {
  url: string;
  log: (msg: string) => void;
  fetchFn?: typeof fetch;
  now?: () => number;
  minGapMs?: number;
}): Prewarm {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const minGap = opts.minGapMs ?? 60_000;
  let last = -Infinity;
  let inflight: Promise<number | null> | null = null;

  const warm = (reason: string): Promise<number | null> => {
    if (inflight) return inflight;
    if (now() - last < minGap) return Promise.resolve(null);
    last = now();
    const t = performance.now();
    inflight = fetchFn(opts.url, { method: 'HEAD', signal: AbortSignal.timeout(8_000) })
      .then(
        (res) => {
          void res.body?.cancel().catch(() => undefined);
          const ms = Math.round(performance.now() - t);
          opts.log(`prewarm (${reason}) ${ms}ms`);
          return ms;
        },
        () => {
          opts.log(`prewarm (${reason}) failed`);
          return null;
        },
      )
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const watchResume = (intervalMs = 30_000) => {
    let prev = now();
    const timer = setInterval(() => {
      const cur = now();
      // タイマーが 60 秒以上遅れた＝PC がスリープしていた
      if (cur - prev > intervalMs + 60_000) void warm('resume');
      prev = cur;
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  return { warm, watchResume };
}
