import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_PROFILE, type ClapProfile, type DoubleClapDetail } from './clapDetector';
import {
  addRecord,
  type ClapOutcome,
  type ClapTriggerRecord,
  GUARD_COUNT,
  loadClapHistory,
  recordFromDetail,
  saveClapHistory,
  setOutcome,
  shouldPauseClap,
} from './clapHistory';
import { sanitizeProfile } from './calibration';
import { playChime } from './chime';
import { useCalibration } from './useCalibration';
import { useClapStandby, type LogEntry, type StandbyStatus } from './useClapStandby';

/**
 * 拍手待機の状態と操作（画面から独立したロジック層）。
 * 旧 ClapPanel の処理をそのまま移したもの。画面（src/ui）はこの戻り値を表示・操作するだけ。
 */

export const CLAP_STATUS_LABEL: Record<StandbyStatus, string> = {
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

export type ProfileKind = 'standard' | 'calibrated' | 'ambient' | 'manual';
export const KIND_LABEL: Record<ProfileKind, string> = {
  standard: '標準',
  calibrated: 'キャリブレーション済み（このPC・この部屋用）',
  ambient: '環境音の測定結果から作成（拍手は未測定）',
  manual: '手動設定',
};

export interface ClapSettings {
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

export interface ClapControllerOptions {
  /** 会話中・起動処理中（拍手・呼びかけ共通）は止める */
  paused: boolean;
  /** テストモード：拍手2回で会話を始めず、回数だけ数える */
  testMode: boolean;
  onClapStart: () => Promise<void>;
}

export function useClapController({ paused, testMode, onClapStart }: ClapControllerOptions) {
  // 拍手待機は毎回 OFF から（マイクを勝手に使わないため）。感度・間隔・基準は保存する
  const [standbyOn, setStandbyOn] = useState(false);
  const [settings, setSettings] = useState<ClapSettings>(loadSettings);
  const [profileState, setProfileState] = useState<ProfileState>(loadProfile);
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

  // 拍手で起動したときの履歴（判定値と、その後に話しかけたか）。数値だけを保存する
  const [history, setHistory] = useState<ClapTriggerRecord[]>(loadClapHistory);
  useEffect(() => saveClapHistory(history), [history]);
  const pendingIdRef = useRef<string | null>(null);
  /** 誤起動による自動停止の判定は、拍手待機を ON にした時点以降の記録だけで行う */
  const guardSinceRef = useRef(0);
  const [guardNotice, setGuardNotice] = useState<string | null>(null);

  const onDoubleClap = useCallback(
    (detail: DoubleClapDetail) => {
      const at = Date.now();
      if (testMode) {
        // テストモード：会話は開始せず、回数だけ数える（API 料金なし）
        setHistory((h) => addRecord(h, recordFromDetail(detail, { at, profileKind: kind, outcome: 'test' })));
        setTestCount((n) => n + 1);
        void playChime();
        return;
      }
      const rec = recordFromDetail(detail, { at, profileKind: kind, outcome: 'pending' });
      pendingIdRef.current = rec.id;
      setHistory((h) => addRecord(h, rec));
      // 起動音・接続・二重起動防止は App 側でまとめて行う（音声呼びかけと共通）
      void onClapStart();
    },
    [onClapStart, testMode, kind],
  );

  const historyRef = useRef(history);
  historyRef.current = history;

  /** 拍手で始めた会話の結果を記録する。誤起動が続いたら拍手待機を止めて true を返す */
  const markOutcome = useCallback((outcome: Exclude<ClapOutcome, 'pending' | 'test'>): boolean => {
    const id = pendingIdRef.current;
    pendingIdRef.current = null;
    if (!id) return false;
    const next = setOutcome(historyRef.current, id, outcome);
    historyRef.current = next;
    setHistory(next);
    const paused = outcome === 'no-speech' && shouldPauseClap(next, Date.now(), guardSinceRef.current);
    if (paused) {
      setStandbyOn(false);
      setGuardNotice(`拍手で起動したあと話しかけがない状態が ${GUARD_COUNT} 回続いたため、誤起動と判断して拍手待機をOFFにしました（不要な接続を防ぐため）。`);
    }
    return paused;
  }, []);

  const setStandby = useCallback((v: boolean) => {
    if (v) {
      guardSinceRef.current = Date.now();
      setGuardNotice(null);
    }
    setStandbyOn(v);
  }, []);

  const standby = useClapStandby({
    enabled: standbyOn,
    paused: paused || calibrating,
    sensitivity: settings.sensitivity,
    maxIntervalMs: settings.maxIntervalMs,
    profile,
    onDoubleClap,
  });

  /** キャリブレーション結果の採用（成功時の基準／環境音のみの基準／手動設定の初期値） */
  const useCalibrationResult = (which: 'calibrated' | 'ambient' | 'manual') => {
    const result = calib.snap?.result;
    if (!result) return;
    const p = which === 'calibrated' ? result.profile : result.fallbackProfile;
    applyProfile({ kind: which, profile: p });
    setSettings((s) => ({ ...s, sensitivity: 5 }));
    calib.cancel();
  };

  const lastSound = standby.log.find((l): l is Extract<LogEntry, { kind: 'sound' }> => l.kind === 'sound') ?? null;

  return {
    standbyOn,
    setStandbyOn: setStandby,
    history,
    clearHistory: () => setHistory([]),
    markOutcome,
    guardNotice,
    dismissGuardNotice: () => setGuardNotice(null),
    settings,
    setSensitivity: (v: number) => setSettings((s) => ({ ...s, sensitivity: clampInt(v, 1, 10) })),
    setMaxIntervalMs: (v: number) => setSettings((s) => ({ ...s, maxIntervalMs: clampInt(v, 300, 1000) })),
    profile,
    profileKind: kind,
    setManualProfile: (p: ClapProfile) => applyProfile({ kind: 'manual', profile: p }),
    resetProfile: () => applyProfile({ kind: 'standard', profile: DEFAULT_PROFILE }),
    calib,
    calibrating,
    useCalibrationResult,
    standby,
    status: standby.status as StandbyStatus,
    lastSound,
    testCount,
    resetTestCount: () => setTestCount(0),
  };
}

export type ClapController = ReturnType<typeof useClapController>;

function clampInt(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min;
}
