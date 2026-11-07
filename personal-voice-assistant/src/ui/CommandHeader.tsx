import { useEffect, useState } from 'react';
import type { Phase } from '../useVoiceSession';

export type ServerView = { kind: 'checking' } | { kind: 'down' } | { kind: 'up'; apiKeyConfigured: boolean; model: string; defaultVoice: string };

/** 最小限のヘッダー：左に KAITO、右に時刻と接続状態 */
export function CommandHeader({ server, phase }: { server: ServerView; phase: Phase }) {
  const now = useClock();
  const srv = server.kind === 'up' ? { t: 'ONLINE', c: 'ok' } : server.kind === 'down' ? { t: 'OFFLINE', c: 'alert' } : { t: 'CHECK', c: 'idle' };
  const api =
    server.kind === 'up' && !server.apiKeyConfigured
      ? { t: 'KEY未設定', c: 'alert' }
      : phase === 'connected'
        ? { t: 'LINKED', c: 'live' }
        : phase === 'idle'
          ? { t: 'STANDBY', c: 'idle' }
          : { t: 'LINKING', c: 'busy' };
  return (
    <header className="ch">
      <div className="ch-brand">
        <span className="ch-logo">KAITO</span>
        <span className="ch-tag">COMMAND TERMINAL</span>
      </div>
      <div className="ch-right">
        <span className={`ch-stat is-${srv.c}`} title="ローカルサーバー（このPC）">
          <i aria-hidden />
          SERVER <b>{srv.t}</b>
        </span>
        <span className={`ch-stat is-${api.c}`} title="OpenAI Realtime API（待機中は接続しません）">
          <i aria-hidden />
          API <b>{api.t}</b>
        </span>
        <time className="ch-time">{now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
      </div>
    </header>
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
