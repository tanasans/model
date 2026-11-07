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
