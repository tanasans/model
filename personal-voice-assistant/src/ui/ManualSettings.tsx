import type { ClapProfile } from '../clap/clapDetector';
import { fmtNum } from './parts';

/** 拍手判定基準の手動設定（値の保存・反映は useClapController 側） */
const MANUAL_FIELDS: Array<{
  key: keyof ClapProfile;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  help: string;
}> = [
  { key: 'minLevelDb', label: '拍手判定しきい値（大きさ）', min: -60, max: -6, step: 1, unit: 'dB', help: '拍手が反応しないなら下げる。小さな物音で反応するなら上げる' },
  { key: 'minAboveFloorDb', label: '環境音からの差', min: 6, max: 30, step: 1, unit: 'dB', help: '環境音の基準値よりこれだけ大きい音だけを候補にする' },
  { key: 'minJumpDb', label: '急な変化', min: 4, max: 20, step: 1, unit: 'dB', help: '直前からの音量の増え方' },
  { key: 'minDecayDb', label: '短さ', min: 0, max: 15, step: 0.5, unit: 'dB', help: '響く部屋で反応しないなら下げる' },
  { key: 'minCentroidHz', label: '音の高さ', min: 200, max: 3000, step: 50, unit: 'Hz', help: '低い物音に反応するなら上げる' },
  { key: 'maxCrest', label: '尖り（上限）', min: 3, max: 15, step: 0.5, unit: '', help: 'キーボード音に反応するなら下げる' },
];

export function ManualSettings({ profile, onChange }: { profile: ClapProfile; onChange: (p: ClapProfile) => void }) {
  return (
    <div className="manual">
      <div className="settings">
        {MANUAL_FIELDS.map((f) => (
          <label key={f.key} title={f.help}>
            {f.label}：{fmtNum(profile[f.key])}
            {f.unit}
            <input
              type="range"
              min={f.min}
              max={f.max}
              step={f.step}
              value={profile[f.key]}
              onChange={(e) => onChange({ ...profile, [f.key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

