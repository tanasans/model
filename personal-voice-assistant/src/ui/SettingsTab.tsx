import { KIND_LABEL, type ClapController } from '../clap/useClapController';
import type { VoiceSettings } from '../voice/useVoiceSettings';
import { MODE_LABEL, type WakeController } from '../wake/useWakeController';
import type { WakePhraseMode } from '../wake/wakePolicy';
import { ManualSettings } from './ManualSettings';
import { LiveMeter, Slider, Toggle } from './parts';
import { VoicePanel } from './VoicePanel';

export interface SettingsTabProps {
  wake: WakeController;
  clap: ClapController;
  voice: VoiceSettings;
  defaultVoice: string | null;
  apiKeyConfigured: boolean;
  busy: boolean;
  testMode: boolean;
  setTestMode: (v: boolean) => void;
  lowMotion: boolean;
  setLowMotion: (v: boolean) => void;
  onCalibrate: () => void;
  readMicDb: () => number | null;
}

export function SettingsTab(p: SettingsTabProps) {
  return (
    <div className="st">
      <section className="panel">
        <h3>
          声 <span className="en">VOICE</span>
        </h3>
        <VoicePanel vs={p.voice} defaultVoice={p.defaultVoice} apiKeyConfigured={p.apiKeyConfigured} busy={p.busy} />
      </section>

      <section className="panel">
        <h3>
          待機と検出 <span className="en">DETECTION</span>
        </h3>
        <LiveMeter read={p.readMicDb} label="マイク入力レベル（実測）" />
        <Toggle
          label="テストモード"
          checked={p.testMode}
          onChange={p.setTestMode}
          hint={`会話を始めず検知回数だけ数える（料金なし）　呼びかけ ${p.wake.testCount} 回／拍手 ${p.clap.testCount} 回`}
        />
        {p.testMode && (
          <button
            className="btn btn-small"
            onClick={() => {
              p.wake.resetTestCount();
              p.clap.resetTestCount();
            }}
          >
            回数を 0 に戻す
          </button>
        )}
        <div className="st-grid">
          <Slider label="呼びかけ感度" value={p.wake.settings.sensitivity} min={1} max={10} step={1} display={`${p.wake.settings.sensitivity}`} onChange={p.wake.setSensitivity} />
          <Slider label="拍手感度" value={p.clap.settings.sensitivity} min={1} max={10} step={1} display={`${p.clap.settings.sensitivity}`} onChange={p.clap.setSensitivity} />
          <Slider
            label="拍手間隔（最大）"
            value={p.clap.settings.maxIntervalMs}
            min={300}
            max={1000}
            step={50}
            display={`${(p.clap.settings.maxIntervalMs / 1000).toFixed(2)}秒`}
            onChange={p.clap.setMaxIntervalMs}
          />
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
        <Toggle label="雑音低減" checked={p.wake.settings.noiseReduction} onChange={p.wake.setNoiseReduction} hint="「サー」という音が多い環境向け（普通の部屋では OFF 推奨）" />
        <button className="btn" onClick={p.onCalibrate} disabled={p.busy || p.clap.calibrating}>
          拍手のキャリブレーションを開始
        </button>
      </section>

      <section className="panel">
        <h3>
          拍手の判定基準 <span className="en">CLAP PROFILE</span>
        </h3>
        <p className="muted">現在：{KIND_LABEL[p.clap.profileKind]}（値を変えるとすぐ反映・保存されます）</p>
        <ManualSettings profile={p.clap.profile} onChange={p.clap.setManualProfile} />
        {p.clap.profileKind !== 'standard' && (
          <button className="btn btn-small" onClick={p.clap.resetProfile}>
            標準に戻す
          </button>
        )}
      </section>

      <section className="panel">
        <h3>
          画面 <span className="en">DISPLAY</span>
        </h3>
        <Toggle label="低負荷モード" checked={p.lowMotion} onChange={p.setLowMotion} hint="背景アニメーションを止めて負荷を下げる（Windows の「アニメーション効果」オフでも自動で静止）" />
      </section>
      <p className="muted small">
        設定（声・感度・間隔・判定基準・呼びかけの言葉・低負荷モード）はこのブラウザに保存され、再起動後も保持されます。待機の ON/OFF とテストモードは毎回 OFF から始まります。
      </p>
    </div>
  );
}
