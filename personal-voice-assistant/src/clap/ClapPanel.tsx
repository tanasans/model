import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_PROFILE, type ClapProfile, type TransientInfo } from './clapDetector';
import { sanitizeProfile } from './calibration';
import { playChime } from './chime';
import type { MicProcessing } from './micCapture';
import { CALIB_TIMING, useCalibration } from './useCalibration';
import { useClapStandby, type LogEntry, type Meter, type StandbyStatus } from './useClapStandby';

const STANDBY_LABEL: Record<StandbyStatus, string> = {
  off: 'OFF',
  starting: 'マイク準備中…',
  listening: '待機中 — 手を2回叩いてください',
  'first-clap': '1回目を検知 — もう1回どうぞ',
  paused: '一時停止中（会話中・調整中は拍手検出を止めています）',
  error: 'エラー',
};

const SETTINGS_KEY = 'pva.clapSettings.v1';
const PROFILE_KEY_V1 = 'pva.clapProfile.v1';
const PROFILE_KEY = 'pva.clapProfile.v2';

type ProfileKind = 'standard' | 'calibrated' | 'ambient' | 'manual';
const KIND_LABEL: Record<ProfileKind, string> = {
  standard: '標準',
  calibrated: 'キャリブレーション済み（このPC・この部屋用）',
  ambient: '環境音の測定結果から作成（拍手は未測定）',
  manual: '手動設定',
};

interface ClapSettings {
  sensitivity: number;
  maxIntervalMs: number;
}
const DEFAULT_SETTINGS: ClapSettings = { sensitivity: 5, maxIntervalMs: 600 };

interface ProfileState {
  kind: ProfileKind;
  profile: ClapProfile;
}

function loadSettings(): ClapSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<ClapSettings> | null;
    return {
      sensitivity: clampInt(Number(raw?.sensitivity ?? DEFAULT_SETTINGS.sensitivity), 1, 10),
      maxIntervalMs: clampInt(Number(raw?.maxIntervalMs ?? DEFAULT_SETTINGS.maxIntervalMs), 300, 1000),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadProfile(): ProfileState {
  try {
    const v2 = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null') as { kind?: unknown; profile?: unknown } | null;
    const p2 = sanitizeProfile(v2?.profile);
    if (p2 && typeof v2?.kind === 'string' && v2.kind in KIND_LABEL) return { kind: v2.kind as ProfileKind, profile: p2 };
    // v3 で保存したキャリブレーション結果を引き継ぐ
    const p1 = sanitizeProfile(JSON.parse(localStorage.getItem(PROFILE_KEY_V1) ?? 'null'));
    if (p1) return { kind: 'calibrated', profile: p1 };
  } catch {
    /* 壊れた保存データは無視 */
  }
  return { kind: 'standard', profile: DEFAULT_PROFILE };
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
  conversationBusy: boolean;
  onClapStart: () => Promise<void>;
  noSpeechTimeoutSec: number;
}

export function ClapPanel({ conversationBusy, onClapStart, noSpeechTimeoutSec }: ClapPanelProps) {
  // 拍手待機は毎回 OFF から（マイクを勝手に使わないため）。感度・間隔・基準は保存する
  const [standbyOn, setStandbyOn] = useState(false);
  const [settings, setSettings] = useState<ClapSettings>(loadSettings);
  const [profileState, setProfileState] = useState<ProfileState>(loadProfile);
  const [manualOpen, setManualOpen] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [testCount, setTestCount] = useState(0);
  const calib = useCalibration();
  const calibrating = calib.step !== 'idle';
  const { profile, kind } = profileState;

  useEffect(() => save(SETTINGS_KEY, settings), [settings]);

  const applyProfile = useCallback((next: ProfileState) => {
    setProfileState(next);
    if (next.kind === 'standard') {
      save(PROFILE_KEY, null);
      save(PROFILE_KEY_V1, null);
    } else save(PROFILE_KEY, next);
  }, []);

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

  const result = calib.snap?.result ?? null;
  const useResult = (which: 'calibrated' | 'ambient' | 'manual') => {
    if (!result) return;
    const p = which === 'calibrated' ? result.profile : result.fallbackProfile;
    applyProfile({ kind: which, profile: p });
    setSettings((s) => ({ ...s, sensitivity: 5 }));
    if (which === 'manual') setManualOpen(true);
    calib.cancel();
  };

  const micInfo = calibrating ? calib.mic : standby.processing;
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

      {standbyOn && standby.meter && <LiveLevels meter={standby.meter} />}
      {(standbyOn || calibrating) && micInfo && <MicInfo p={micInfo} />}

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
        <span className="meta">判定基準：{KIND_LABEL[kind]}</span>
        <button className="ghost" onClick={() => void calib.start()} disabled={calibrating || conversationBusy}>
          キャリブレーション
        </button>
        <button className="ghost" onClick={() => setManualOpen((v) => !v)} disabled={calibrating}>
          手動設定{manualOpen ? 'を閉じる' : ''}
        </button>
        {kind !== 'standard' && (
          <button className="ghost" onClick={() => applyProfile({ kind: 'standard', profile: DEFAULT_PROFILE })} disabled={calibrating}>
            標準に戻す
          </button>
        )}
        <label className="check">
          <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
          テストモード（会話を始めず回数だけ数える）
        </label>
      </div>

      {calibrating && <CalibrationWizard calib={calib} onUse={useResult} />}

      {manualOpen && !calibrating && (
        <ManualSettings
          profile={profile}
          onChange={(p) => applyProfile({ kind: 'manual', profile: p })}
        />
      )}

      {testMode && (
        <div className="testmode">
          <span>
            テストモード：拍手2回の検知 <strong>{testCount}</strong> 回
          </span>
          <button className="ghost" onClick={() => setTestCount(0)}>
            0 に戻す
          </button>
          <span className="meta">20回叩いて18回以上検知できれば合格の目安です（料金はかかりません）。</span>
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

/** 現在の入力・環境音の基準値・拍手判定しきい値 */
function LiveLevels({ meter }: { meter: Meter }) {
  return (
    <div className="meter" aria-label="マイク入力レベル">
      <LevelBar levelDb={meter.levelDb} floorDb={meter.floorDb} gateDb={meter.triggerDb} />
      <div className="levels">
        <span>
          現在の入力 <strong>{fmtDb(meter.levelDb)}</strong>
        </span>
        <span>
          環境音の基準値 <strong>{fmtDb(meter.floorDb)}</strong>
          <small>（自動推定）</small>
        </span>
        <span>
          拍手判定しきい値 <strong>{fmtDb(meter.triggerDb)}</strong>
          <small>（赤線）</small>
        </span>
      </div>
    </div>
  );
}

function LevelBar({ levelDb, floorDb, gateDb }: { levelDb: number; floorDb?: number | null; gateDb?: number | null }) {
  return (
    <div className="meter-bar">
      <div className="meter-fill" style={{ width: `${dbToPct(levelDb)}%` }} />
      {floorDb != null && <div className="meter-floor" style={{ left: `${dbToPct(floorDb)}%` }} title="環境音の基準値" />}
      {gateDb != null && <div className="meter-th" style={{ left: `${dbToPct(gateDb)}%` }} title="拍手判定しきい値" />}
    </div>
  );
}

function MicInfo({ p }: { p: MicProcessing }) {
  const items: Array<[string, boolean | null]> = [
    ['自動音量調整', p.autoGainControl],
    ['ノイズ抑制', p.noiseSuppression],
    ['エコーキャンセル', p.echoCancellation],
  ];
  if (p.voiceIsolation !== null) items.push(['声の分離', p.voiceIsolation]);
  const anyOn = items.some(([, v]) => v === true);
  return (
    <div className={`proc ${anyOn ? 'proc-warn' : ''}`}>
      <div className="meta">
        使用中のマイク：<strong>{p.label || '（名前を取得できません）'}</strong>（{Math.round(p.sampleRate / 100) / 10}kHz）
      </div>
      <div className="proc-row">
        <span className="meta">音声加工（要求はすべて OFF）→ 実際：</span>
        {items.map(([name, v]) => (
          <span key={name} className={`chip ${v === true ? 'chip-ng' : v === false ? 'chip-ok' : ''}`}>
            {name} {v === true ? 'ON' : v === false ? 'OFF' : '不明'}
          </span>
        ))}
      </div>
      {anyOn && (
        <div className="meta">
          ブラウザが音声加工を止められませんでした。拍手の音が削られる可能性があります。Windows の「設定 → システム → サウンド →
          マイクのプロパティ」で「オーディオの強化」や「音声フォーカス」等をオフにしてください。
        </div>
      )}
      <div className="meta">
        別のマイクを使うには、アドレスバー左のアイコン →「サイトの設定」→ マイク で選び、ページを再読み込みしてください。
      </div>
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
          <li key={c.key} className={c.pass ? 'pass' : 'fail'}>
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

function ManualSettings({ profile, onChange }: { profile: ClapProfile; onChange: (p: ClapProfile) => void }) {
  return (
    <div className="manual">
      <div className="meta">
        値を変えるとすぐに反映されます（感度 5 のときの基準。感度スライダーはこの値を全体的に緩める／厳しくします）。
        テストモードと「直近の大きな音」の ✓／✗ を見ながら調整してください。
      </div>
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
            <small className="meta">{f.help}</small>
          </label>
        ))}
      </div>
    </div>
  );
}

function CalibrationWizard({
  calib,
  onUse,
}: {
  calib: ReturnType<typeof useCalibration>;
  onUse: (which: 'calibrated' | 'ambient' | 'manual') => void;
}) {
  const { step, snap } = calib;
  const amb = snap?.ambient ?? null;
  const running = step === 'ambient' || step === 'claps' || step === 'noise';
  return (
    <div className="wizard" role="dialog" aria-label="キャリブレーション">
      <div className="wizard-steps">
        <span className={step === 'ambient' ? 'on' : ''}>1. 環境音</span>
        <span className={step === 'claps' ? 'on' : ''}>2. 拍手 {CALIB_TIMING.clapsTarget} 回</span>
        <span className={step === 'noise-ready' || step === 'noise' ? 'on' : ''}>3. 声・キーボード（任意）</span>
        <span className={step === 'result' ? 'on' : ''}>4. 結果</span>
      </div>
      <p className="meta">各手順は時間で自動的に次へ進みます。小さな物音があっても最初からやり直しにはなりません。</p>

      {step === 'ambient' && (
        <p>
          <strong>ふだんの部屋の状態のままお待ちください</strong>（完全な無音でなくて大丈夫です。拍手はまだしないでください）
          <br />
          環境音を測っています… 残り {snap?.secondsLeft ?? Math.round(CALIB_TIMING.ambientMs / 1000)} 秒
        </p>
      )}
      {step === 'claps' && snap && (
        <p>
          <strong>1秒ほど間をあけて、ふだん起動するときと同じ位置・強さで1回ずつ拍手</strong>してください。
          <br />
          拍手 <strong>{snap.clapCount}</strong> / {CALIB_TIMING.clapsTarget} 回（残り {snap.secondsLeft} 秒で自動的に次へ）
          {snap.ignoredCount > 0 && (
            <>
              <br />
              <small className="meta">
                しきい値に届かない小さな音を {snap.ignoredCount} 回無視しました
                {snap.lastIgnoredDb !== null && `（直近 ${fmtDb(snap.lastIgnoredDb)}）`}。拍手が数えられない場合は、もう少し強く叩いてください。
              </small>
            </>
          )}
        </p>
      )}
      {step === 'noise-ready' && snap && (
        <div>
          <p>
            拍手を {snap.clapCount} 回数えました。続けて、<strong>誤起動させたくない音</strong>（ふだんの声で話す・キーボードを打つ）を{' '}
            {Math.round(CALIB_TIMING.noiseMs / 1000)} 秒測ると、それと区別できる基準にします。
            <br />
            <small className="meta">{snap.secondsLeft} 秒操作がなければ、自動で結果へ進みます。</small>
          </p>
          <div className="row-actions">
            <button className="ghost" onClick={calib.startNoise}>
              測る（{Math.round(CALIB_TIMING.noiseMs / 1000)}秒）
            </button>
            <button className="ghost" onClick={calib.skipNoise}>
              スキップして結果へ
            </button>
          </div>
        </div>
      )}
      {step === 'noise' && snap && (
        <p>
          <strong>ふだんの声で話す、またはキーボードを打ってください</strong>（拍手はしないでください）… 残り {snap.secondsLeft} 秒
        </p>
      )}

      {running && snap && (
        <div className="meter">
          <LevelBar levelDb={snap.levelDb} floorDb={amb?.floorDb ?? snap.liveFloorDb} gateDb={amb?.clapGateDb ?? null} />
          <div className="levels">
            <span>
              現在の入力 <strong>{fmtDb(snap.levelDb)}</strong>
            </span>
            <span>
              環境音の基準値 <strong>{fmtDb(amb?.floorDb ?? snap.liveFloorDb)}</strong>
              <small>{amb ? '（測定済み）' : '（測定中）'}</small>
            </span>
            <span>
              拍手判定しきい値 <strong>{amb ? fmtDb(amb.clapGateDb) : '測定後に決定'}</strong>
            </span>
          </div>
        </div>
      )}

      {step === 'result' && snap?.result && (
        <div>
          <p>
            <strong>{snap.result.ok ? 'キャリブレーション完了' : '拍手の測定ができませんでした'}</strong>
          </p>
          <ul className="notes">
            <li>
              環境音の基準値：{fmtDb(snap.result.summary.floorDb)}
              {snap.result.summary.smallSoundDb !== null && ` ／ 環境の小さな音：${fmtDb(snap.result.summary.smallSoundDb)}`}
              {' ／ '}拍手判定しきい値：{fmtDb(snap.result.ok ? snap.result.profile.minLevelDb : snap.result.fallbackProfile.minLevelDb)}
            </li>
            {snap.result.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <div className="row-actions">
            {snap.result.ok ? (
              <button onClick={() => onUse('calibrated')}>この基準を使う</button>
            ) : (
              <button onClick={() => onUse('ambient')}>環境音の結果だけで試す</button>
            )}
            <button className="ghost" onClick={() => onUse('manual')}>
              手動設定で試す
            </button>
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
      {running && (
        <div className="row-actions">
          <button className="ghost" onClick={calib.cancel}>
            中止
          </button>
        </div>
      )}
    </div>
  );
}

function clampInt(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min;
}
function dbToPct(db: number): number {
  return Math.min(100, Math.max(0, ((db + 80) / 80) * 100));
}
function fmtDb(db: number): string {
  return `${Math.max(-99, Math.round(db))}dB`;
}
function fmtNum(n: number): string {
  return Math.abs(n) >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}
