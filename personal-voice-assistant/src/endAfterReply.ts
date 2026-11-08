/**
 * 声で「終わって」と言われたときの終了処理（画面から独立した純粋なロジック。テスト可能）。
 * KAITO の別れの一言を最後まで再生してから切断する。
 *
 * - 終了を要求した時点で KAITO の音声が再生中なら、その再生が終わったら切断
 * - そうでなければ、次の返答（別れの一言）の再生開始を待ち、再生が終わったら切断
 * - 返答の音声が始まらない場合（WAIT_FOR_AUDIO_MS）や長すぎる場合（MAX_WAIT_MS）でも必ず切断する
 *
 * 再生の開始・終了は WebRTC のサーバーイベント output_audio_buffer.started / stopped を使う。
 */
export const WAIT_FOR_AUDIO_MS = 5_000;
export const MAX_WAIT_MS = 15_000;
/** 再生終了の直後に切ると最後の音が途切れることがあるため、少しだけ待つ */
export const AFTER_AUDIO_MS = 400;

export interface Timers {
  set: (fn: () => void, ms: number) => number;
  clear: (id: number) => void;
}

const browserTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

export function createEndAfterReply(onEnd: () => void, timers: Timers = browserTimers) {
  let playing = false;
  let pending = false;
  let sawAudio = false;
  let done = false;
  const ids: number[] = [];

  const clearAll = () => {
    while (ids.length) timers.clear(ids.pop()!);
  };
  const finish = () => {
    if (done) return;
    done = true;
    pending = false;
    clearAll();
    onEnd();
  };
  const later = (ms: number) => ids.push(timers.set(finish, ms));

  return {
    /** 終了を予約する（2 回目以降は無視） */
    request() {
      if (pending || done) return;
      pending = true;
      sawAudio = playing;
      later(MAX_WAIT_MS);
      if (!sawAudio) {
        // 別れの一言が始まらなければ、待たずに切断
        ids.push(timers.set(() => !sawAudio && finish(), WAIT_FOR_AUDIO_MS));
      }
    },
    /** Realtime のサーバーイベント（transport_event）を渡す */
    onEvent(type: string) {
      if (type === 'output_audio_buffer.started') {
        playing = true;
        if (pending) sawAudio = true;
      } else if (type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') {
        playing = false;
        if (pending && sawAudio) later(AFTER_AUDIO_MS);
      }
    },
    /** 会話が別の理由で終わったとき（タイマーを残さない） */
    dispose() {
      done = true;
      pending = false;
      clearAll();
    },
    get pending() {
      return pending;
    },
  };
}

export type EndAfterReply = ReturnType<typeof createEndAfterReply>;
