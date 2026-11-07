import { useCallback, useEffect, useState } from 'react';
import { playChime } from '../clap/chime';
import { MODEL_FILE } from './voskEngine';
import { useWakeStandby, type WakeLogEntry, type WakeStatus } from './useWakeStandby';
import type { WakeDecision, WakePhraseMode } from './wakePolicy';

const STATUS_LABEL: Record<WakeStatus, string> = {
  off: 'OFF',
  checking: '準備中…',
  'not-installed': '音声認識モデルが未設置です',
  loading: '音声認識モデルを読み込み中…（数秒）',
  listening: '待機中 — 呼びかけてください',
  paused: '一時停止中（会話中は呼びかけ検出を止めています）',
  error: 'エラー',
};

const MODE_LABEL: Record<WakePhraseMode, string> = {
  both: '「カイト」と「ねえ、カイト」の両方',
  nee: '「ねえ、カイト」のみ（誤起動が最も少ない）',
  kaito: '「カイト」のみ',
};

const SETTINGS_KEY = 'pva.wakeSettings.v1';
interface WakeSettings {
  mode: WakePhraseMode;
  sensitivity: number;
  noiseReduction: boolean;
}
const DEFAULTS: WakeSettings = { mode: 'both', sensitivity: 5, noiseReduction: false };

function loadSettings(): WakeSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<WakeSettings> | null;
    const mode = raw?.mode && raw.mode in MODE_LABEL ? raw.mode : DEFAULTS.mode;
    const s = Number(raw?.sensitivity ?? DEFAULTS.sensitivity);
    return {
      mode,
      sensitivity: Number.isFinite(s) ? Math.min(10, Math.max(1, Math.round(s))) : DEFAULTS.sensitivity,
      noiseReduction: raw?.noiseReduction === true,
    };
  } catch {
    return DEFAULTS;
  }
}

export interface WakePanelProps {
  /** 会話中・起動処理中（拍手で起動中も含む）は止める */
  standbyPaused: boolean;
  onWakeStart: () => Promise<void>;
  noSpeechTimeoutSec: number;
}

export function WakePanel({ standbyPaused, onWakeStart, noSpeechTimeoutSec }: WakePanelProps) {
  // 音声待機は毎回 OFF から（マイクを勝手に使わないため）。設定だけ保存する
  const [on, setOn] = useState(false);
  const [settings, setSettings] = useState<WakeSettings>(loadSettings);
  const [testMode, setTestMode] = useState(false);
  const [testCount, setTestCount] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* 保存できなくても動作には影響しない */
    }
  }, [settings]);

  const onWake = useCallback(
    (_d: WakeDecision) => {
      if (testMode) {
        // テストモード：会話は開始せず、回数だけ数える（API 料金なし）
        setTestCount((n) => n + 1);
        void playChime();
        return;
      }
      void onWakeStart();
    },
    [onWakeStart, testMode],
  );

  const wake = useWakeStandby({
    enabled: on,
    paused: standbyPaused,
    mode: settings.mode,
    sensitivity: settings.sensitivity,
    noiseReduction: settings.noiseReduction,
    onWake,
  });
  const lastDecision = wake.log.find((l): l is Extract<WakeLogEntry, { kind: 'decision' }> => l.kind === 'decision');

  return (
    <section className={`standby wake standby-${wake.status}`}>
      <div className="standby-head">
        <label className="switch">
          <input type="checkbox" role="switch" checked={on} onChange={(e) => setOn(e.target.checked)} />
          <span className="slider" aria-hidden />
          <span className="switch-label">音声待機（呼びかけ）{on ? 'ON' : 'OFF'}</span>
        </label>
        <span className={`standby-status st-${wake.status === 'listening' ? 'listening' : wake.status === 'error' || wake.status === 'not-installed' ? 'error' : 'paused'}`} aria-live="polite">
          {STATUS_LABEL[wake.status]}
        </span>
      </div>
      <p className="hint">
        {settings.mode === 'nee' ? '「ねえ、カイト」' : '「カイト」または「ねえ、カイト」'}
        と呼びかけて、<strong>少し間をあけると</strong>起動音が鳴り会話を始めます。音声の聞き取りはこの PC のブラウザ内で行い、
        待機中は OpenAI に接続しません（料金はかかりません）。呼びかけで起動して {noSpeechTimeoutSec} 秒話しかけがなければ自動終了します。
      </p>

      {wake.status === 'not-installed' && (
        <div className="alert error">
          音声認識モデル（{MODEL_FILE}、約 50MB）がまだありません。PowerShell で
          <code> npm run setup:wake </code>
          を実行してから、ページを再読み込みしてください（初回の 1 回だけ）。
        </div>
      )}
      {wake.error && <div className="alert error">音声待機エラー：{wake.error}</div>}

      {on && wake.level && (
        <div className="levels">
          <span>
            現在の入力 <strong>{Math.round(wake.level.levelDb)}dB</strong>
          </span>
          <span>
            環境音の基準値 <strong>{Math.round(wake.level.floorDb)}dB</strong>
          </span>
        </div>
      )}

      <div className="settings">
        <label>
          呼びかけの言葉
          <select value={settings.mode} onChange={(e) => setSettings((s) => ({ ...s, mode: e.target.value as WakePhraseMode }))}>
            {(Object.keys(MODE_LABEL) as WakePhraseMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <label>
          感度：{settings.sensitivity}（1 厳しい 〜 10 敏感）
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={settings.sensitivity}
            onChange={(e) => setSettings((s) => ({ ...s, sensitivity: Number(e.target.value) }))}
          />
        </label>
      </div>
      <div className="row-actions">
        <label className="check">
          <input
            type="checkbox"
            checked={settings.noiseReduction}
            onChange={(e) => setSettings((s) => ({ ...s, noiseReduction: e.target.checked }))}
          />
          雑音低減（「サー」という音が多い環境向け）
        </label>
        <label className="check">
          <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
          テストモード（会話を始めず回数だけ数える）
        </label>
      </div>

      {testMode && (
        <div className="testmode">
          <span>
            テストモード：呼びかけの検知 <strong>{testCount}</strong> 回
          </span>
          <button className="ghost" onClick={() => setTestCount(0)}>
            0 に戻す
          </button>
          <span className="meta">20回呼んで18回以上検知できれば合格の目安です（料金はかかりません）。</span>
        </div>
      )}

      {on && lastDecision && <DecisionCard d={lastDecision.decision} />}

      {on && wake.log.length > 0 && (
        <details className="log">
          <summary>判定の履歴（新しい順・この画面にだけ表示し、保存しません）</summary>
          <ul>
            {wake.log.map((l) => (
              <li key={l.id} className={l.kind === 'decision' ? (l.decision.accepted ? 'tone-ok' : 'tone-warn') : ''}>
                <time>{new Date(l.at).toLocaleTimeString('ja-JP')}</time>
                {l.kind === 'decision'
                  ? l.decision.accepted
                    ? `呼びかけを検知（${l.decision.phrase === 'nee' ? 'ねえ、カイト' : 'カイト'}）`
                    : `呼びかけと判定せず：${l.decision.reason ?? ''}`
                  : l.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function DecisionCard({ d }: { d: WakeDecision }) {
  return (
    <div className={`sound ${d.accepted ? 'sound-ok' : 'sound-ng'}`}>
      <div className="sound-head">
        直近の呼びかけ：<strong>{d.accepted ? '起動' : '起動しない'}</strong>（聞こえた言葉：{d.text.replace(/\[unk\]/g, '…')}）
      </div>
      {!d.accepted && d.reason && <div className="sound-reason">理由：{d.reason}</div>}
      <ul className="checks">
        {d.checks.map((c) => (
          <li key={c.key} className={c.pass ? 'pass' : 'fail'}>
            <span className="mark" aria-hidden>
              {c.pass ? '✓' : '✗'}
            </span>
            {c.label} <span className="th">{c.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
