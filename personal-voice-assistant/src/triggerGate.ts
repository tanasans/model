/**
 * 拍手・音声呼びかけ・ボタンからの会話開始を 1 つにまとめる「関所」。
 * 実行中は後から来た開始要求を無視するため、同時に検知しても接続は 1 回だけになる。
 * （サーバー側の同時接続数 1 の制限、useVoiceSession 側の二重開始防止と合わせた三重の対策）
 */
export function createTriggerGate() {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    /** 実行中でなければ fn を実行して true、実行中なら何もせず false */
    async run(fn: () => Promise<void>): Promise<boolean> {
      if (busy) return false;
      busy = true;
      try {
        await fn();
      } finally {
        busy = false;
      }
      return true;
    },
  };
}
