/**
 * 二重起動の防止（画面）：KAITO の画面は 1 つだけ動かす。
 * ブラウザの Web Locks（同じ http://localhost:5173 のタブ・ウィンドウで共有）を使い、最初に開いた画面だけが動く。
 * 2 つ目以降の画面は待機・マイク・音声認識を一切始めず、「すでに起動しています」を表示する。
 * 先の画面を閉じた（落ちた）ときはロックが自動で外れる。「こちらで使う」を選ぶと、先の画面は止まって案内表示に変わる。
 */
export const UI_LOCK_NAME = 'kaito-ui';

type Locks = {
  request(name: string, options: { ifAvailable?: boolean; steal?: boolean }, cb: (lock: unknown) => Promise<unknown>): Promise<unknown>;
};

function locks(): Locks | null {
  try {
    return (navigator as unknown as { locks?: Locks }).locks ?? null;
  } catch {
    return null;
  }
}

/** ロックを持ち続ける（画面を閉じるまで）。ほかの画面に奪われたら onLost を呼ぶ */
function hold(l: Locks, opts: { ifAvailable?: boolean; steal?: boolean }, onLost: () => void): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    l.request(UI_LOCK_NAME, opts, (lock) => {
      if (!lock) {
        resolve(false);
        return Promise.resolve();
      }
      resolve(true);
      return new Promise<never>(() => undefined); // 画面を閉じるまで離さない
    }).catch(() => onLost()); // 「こちらで使う」で奪われた
  });
}

/** 最初の画面なら 'owner'、ほかの画面がすでに動いていれば 'busy'（Web Locks が使えないブラウザでは常に 'owner'） */
export async function acquireUi(onLost: () => void): Promise<'owner' | 'busy'> {
  const l = locks();
  if (!l) return 'owner';
  try {
    return (await hold(l, { ifAvailable: true }, onLost)) ? 'owner' : 'busy';
  } catch {
    return 'owner';
  }
}

/** ほかの画面を止めて、この画面で使う */
export async function takeOverUi(onLost: () => void): Promise<void> {
  const l = locks();
  if (!l) return;
  await hold(l, { steal: true }, onLost);
}
