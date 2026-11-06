import { useCallback, useEffect, useState } from 'react';
import type { HealthInfo } from '../shared/assistant';
import { playChime } from './clap/chime';
import { useClapStandby, type StandbyStatus } from './clap/useClapStandby';
import { CLAP_NO_SPEECH_TIMEOUT_SEC, useVoiceSession, type Phase } from './useVoiceSession';

const PHASE_LABEL: Record<Phase, string> = {
  idle: '未接続',
  'requesting-mic': 'マイクの許可を確認中…',
  'fetching-token': '接続準備中（一時トークン取得）…',
  connecting: 'OpenAI に接続中…',
  connected: '接続中（話しかけてください）',
  stopping: '終了処理中…',
};

const STANDBY_LABEL: Record<StandbyStatus, string> = {
  off: 'OFF',
  starting: 'マイク準備中…',
  listening: '待機中（手を2回叩くと会話を開始）',
  'first-clap': '1回目を検知 — もう1回どうぞ',
  paused: '一時停止中（会話中は拍手検出を止めています）',
  error: 'エラー',
};

const SETTINGS_KEY = 'pva.clapSettings.v1';
interface ClapSettings {
  sensitivity: number;
  maxIntervalMs: number;
}
const DEFAULT_SETTINGS: ClapSettings = { sensitivity: 5, maxIntervalMs: 600 };

function loadSettings(): ClapSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<ClapSettings> | null;
    return {
      sensitivity: clamp(Number(raw?.sensitivity ?? DEFAULT_SETTINGS.sensitivity), 1, 10),
      maxIntervalMs: clamp(Number(raw?.maxIntervalMs ?? DEFAULT_SETTINGS.maxIntervalMs), 300, 1000),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

type ServerState = { kind: 'checking' } | { kind: 'down' } | { kind: 'up'; info: HealthInfo };

export function App() {
  const { phase, error, notice, lines, remaining, start, stop } = useVoiceSession();
  const [server, setServer] = useState<ServerState>({ kind: 'checking' });
  // 拍手待機は毎回 OFF から（マイクを勝手に使わないため）。感度・間隔だけ保存する
  const [standbyOn, setStandbyOn] = useState(false);
  const [settings, setSettings] = useState<ClapSettings>(loadSettings);
  const [triggering, setTriggering] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* 保存できなくても動作には影響しない */
    }
  }, [settings]);

  const onDoubleClap = useCallback(() => {
    if (triggering) return;
    setTriggering(true); // ここで拍手検出のマイクを解放する
    void (async () => {
      try {
        await playChime();
        await start({ trigger: 'clap' });
      } finally {
        setTriggering(false);
      }
    })();
  }, [start, triggering]);

  const standby = useClapStandby({
    enabled: standbyOn,
    paused: triggering || phase !== 'idle',
    sensitivity: settings.sensitivity,
    maxIntervalMs: settings.maxIntervalMs,
    onDoubleClap,
  });

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
        <h1>自分専用AI秘書</h1>
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

      <section className="standby">
        <div className="standby-head">
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={standbyOn}
              onChange={(e) => setStandbyOn(e.target.checked)}
            />
            <span className="slider" aria-hidden />
            <span className="switch-label">拍手待機 {standbyOn ? 'ON' : 'OFF'}</span>
          </label>
          <span className={`standby-status st-${standby.status}`}>{STANDBY_LABEL[standby.status]}</span>
        </div>
        <p className="hint">
          ON にすると、手を2回叩いたときに起動音が鳴って会話を開始します。待機中の音はこの PC のブラウザ内だけで判定し、
          送信・保存はしません（OpenAI にも接続しません）。拍手で起動して {CLAP_NO_SPEECH_TIMEOUT_SEC} 秒話しかけがなければ自動終了します。
        </p>
        {standby.error && <div className="alert error">拍手待機エラー：{standby.error}</div>}

        <div className="settings">
          <label>
            感度：{settings.sensitivity}（1 鈍い 〜 10 敏感）
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={settings.sensitivity}
              onChange={(e) => setSettings((s) => ({ ...s, sensitivity: Number(e.target.value) }))}
            />
          </label>
          <label>
            2回の間隔（最大）：{(settings.maxIntervalMs / 1000).toFixed(2)} 秒
            <input
              type="range"
              min={300}
              max={1000}
              step={50}
              value={settings.maxIntervalMs}
              onChange={(e) => setSettings((s) => ({ ...s, maxIntervalMs: Number(e.target.value) }))}
            />
          </label>
        </div>

        {standby.meter && (
          <div className="meter" aria-label="マイク入力レベル">
            <div className="meter-bar">
              <div className="meter-fill" style={{ width: `${dbToPct(standby.meter.levelDb)}%` }} />
              <div className="meter-th" style={{ left: `${dbToPct(standby.meter.triggerDb)}%` }} title="反応しきい値" />
            </div>
            <div className="meta">
              入力 {fmtDb(standby.meter.levelDb)} ／ 反応ライン {fmtDb(standby.meter.triggerDb)}（縦線を超える鋭い音が拍手候補）
            </div>
          </div>
        )}
        {standbyOn && (standby.lastSound || standby.lastNote) && (
          <div className="diag">
            {standby.lastSound && (
              <div>
                直近の大きな音：{fmtDb(standby.lastSound.levelDb)}・長さ {standby.lastSound.durationMs}ms・高さ約{' '}
                {standby.lastSound.centroidHz}Hz →{' '}
                {standby.lastSound.accepted ? '拍手と判定' : `拍手ではない（${standby.lastSound.reason ?? '条件外'}）`}
              </div>
            )}
            {standby.lastNote && <div>{standby.lastNote}</div>}
          </div>
        )}
      </section>

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
                <span className="who">{l.role === 'user' ? 'あなた' : '秘書'}</span>
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

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min;
}

/** -70dB〜0dB をメーターの 0〜100% に対応させる */
function dbToPct(db: number): number {
  return Math.min(100, Math.max(0, ((db + 70) / 70) * 100));
}

function fmtDb(db: number): string {
  return `${Math.max(-99, Math.round(db))}dB`;
}

function formatSec(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
