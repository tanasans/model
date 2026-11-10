import { useState } from 'react';

/** 2 つ目以降の画面：KAITO はすでに起動している（この画面では待機・マイクを使わない） */
export function AlreadyRunning({ onTakeOver, stolen }: { onTakeOver: () => void; stolen: boolean }) {
  const [closeFailed, setCloseFailed] = useState(false);
  const close = () => {
    window.close();
    // ブラウザが閉じるのを許可しない場合（手で開いたタブなど）
    window.setTimeout(() => setCloseFailed(true), 300);
  };
  return (
    <div className="desk-closed already-running" role="alert">
      <p>{stolen ? 'KAITO は別のウィンドウで使われています。' : 'KAITO はすでに起動しています。'}</p>
      <p className="muted small">
        {stolen
          ? 'このウィンドウは停止しました（待機・マイクは使っていません）。'
          : '別のウィンドウ（またはタブ）で KAITO が動いています。二重に反応しないよう、このウィンドウでは待機・マイクを使いません。'}
      </p>
      <div className="already-actions">
        <button className="btn" onClick={close}>
          このウィンドウを閉じる
        </button>
        <button className="btn btn-accent" onClick={onTakeOver}>
          こちらで使う
        </button>
      </div>
      {closeFailed && <p className="muted small">このタブは自動で閉じられません。タブの × で閉じてください。</p>}
    </div>
  );
}
