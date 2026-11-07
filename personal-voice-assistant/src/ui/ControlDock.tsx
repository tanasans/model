import type { ClapController } from '../clap/useClapController';
import type { Phase } from '../useVoiceSession';
import type { WakeController } from '../wake/useWakeController';
import { LiveMeter, Slider, Toggle } from './parts';

export interface ControlDockProps {
  wake: WakeController;
  clap: ClapController;
  testMode: boolean;
  setTestMode: (v: boolean) => void;
  phase: Phase;
  triggering: boolean;
  onStart: () => void;
  onStop: () => void;
  onCalibrate: () => void;
  onSettings: () => void;
  readMicDb: () => number | null;
}

export function ControlDock(p: ControlDockProps) {
  const busy = p.phase !== 'idle';
  return (
    <nav className="k-dock" aria-label="操作">
      <div className="k-dock-group k-dock-standby">
        <div className="k-dock-title">STANDBY</div>
        <Toggle label="音声待機" checked={p.wake.on} onChange={p.wake.setOn} hint="ねえ、カイト" />
        <Toggle label="拍手待機" checked={p.clap.standbyOn} onChange={p.clap.setStandbyOn} hint="拍手2回" />
        <Toggle
          label="テストモード"
          checked={p.testMode}
          onChange={p.setTestMode}
          hint={p.testMode ? `検知 呼びかけ${p.wake.testCount}・拍手${p.clap.testCount}` : '会話せず回数だけ'}
        />
        {p.testMode && (
          <button
            className="k-btn k-btn-ghost k-btn-small"
            onClick={() => {
              p.wake.resetTestCount();
              p.clap.resetTestCount();
            }}
          >
            回数を0に
          </button>
        )}
      </div>

      <div className="k-dock-group k-dock-session">
        <div className="k-dock-title">SESSION</div>
        <button className="k-btn k-btn-primary" onClick={p.onStart} disabled={busy || p.triggering}>
          会話開始
        </button>
        <button className="k-btn k-btn-outline" onClick={p.onStop} disabled={!busy || p.phase === 'stopping'}>
          会話終了
        </button>
      </div>

      <div className="k-dock-group k-dock-tune">
        <div className="k-dock-title">TUNING</div>
        <Slider
          label="呼びかけ感度"
          value={p.wake.settings.sensitivity}
          min={1}
          max={10}
          step={1}
          display={`${p.wake.settings.sensitivity}`}
          onChange={p.wake.setSensitivity}
        />
        <Slider
          label="拍手感度"
          value={p.clap.settings.sensitivity}
          min={1}
          max={10}
          step={1}
          display={`${p.clap.settings.sensitivity}`}
          onChange={p.clap.setSensitivity}
        />
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

      <div className="k-dock-group k-dock-mic">
        <div className="k-dock-title">MIC INPUT</div>
        <LiveMeter read={p.readMicDb} />
        <div className="k-dock-buttons">
          <button className="k-btn k-btn-outline" onClick={p.onCalibrate} disabled={busy || p.clap.calibrating}>
            キャリブレーション
          </button>
          <button className="k-btn k-btn-ghost" onClick={p.onSettings}>
            詳細設定
          </button>
        </div>
      </div>
    </nav>
  );
}
