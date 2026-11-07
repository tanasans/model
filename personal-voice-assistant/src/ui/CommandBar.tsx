import type { Phase } from '../useVoiceSession';
import { Toggle } from './parts';

export function CommandBar(p: {
  wakeOn: boolean;
  setWakeOn: (v: boolean) => void;
  clapOn: boolean;
  setClapOn: (v: boolean) => void;
  phase: Phase;
  triggering: boolean;
  testMode: boolean;
  onStart: () => void;
  onStop: () => void;
  onOpen: (tab: 'log' | 'settings') => void;
  alert: boolean;
  drawer: 'log' | 'settings' | null;
}) {
  const busy = p.phase !== 'idle' || p.triggering;
  const stopping = p.phase === 'stopping';
  return (
    <nav className="cb" aria-label="操作">
      <div className="cb-side">
        <Toggle label="音声待機" checked={p.wakeOn} onChange={p.setWakeOn} />
        <Toggle label="拍手待機" checked={p.clapOn} onChange={p.setClapOn} />
        {p.testMode && <span className="cb-test">TEST MODE</span>}
      </div>
      <button
        className={`cb-main ${busy ? 'is-stop' : ''}`}
        onClick={busy ? p.onStop : p.onStart}
        disabled={stopping || (p.triggering && p.phase === 'idle')}
        aria-label={busy ? '会話終了' : '会話開始'}
      >
        <span className="cb-main-en">{busy ? 'END SESSION' : 'ENGAGE'}</span>
        <span className="cb-main-ja">{busy ? '会話終了' : '会話開始'}</span>
      </button>
      <div className="cb-side cb-icons">
        <button className={`icon-btn ${p.drawer === 'log' ? 'is-on' : ''}`} onClick={() => p.onOpen('log')} aria-label="履歴・状態" title="履歴・状態">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
          {p.alert && <span className="icon-dot" aria-label="エラーあり" />}
        </button>
        <button className={`icon-btn ${p.drawer === 'settings' ? 'is-on' : ''}`} onClick={() => p.onOpen('settings')} aria-label="設定" title="設定">
          <svg viewBox="0 0 24 24" aria-hidden>
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M5.5 18.5l2.1-2.1M16.4 7.6l2.1-2.1" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
