import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthInfo } from '../shared/assistant';
import { getMicHubInfo } from './audio/micHub';
import { playChime } from './clap/chime';
import { useClapController } from './clap/useClapController';
import { createTriggerGate } from './triggerGate';
import { AiCore } from './ui/AiCore';
import { CalibrationModal } from './ui/CalibrationModal';
import { ControlDock } from './ui/ControlDock';
import { deriveCoreView } from './ui/coreState';
import { Header, type ServerView } from './ui/Header';
import { InfoPanel } from './ui/InfoPanel';
import { SettingsModal } from './ui/SettingsModal';
import { useVoiceSession } from './useVoiceSession';
import { useWakeController } from './wake/useWakeController';

/**
 * KAITO 待機画面（RED COMMAND × LUX SECRETARY）。
 * 検出・会話のロジックは各 controller / hook にあり、ここでは組み立てと表示だけを行う。
 */
export function App() {
  const voice = useVoiceSession();
  const { phase, start, stop } = voice;
  const [server, setServer] = useState<ServerView>({ kind: 'checking' });
  const [testMode, setTestMode] = useState(false);
  const [modal, setModal] = useState<'none' | 'calibration' | 'settings'>('none');
  const [burstKey, setBurstKey] = useState(0);

  // 拍手・音声呼びかけ共通の起動処理。同時に検知しても接続は 1 回だけ（二重接続防止）
  const [triggering, setTriggering] = useState(false);
  const gateRef = useRef(createTriggerGate());
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const triggerStart = useCallback(
    async (source: 'clap' | 'wake') => {
      if (phaseRef.current !== 'idle') return;
      await gateRef.current.run(async () => {
        setTriggering(true); // ここで拍手・音声の待機を止め、マイクを解放する
        setBurstKey((k) => k + 1);
        try {
          await playChime();
          await start({ trigger: source });
        } finally {
          setTriggering(false);
        }
      });
    },
    [start],
  );
  const onManualStart = useCallback(() => {
    setBurstKey((k) => k + 1);
    void start();
  }, [start]);

  const standbyPaused = phase !== 'idle' || triggering;
  const wake = useWakeController({ paused: standbyPaused, testMode, onWakeStart: () => triggerStart('wake') });
  const clap = useClapController({ paused: standbyPaused, testMode, onClapStart: () => triggerStart('clap') });

  // テストモードの検知も、起動演出（リングが広がる）を 1 回出す
  const testTotal = wake.testCount + clap.testCount;
  const prevTest = useRef(testTotal);
  useEffect(() => {
    if (testTotal > prevTest.current) setBurstKey((k) => k + 1);
    prevTest.current = testTotal;
  }, [testTotal]);

  useEffect(() => {
    let alive = true;
    fetch('/api/health')
      .then((r) => (r.ok ? (r.json() as Promise<HealthInfo>) : Promise.reject(new Error('bad status'))))
      .then((info) => alive && setServer({ kind: 'up', apiKeyConfigured: info.apiKeyConfigured, model: info.model }))
      .catch(() => alive && setServer({ kind: 'down' }));
    return () => {
      alive = false;
    };
  }, []);

  const view = deriveCoreView({
    phase,
    triggering,
    server: server.kind,
    apiKeyConfigured: server.kind === 'up' ? server.apiKeyConfigured : null,
    voiceError: voice.error,
    testMode,
    wake: { on: wake.on, status: wake.status, error: wake.wake.error, mode: wake.settings.mode },
    clap: { on: clap.standbyOn, status: clap.status, error: clap.standby.error },
  });

  // レベル表示：会話中は会話用マイク、待機中は待機用マイクの実測値。どちらも使っていなければ null
  const readMicDb = useCallback((): number | null => {
    const lv = voice.getInputLevel();
    if (lv !== null) return lv * 50 - 60;
    return getMicHubInfo().levelDb;
  }, [voice]);
  const readCoreLevel = useCallback((): number | null => {
    const db = readMicDb();
    return db === null ? null : Math.min(1, Math.max(0, (db + 60) / 50));
  }, [readMicDb]);

  const errors = [
    server.kind === 'down' ? 'ローカルサーバーに接続できません（npm run dev を確認）。' : null,
    server.kind === 'up' && !server.apiKeyConfigured ? 'APIキーが未設定です。.env を設定してサーバーを再起動してください（待機・テストモードは使えます）。' : null,
    voice.error ? `会話：${voice.error}` : null,
    wake.on && wake.status === 'not-installed' ? '音声認識モデルが未設置です。PowerShell で npm run setup:wake を実行してください。' : null,
    wake.on && wake.wake.error ? `音声待機：${wake.wake.error}` : null,
    clap.standbyOn && clap.standby.error ? `拍手待機：${clap.standby.error}` : null,
  ].filter((e): e is string => Boolean(e));

  const remaining = phase === 'connected' && voice.remaining !== null ? `残り ${formatSec(voice.remaining)}` : null;

  return (
    <div className={`kaito state-${view.state.toLowerCase()}`}>
      <Header server={server} phase={phase} />
      <main className="k-main">
        <section className="k-stage" aria-live="polite">
          <AiCore state={view.state} sub={view.sub} readLevel={readCoreLevel} burstKey={burstKey} detail={remaining} />
          <p className="k-hint">{view.hint}</p>
          {testMode && (
            <p className="k-testline">
              TEST MODE　呼びかけ <strong>{wake.testCount}</strong> 回 ／ 拍手 <strong>{clap.testCount}</strong> 回（会話は開始しません・料金なし）
            </p>
          )}
        </section>
        <InfoPanel wake={wake} clap={clap} lines={voice.lines} connected={phase === 'connected'} errors={errors} notice={voice.notice} />
      </main>
      <ControlDock
        wake={wake}
        clap={clap}
        testMode={testMode}
        setTestMode={setTestMode}
        phase={phase}
        triggering={triggering}
        onStart={onManualStart}
        onStop={() => void stop()}
        onCalibrate={() => {
          setModal('calibration');
          void clap.calib.start();
        }}
        onSettings={() => setModal('settings')}
        readMicDb={readMicDb}
      />
      {modal === 'calibration' && <CalibrationModal clap={clap} onClose={() => setModal('none')} onManual={() => setModal('settings')} />}
      {modal === 'settings' && <SettingsModal wake={wake} clap={clap} onClose={() => setModal('none')} />}
    </div>
  );
}

function formatSec(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
