import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_PROFILE, type ClapProfile, type TransientInfo } from './clapDetector';
import { sanitizeProfile } from './calibration';
import { playChime } from './chime';
import type { MicProcessing } from './micCapture';
import { AMBIENT_SEC, CLAPS_MAX_SEC, CLAPS_TARGET, NOISE_SEC, useCalibration } from './useCalibration';
import { useClapStandby, type LogEntry, type StandbyStatus } from './useClapStandby';

const STANDBY_LABEL: Record<StandbyStatus, string> = {
  off: 'OFF',
  starting: 'マイク準備中…',
  listening: '待機中 — 手を2回叩いてください',
  'first-clap': '1回目を検知 — もう1回どうぞ',
  paused: '一時停止中（会話中・調整中は拍手検出を止めています）',
  error: 'エラー',
};

const SETTINGS_KEY = 'pva.clapSettings.v1';
const PROFILE_KEY = 'pva.clapProfile.v1';

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

function loadProfile(): { profile: ClapProfile; calibrated: boolean } {
  try {
    const p = sanitizeProfile(JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null'));
    return p ? { profile: p, calibrated: true } : { profile: DEFAULT_PROFILE, calibrated: false };
  } catch {
    return { profile: DEFAULT_PROFILE, calibrated: false };
  }
}

function save(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

export interface ClapPanelProps {
  /** 会話中・開始処理中は拍手検出を止める */
  conversationBusy: boolean;
  /** 拍手 2 回を検知したら呼ばれる（起動音の後） */
  onClapStart: () => Promise<void>;
  noSpeechTimeoutSec: number;
}

export function ClapPanel({ conversationBusy, onClapStart, noSpeechTimeoutSec }: ClapPanelProps) {
  // 拍手待機は毎回 OFF から（マイクを勝手に使わないため）。感度・間隔・基準は保存する
  const [standbyOn, setStandbyOn] = useState(false);
  const [settings, setSettings] = useState<ClapSettings>(loadSettings);
  const [{ profile, calibrated }, setProfileState] = useState(loadProfile);
  const [triggering, setTriggering] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [testCount, setTestCount] = useState(0);
  const calib = useCalibration();
  const calibrating = calib.step !== 'idle';

  useEffect(() => save(SETTINGS_KEY, settings), [settings]);

  const onDoubleClap = useCallback(() => {
    if (triggering) return;
    if (testMode) {
      // テストモード：会話は開始せず、回数だけ数える（API 料金なし）
      setTestCount((n) => n + 1);
      void playChime();
      return;
    }
    setTriggering(true); // ここで拍手検出のマイクを解放する
    void (async () => {
      try {
        await playChime();
        await onClapStart();
      } finally {
        setTriggering(false);
      }
    })();
  }, [onClapStart, testMode, triggering]);

  const standby = useClapStandby({
    enabled: standbyOn,
    paused: triggering || conversationBusy || calibrating,
    sensitivity: settings.sensitivity,
    maxIntervalMs: settings.maxIntervalMs,
    profile,
    onDoubleClap,
  });

  const applyCalibration = () => {
    if (!calib.result?.ok) return;
    setProfileState({ profile: calib.result.profile, calibrated: true });
    save(PROFILE_KEY, calib.result.profile);
    setSettings((s) => ({ ...s, sensitivity: 5 }));
    calib.reset();
  };
  const resetCalibration = () => {
    setProfileState({ profile: DEFAULT_PROFILE, calibrated: false });
    save(PROFILE_KEY, null);
  };

  const lastSound = standby.log.find((l): l is Extract<LogEntry, { kind: 'sound' }> => l.kind === 'sound');

  return (
    <section className={`standby standby-${standby.status}`}>
      <div className="standby-head">
        <label className="switch">
          <input type="checkbox" role="switch" checked={standbyOn} onChange={(e) => setStandbyOn(e.target.checked)} />
          <span className="slider" aria-hidden />
          <span className="switch-label">拍手待機 {standbyOn ? 'ON' : 'OFF'}</span>
        </label>
        <span className={`standby-status st-${standby.status}`} aria-live="polite">
          {STANDBY_LABEL[standby.status]}
        </span>
      </div>
      <p className="hint">
        手を2回叩くと起動音が鳴って会話を始めます。待機中の音はこの PC のブラウザ内だけで判定し、送信・保存はしません
        （OpenAI にも接続しないので料金はかかりません）。拍手で起動して {noSpeechTimeoutSec} 秒話しかけがなければ自動終了します。
      </p>
      {standby.error && <div className="alert error">拍手待機エラー：{standby.error}</div>}

      {standbyOn && standby.processing && <ProcessingInfo p={standby.processing} />}

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

      <div className="row-actions">
        <span className="meta">判定基準：{calibrated ? 'キャリブレーション済み（このPC・この部屋用）' : '標準'}</span>
        <button className="ghost" onClick={() => void calib.start()} disabled={calibrating || conversationBusy}>
          キャリブレーション
        </button>
        {calibrated && (
          <button className="ghost" onClick={resetCalibration} disabled={calibrating}>
            標準に戻す
          </button>
        )}
        <label className="check">
          <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
          テストモード（会話を始めず回数だけ数える）
        </label>
      </div>

      {calibrating && <CalibrationWizard calib={calib} onApply={applyCalibration} />}

      {testMode && (
        <div className="testmode">
          <span>
            テストモード：拍手2回の検知 <strong>{testCount}</strong> 回
          </span>
          <button className="ghost" onClick={() => setTestCount(0)}>
            0 に戻す
          </button>
          <span className="meta">20回叩いて18回以上検知できれば合格の目安です。</span>
        </div>
      )}

      {standby.meter && (
        <div className="meter" aria-label="マイク入力レベル">
          <div className="meter-bar">
            <div className="meter-fill" style={{ width: `${dbToPct(standby.meter.levelDb)}%` }} />
            <div className="meter-th" style={{ left: `${dbToPct(standby.meter.triggerDb)}%` }} title="反応ライン" />
          </div>
          <div className="meta">
            入力 {fmtDb(standby.meter.levelDb)} ／ 周囲の騒音 {fmtDb(standby.meter.floorDb)} ／ 反応ライン{' '}
            {fmtDb(standby.meter.triggerDb)}（赤線）
          </div>
        </div>
      )}

      {standbyOn && lastSound && <SoundCard info={lastSound.info} />}

      {standbyOn && standby.log.length > 0 && (
        <details className="log">
          <summary>判定の履歴（新しい順）</summary>
          <ul>
            {standby.log.map((l) => (
              <li key={l.id} className={l.kind === 'note' ? `tone-${l.tone}` : l.info.accepted ? 'tone-ok' : 'tone-warn'}>
                <time>{new Date(l.at).toLocaleTimeString('ja-JP')}</time>
                {l.kind === 'note'
                  ? l.text
                  : l.info.accepted
                    ? `拍手と判定（${fmtDb(l.info.levelDb)}）`
                    : `拍手ではない：${l.info.reason ?? ''}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ProcessingInfo({ p }: { p: MicProcessing }) {
  const items: Array<[string, boolean | null]> = [
    ['自動音量調整', p.autoGainControl],
    ['ノイズ抑制', p.noiseSuppression],
    ['エコーキャンセル', p.echoCancellation],
  ];
  if (p.voiceIsolation !== null) items.push(['声の分離', p.voiceIsolation]);
  const anyOn = items.some(([, v]) => v === true);
  return (
    <div className={`proc ${anyOn ? 'proc-warn' : ''}`}>
      <span className="meta">拍手検出用マイクの音声加工：</span>
      {items.map(([name, v]) => (
        <span key={name} className={`chip ${v === true ? 'chip-ng' : v === false ? 'chip-ok' : ''}`}>
          {name} {v === true ? 'ON' : v === false ? 'OFF' : '不明'}
        </span>
      ))}
      {anyOn && (
        <div className="meta">
          ブラウザが音声加工を止められませんでした。拍手の音が削られる可能性があります。Windows の「設定 → システム → サウンド →
          マイクのプロパティ」で「オーディオの強化」や「音声フォーカス」等をオフにしてください。
        </div>
      )}
    </div>
  );
}

function SoundCard({ info }: { info: TransientInfo }) {
  return (
    <div className={`sound ${info.accepted ? 'sound-ok' : 'sound-ng'}`}>
      <div className="sound-head">
        直近の大きな音：<strong>{info.accepted ? '拍手と判定' : '拍手ではないと判定'}</strong>
      </div>
      {!info.accepted && info.reason && <div className="sound-reason">理由：{info.reason}</div>}
      <ul className="checks">
        {info.checks.map((c) => (
          <li key={c.key} className={c.pass ? 'pass' : 'fail'} title={c.kind === 'min' ? '基準以上で合格' : '基準以下で合格'}>
            <span className="mark" aria-hidden>
              {c.pass ? '✓' : '✗'}
            </span>
            {c.label} {fmtNum(c.value)}
            {c.unit}
            <span className="th">
              （基準 {c.kind === 'min' ? '≥' : '≤'} {fmtNum(c.threshold)}
              {c.unit}）
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CalibrationWizard({
  calib,
  onApply,
}: {
  calib: ReturnType<typeof useCalibration>;
  onApply: () => void;
}) {
  const { step } = calib;
  return (
    <div className="wizard" role="dialog" aria-label="キャリブレーション">
      <div className="wizard-steps">
        <span className={step === 'ambient' ? 'on' : ''}>1. 静かに</span>
        <span className={step === 'claps' ? 'on' : ''}>2. 拍手 {CLAPS_TARGET} 回</span>
        <span className={step === 'noise-ready' || step === 'noise' ? 'on' : ''}>3. 声・キーボード（任意）</span>
        <span className={step === 'result' ? 'on' : ''}>4. 結果</span>
      </div>
      {step === 'ambient' && (
        <p>
          <strong>そのまま静かにしてください</strong>（周囲の騒音を測っています… 残り {calib.secondsLeft} 秒 / {AMBIENT_SEC} 秒）
        </p>
      )}
      {step === 'claps' && (
        <p>
          <strong>1秒ほど間をあけて、ふだん起動するときと同じ位置・強さで1回ずつ拍手</strong>してください。
          <br />
          検出 {calib.clapCount} / {CLAPS_TARGET} 回（残り {calib.secondsLeft} 秒 / 最大 {CLAPS_MAX_SEC} 秒）
        </p>
      )}
      {step === 'noise-ready' && (
        <div>
          <p>
            拍手の測定が終わりました（大きな音を {calib.clapCount} 回検出）。続けて、<strong>誤起動させたくない音</strong>（ふだんの声で話す・キーボードを打つ）を{' '}
            {NOISE_SEC} 秒測ると、それと区別できる基準にします。
          </p>
          <div className="row-actions">
            <button className="ghost" onClick={calib.startNoise}>
              測る（{NOISE_SEC}秒）
            </button>
            <button className="ghost" onClick={calib.skipNoise}>
              スキップして結果へ
            </button>
          </div>
        </div>
      )}
      {step === 'noise' && (
        <p>
          <strong>ふだんの声で話す、またはキーボードを打ってください</strong>（拍手はしないでください）… 残り {calib.secondsLeft} 秒
        </p>
      )}
      {step === 'result' && calib.result && (
        <div>
          <p>
            <strong>{calib.result.ok ? 'キャリブレーション完了' : 'キャリブレーションできませんでした'}</strong>
          </p>
          <ul className="notes">
            <li>周囲の騒音：{fmtDb(calib.result.summary.ambientDb)}</li>
            {calib.result.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <div className="row-actions">
            {calib.result.ok && <button onClick={onApply}>この基準を使う</button>}
            <button className="ghost" onClick={() => void calib.start()}>
              やり直す
            </button>
            <button className="ghost" onClick={calib.cancel}>
              閉じる
            </button>
          </div>
        </div>
      )}
      {step === 'error' && (
        <div>
          <div className="alert error">{calib.error}</div>
          <button className="ghost" onClick={calib.cancel}>
            閉じる
          </button>
        </div>
      )}
      {(step === 'ambient' || step === 'claps' || step === 'noise') && (
        <div className="row-actions">
          <div className="meter-bar small">
            <div className="meter-fill" style={{ width: `${dbToPct(calib.levelDb)}%` }} />
          </div>
          <button className="ghost" onClick={calib.cancel}>
            中止
          </button>
        </div>
      )}
    </div>
  );
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min;
}
function dbToPct(db: number): number {
  return Math.min(100, Math.max(0, ((db + 70) / 70) * 100));
}
function fmtDb(db: number): string {
  return `${Math.max(-99, Math.round(db))}dB`;
}
function fmtNum(n: number): string {
  return Math.abs(n) >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}
