import { useEffect, useState } from 'react';
import type { Phase } from '../useVoiceSession';

export type ServerView = { kind: 'checking' } | { kind: 'down' } | { kind: 'up'; apiKeyConfigured: boolean; model: string };

const PHASE_API: Record<Phase, { text: string; tone: 'idle' | 'busy' | 'live' }> = {
  idle: { text: '未接続（待機中は接続しません）', tone: 'idle' },
  'requesting-mic': { text: '接続準備中', tone: 'busy' },
  'fetching-token': { text: '接続準備中', tone: 'busy' },
  connecting: { text: '接続中', tone: 'busy' },
  connected: { text: '接続済み', tone: 'live' },
  stopping: { text: '切断中', tone: 'busy' },
};

export function Header({ server, phase }: { server: ServerView; phase: Phase }) {
  const now = useClock();
  const serverChip =
    server.kind === 'checking'
      ? { text: '確認中', tone: 'busy' }
      : server.kind === 'down'
        ? { text: 'オフライン', tone: 'error' }
        : { text: 'オンライン', tone: 'ok' };
  const api =
    server.kind === 'up' && !server.apiKeyConfigured
      ? { text: 'APIキー未設定', tone: 'error' }
      : PHASE_API[phase];
  return (
    <header className="k-header">
      <div className="k-brand">
        <div className="k-logo" aria-label="KAITO">
          KAITO
        </div>
        <div className="k-tagline">PERSONAL AI ASSISTANT</div>
      </div>
      <div className="k-header-right">
        <div className="k-status-chips">
          <span className={`k-chip tone-${serverChip.tone}`} title="ローカルサーバー（このPC）">
            <span className="k-chip-dot" aria-hidden />
            <span className="k-chip-key">SERVER</span>
            {serverChip.text}
          </span>
          <span className={`k-chip tone-${api.tone}`} title="OpenAI Realtime API との接続">
            <span className="k-chip-dot" aria-hidden />
            <span className="k-chip-key">API</span>
            {api.text}
          </span>
        </div>
        <div className="k-clock" aria-label="現在時刻">
          <time className="k-clock-time">{now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
          <span className="k-clock-date">{now.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })}</span>
        </div>
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
