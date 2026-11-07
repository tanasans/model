import type { Phase } from '../useVoiceSession';
import { Toggle } from './parts';

export function CommandBar(p: {
  wakeOn: boolean;
  setWakeOn: (v: boolean) => void;
  clapOn: boolean;
  setClapOn: (v: boolean) => void;
  phase: Phase;
  triggering: boolean;
  test: { wake: number; clap: number } | null;
  onStart: () => void;
  onStop: () => void;
  onSettings: () => void;
  settingsOpen: boolean;
  alert: boolean;
}) {
  const busy = p.phase !== 'idle' || p.triggering;
  return (
    <nav className="cb" aria-label="操作">
      <div className="cb-side">
        <Toggle label="音声待機" checked={p.wakeOn} onChange={p.setWakeOn} />
        <Toggle label="拍手待機" checked={p.clapOn} onChange={p.setClapOn} />
        {p.test && (
          <span className="cb-test" title="テストモード（会話は開始しません）">
            TEST <b>{p.test.wake}</b> / <b>{p.test.clap}</b>
          </span>
        )}
      </div>
      <button
        className={`cb-main ${busy ? 'is-stop' : ''}`}
        onClick={busy ? p.onStop : p.onStart}
        disabled={p.phase === 'stopping' || (p.triggering && p.phase === 'idle')}
      >
        {busy ? '会話終了' : '会話開始'}
      </button>
      <div className="cb-side cb-icons">
        <button className={`icon-btn ${p.settingsOpen ? 'is-on' : ''}`} onClick={p.onSettings} aria-label="設定・診断" title="設定・診断">
          <svg viewBox="0 0 24 24" aria-hidden>
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M5.5 18.5l2.1-2.1M16.4 7.6l2.1-2.1" />
          </svg>
          {p.alert && <span className="icon-dot" aria-label="エラーあり" />}
        </button>
      </div>
    </nav>
  );
}
