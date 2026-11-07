import { useCallback, useEffect, useRef, useState } from 'react';
import { ASSISTANT_NAME, type HealthInfo } from '../shared/assistant';
import { playChime } from './clap/chime';
import { ClapPanel } from './clap/ClapPanel';
import { WakePanel } from './wake/WakePanel';
import { createTriggerGate } from './triggerGate';
import { CLAP_NO_SPEECH_TIMEOUT_SEC, useVoiceSession, type Phase } from './useVoiceSession';

const PHASE_LABEL: Record<Phase, string> = {
  idle: '未接続',
  'requesting-mic': 'マイクの許可を確認中…',
  'fetching-token': '接続準備中（一時トークン取得）…',
  connecting: 'OpenAI に接続中…',
  connected: '接続中（話しかけてください）',
  stopping: '終了処理中…',
};

type ServerState = { kind: 'checking' } | { kind: 'down' } | { kind: 'up'; info: HealthInfo };

export function App() {
  const { phase, error, notice, lines, remaining, start, stop } = useVoiceSession();
  const [server, setServer] = useState<ServerState>({ kind: 'checking' });
  // 拍手・音声呼びかけ共通の起動処理。同時に検知しても接続は 1 回だけ（二重接続防止）
  const [triggering, setTriggering] = useState(false);
  const gateRef = useRef(createTriggerGate());
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const triggerStart = useCallback(
    async (source: 'clap' | 'wake') => {
      if (phaseRef.current !== 'idle') return;
      await gateRef.current.run(async () => {
        setTriggering(true); // ここで拍手・音声の待機を止め、マイクを解放する
        try {
          await playChime();
          await start({ trigger: source });
        } finally {
          setTriggering(false);
        }
      });
    },
    [start],
  );
  const onClapStart = useCallback(() => triggerStart('clap'), [triggerStart]);
  const onWakeStart = useCallback(() => triggerStart('wake'), [triggerStart]);

  useEffect(() => {
    let alive = true;
    fetch('/api/health')
      .then((r) => (r.ok ? (r.json() as Promise<HealthInfo>) : Promise.reject(new Error('bad status'))))
      .then((info) => alive && setServer({ kind: 'up', info }))
      .catch(() => alive && setServer({ kind: 'down' }));
    return () => {
      alive = false;
    };
  }, []);

  const busy = phase !== 'idle';
  const connected = phase === 'connected';

  return (
    <main className="app">
      <header>
        <h1>AI秘書 {ASSISTANT_NAME}</h1>
        <p className="sub">ローカル版 MVP（Windows / Chrome）</p>
      </header>

      <section className="status" aria-live="polite">
        <div className={`dot dot-${connected ? 'on' : busy ? 'wait' : 'off'}`} aria-hidden />
        <div>
          <div className="phase">状態：{PHASE_LABEL[phase]}</div>
          {connected && remaining !== null && <div className="meta">自動終了まで残り {formatSec(remaining)}</div>}
          <div className="meta">
            サーバー：
            {server.kind === 'checking' && '確認中…'}
            {server.kind === 'down' && '未起動またはエラー（npm run dev を確認）'}
            {server.kind === 'up' &&
              (server.info.apiKeyConfigured
                ? `起動中・APIキー設定済み（モデル: ${server.info.model}、最大 ${server.info.maxSessionSeconds} 秒）`
                : '起動中・APIキー未設定（会話は開始できません）')}
          </div>
        </div>
      </section>

      <div className="buttons">
        <button className="start" onClick={() => void start()} disabled={busy || triggering}>
          会話開始
        </button>
        <button className="stop" onClick={() => void stop()} disabled={!busy || phase === 'stopping'}>
          会話終了
        </button>
      </div>

      <WakePanel standbyPaused={busy || triggering} onWakeStart={onWakeStart} noSpeechTimeoutSec={CLAP_NO_SPEECH_TIMEOUT_SEC} />
      <ClapPanel conversationBusy={busy || triggering} onClapStart={onClapStart} noSpeechTimeoutSec={CLAP_NO_SPEECH_TIMEOUT_SEC} />

      {error && (
        <div className="alert error" role="alert">
          エラー：{error}
        </div>
      )}
      {notice && !error && <div className="alert info">{notice}</div>}

      <section className="transcript">
        <h2>会話の表示</h2>
        <p className="hint">音声の文字起こしは API から届いた分だけ表示します（取得できない場合はその旨を表示します）。</p>
        {lines.length === 0 ? (
          <p className="empty">{connected ? 'まだ発話はありません。' : '会話を開始すると、ここに内容が表示されます。'}</p>
        ) : (
          <ul>
            {lines.map((l) => (
              <li key={l.id} className={l.role}>
                <span className="who">{l.role === 'user' ? 'あなた' : ASSISTANT_NAME}</span>
                <span className={l.text ? 'text' : 'text missing'}>
                  {l.text ??
                    (l.pending ? '（音声を処理中…）' : '（文字起こしは届いていないか、取得できませんでした）')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer>
        音声は保存しません。会話終了・拍手待機 OFF・タブを閉じるとマイクと接続を閉じます。
      </footer>
    </main>
  );
}

function formatSec(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
