import { useCallback, useEffect, useState } from 'react';
import { playChime } from '../clap/chime';
import { useWakeStandby, type WakeLogEntry, type WakeStatus } from './useWakeStandby';
import type { WakeDecision, WakePhraseMode } from './wakePolicy';

/**
 * 音声待機（呼びかけ）の状態と操作（画面から独立したロジック層）。旧 WakePanel の処理をそのまま移したもの。
 */

export const WAKE_STATUS_LABEL: Record<WakeStatus, string> = {
  off: 'OFF',
  checking: '準備中…',
  'not-installed': '音声認識モデルが未設置です',
  loading: '音声認識モデルを読み込み中…（数秒）',
  listening: '待機中 — 呼びかけてください',
  paused: '一時停止中（会話中は呼びかけ検出を止めています）',
  error: 'エラー',
};

export const MODE_LABEL: Record<WakePhraseMode, string> = {
  both: '「カイト」と「ねえ、カイト」の両方',
  nee: '「ねえ、カイト」のみ（誤起動が最も少ない）',
  kaito: '「カイト」のみ',
};

const SETTINGS_KEY = 'pva.wakeSettings.v1';
export interface WakeSettings {
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

export interface WakeControllerOptions {
  paused: boolean;
  testMode: boolean;
  onWakeStart: (d: WakeDecision) => Promise<void>;
}

export function useWakeController({ paused, testMode, onWakeStart }: WakeControllerOptions) {
  // 音声待機は毎回 OFF から（マイクを勝手に使わないため）。設定だけ保存する
  const [on, setOn] = useState(false);
  const [settings, setSettings] = useState<WakeSettings>(loadSettings);
  const [testCount, setTestCount] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* 保存できなくても動作には影響しない */
    }
  }, [settings]);

  const onWake = useCallback(
    (d: WakeDecision) => {
      if (testMode) {
        // テストモード：会話は開始せず、回数だけ数える（API 料金なし）
        setTestCount((n) => n + 1);
        void playChime();
        return;
      }
      void onWakeStart(d);
    },
    [onWakeStart, testMode],
  );

  const wake = useWakeStandby({
    enabled: on,
    paused,
    mode: settings.mode,
    sensitivity: settings.sensitivity,
    noiseReduction: settings.noiseReduction,
    onWake,
  });
  const lastDecision = wake.log.find((l): l is Extract<WakeLogEntry, { kind: 'decision' }> => l.kind === 'decision') ?? null;

  return {
    on,
    setOn,
    settings,
    setMode: (mode: WakePhraseMode) => setSettings((s) => ({ ...s, mode })),
    setSensitivity: (v: number) => setSettings((s) => ({ ...s, sensitivity: Math.min(10, Math.max(1, Math.round(v))) })),
    setNoiseReduction: (v: boolean) => setSettings((s) => ({ ...s, noiseReduction: v })),
    wake,
    status: wake.status as WakeStatus,
    lastDecision,
    testCount,
    resetTestCount: () => setTestCount(0),
  };
}

export type WakeController = ReturnType<typeof useWakeController>;
