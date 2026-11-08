import { useEffect, useState } from 'react';
import type { Phase } from '../useVoiceSession';

export type ServerView = { kind: 'checking' } | { kind: 'down' } | { kind: 'up'; apiKeyConfigured: boolean; model: string; defaultVoice: string };

/** ヘッダー：左に KAITO ロゴ（Canva で作成）、右に接続状態と時計 */
export function CommandHeader({ server, phase }: { server: ServerView; phase: Phase }) {
  const now = useClock();
  const srv = server.kind === 'up' ? { t: 'ONLINE', c: 'ok' } : server.kind === 'down' ? { t: 'OFFLINE', c: 'alert' } : { t: '…', c: 'idle' };
  const api =
    server.kind === 'up' && !server.apiKeyConfigured
      ? { t: 'NO KEY', c: 'alert' }
      : phase === 'connected'
        ? { t: 'LINKED', c: 'live' }
        : phase === 'idle'
          ? { t: 'STANDBY', c: 'idle' }
          : { t: 'LINKING', c: 'live' };
  return (
    <header className="ch">
      <picture className="ch-logo">
        <source srcSet="/brand/kaito-logo.webp" type="image/webp" />
        <img src="/brand/kaito-logo.png" alt="KAITO" width={900} height={268} />
      </picture>
      <div className="ch-right">
        <span className={`ch-stat is-${srv.c}`} title="ローカルサーバー">
          <i aria-hidden />
          SERVER <b>{srv.t}</b>
        </span>
        <span className={`ch-stat is-${api.c}`} title="OpenAI Realtime API（待機中は接続しません）">
          <i aria-hidden />
          API <b>{api.t}</b>
        </span>
        <FullscreenButton />
        <time className="ch-time">{now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
      </div>
    </header>
  );
}

/** 全画面表示の切り替え（F11 と同じ。Esc でも解除できる） */
function FullscreenButton() {
  const [full, setFull] = useState(() => typeof document !== 'undefined' && Boolean(document.fullscreenElement));
  useEffect(() => {
    const on = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  if (typeof document === 'undefined' || !document.fullscreenEnabled) return null;
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  };
  return (
    <button className="icon-btn ch-fs" onClick={toggle} aria-label={full ? '全画面を解除' : '全画面表示'} title={full ? '全画面を解除（Esc）' : '全画面表示'}>
      <svg viewBox="0 0 24 24" aria-hidden>
        {full ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
      </svg>
    </button>
  );
}

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
