import { KIND_LABEL, type ClapController } from '../clap/useClapController';
import { MODE_LABEL, type WakeController } from '../wake/useWakeController';
import type { WakePhraseMode } from '../wake/wakePolicy';
import { ManualSettings } from './ManualSettings';
import { LiveMeter, Slider, Toggle } from './parts';

export interface DetailSettingsProps {
  wake: WakeController;
  clap: ClapController;
  busy: boolean;
  testMode: boolean;
  setTestMode: (v: boolean) => void;
  lowMotion: boolean;
  setLowMotion: (v: boolean) => void;
  onCalibrate: () => void;
  readMicDb: () => number | null;
}

/** 詳細設定（必要なときだけ開く）。説明文は最小限 */
export function DetailSettings(p: DetailSettingsProps) {
  return (
    <div className="st">
      <section className="panel">
        <LiveMeter read={p.readMicDb} label="マイク入力" />
        <div className="st-grid">
          <Slider label="呼びかけ感度" value={p.wake.settings.sensitivity} min={1} max={10} step={1} display={`${p.wake.settings.sensitivity}`} onChange={p.wake.setSensitivity} />
          <Slider label="拍手感度" value={p.clap.settings.sensitivity} min={1} max={10} step={1} display={`${p.clap.settings.sensitivity}`} onChange={p.clap.setSensitivity} />
          <Slider
            label="拍手間隔"
            value={p.clap.settings.maxIntervalMs}
            min={300}
            max={1000}
            step={50}
            display={`${(p.clap.settings.maxIntervalMs / 1000).toFixed(2)}秒`}
            onChange={p.clap.setMaxIntervalMs}
          />
        </div>
        <div className="row-actions">
          <button className="btn" onClick={p.onCalibrate} disabled={p.busy || p.clap.calibrating}>
            キャリブレーション
          </button>
          <Toggle label="テストモード" checked={p.testMode} onChange={p.setTestMode} />
          {p.testMode && (
            <button
              className="btn btn-small btn-ghost"
              onClick={() => {
                p.wake.resetTestCount();
                p.clap.resetTestCount();
              }}
            >
              回数リセット
            </button>
          )}
        </div>
        <label className="field">
          <span>呼びかけの言葉</span>
          <select value={p.wake.settings.mode} onChange={(e) => p.wake.setMode(e.target.value as WakePhraseMode)}>
            {(Object.keys(MODE_LABEL) as WakePhraseMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
      </section>

      <details className="panel fold">
        <summary>手動判定基準（拍手）</summary>
        <p className="muted small">現在：{KIND_LABEL[p.clap.profileKind]}</p>
        <ManualSettings profile={p.clap.profile} onChange={p.clap.setManualProfile} />
        {p.clap.profileKind !== 'standard' && (
          <button className="btn btn-small" onClick={p.clap.resetProfile}>
            標準に戻す
          </button>
        )}
      </details>

      <details className="panel fold">
        <summary>その他</summary>
        <Toggle label="雑音低減" checked={p.wake.settings.noiseReduction} onChange={p.wake.setNoiseReduction} />
        <Toggle label="低負荷モード（背景を静止）" checked={p.lowMotion} onChange={p.setLowMotion} />
      </details>
    </div>
  );
}
