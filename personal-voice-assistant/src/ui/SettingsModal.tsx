import { KIND_LABEL, type ClapController } from '../clap/useClapController';
import { MODE_LABEL, type WakeController } from '../wake/useWakeController';
import type { WakePhraseMode } from '../wake/wakePolicy';
import { ManualSettings } from './ManualSettings';
import { Modal } from './Modal';
import { Toggle } from './parts';

export function SettingsModal({ wake, clap, onClose }: { wake: WakeController; clap: ClapController; onClose: () => void }) {
  return (
    <Modal title="詳細設定" en="SETTINGS" onClose={onClose}>
      <section className="k-settings-sec">
        <h3>音声待機（呼びかけ）</h3>
        <label className="k-field">
          <span>呼びかけの言葉</span>
          <select value={wake.settings.mode} onChange={(e) => wake.setMode(e.target.value as WakePhraseMode)}>
            {(Object.keys(MODE_LABEL) as WakePhraseMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <Toggle
          label="雑音低減"
          checked={wake.settings.noiseReduction}
          onChange={wake.setNoiseReduction}
          hint="「サー」という音が多い環境向け（普通の部屋では OFF 推奨）"
        />
      </section>
      <section className="k-settings-sec">
        <h3>拍手の判定基準</h3>
        <p className="k-meta">
          現在：{KIND_LABEL[clap.profileKind]}。値を変えるとすぐに反映され、ブラウザに保存されます。テストモードで確かめながら調整してください。
        </p>
        <ManualSettings profile={clap.profile} onChange={clap.setManualProfile} />
        {clap.profileKind !== 'standard' && (
          <button className="k-btn k-btn-ghost" onClick={clap.resetProfile}>
            標準に戻す
          </button>
        )}
      </section>
      <p className="k-meta">
        設定（感度・間隔・判定基準・呼びかけの言葉）はこのブラウザに保存され、再起動後も保持されます。待機の ON/OFF は、マイクを勝手に使わないよう毎回 OFF から始まります。
      </p>
    </Modal>
  );
}
