import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthInfo } from '../shared/assistant';
import { getMicHubInfo } from './audio/micHub';
import { playChime } from './clap/chime';
import { useClapController } from './clap/useClapController';
import { createTriggerGate } from './triggerGate';
import { CalibrationModal } from './ui/CalibrationModal';
import { CommandBar } from './ui/CommandBar';
import { CommandCore } from './ui/CommandCore';
import { CommandHeader, type ServerView } from './ui/CommandHeader';
import { deriveCoreView } from './ui/coreState';
import { DetailSettings } from './ui/DetailSettings';
import { DisplayHost, type DisplayView } from './ui/display/DisplayHost';
import { InfoPanel } from './ui/InfoPanel';
import { SideDrawer, type DrawerTab } from './ui/SideDrawer';
import { VoicePanel } from './ui/VoicePanel';
import { TacticalBackdrop } from './ui/TacticalBackdrop';
import { useVoiceSession } from './useVoiceSession';
import { createKaitoTools, createWeatherActions } from './tools/kaitoTools';
import { ForecastStore } from './tools/forecastStore';
import { useVoiceSettings } from './voice/useVoiceSettings';
import { useConversationSettings } from './voice/conversationSettings';
import { useWakeController } from './wake/useWakeController';

const UI_KEY = 'pva.ui.v1';
function loadLowMotion(): boolean {
  try {
    return (JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') as { lowMotion?: boolean }).lowMotion === true;
  } catch {
    return false;
  }
}

/**
 * KAITO 第6版：MILITARY SPACE COMMAND。
 * 検出・会話・声のロジックは各 controller / hook にあり、ここは組み立てと表示だけ。
 */
export function App() {
  // 中央の表示内容（天気予報などのパネル、または AI コア）。会話中のツールからも切り替える
  const [display, setDisplay] = useState<DisplayView>({ kind: 'core' });
  // 取得済みの天気予報（1 時間ごとの元データ）。画面も AI も同じものを参照する
  const storeRef = useRef(new ForecastStore());
  const getTools = useCallback(() => createKaitoTools({ show: setDisplay, store: storeRef.current }), []);
  const voice = useVoiceSession({ getTools });
  const { phase, start, stop } = voice;
  const voiceSettings = useVoiceSettings();
  const conversation = useConversationSettings();
  const [server, setServer] = useState<ServerView>({ kind: 'checking' });
  const [testMode, setTestMode] = useState(false);
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  const [calibOpen, setCalibOpen] = useState(false);
  const [lowMotion, setLowMotion] = useState(loadLowMotion);
  const [burstKey, setBurstKey] = useState(0);
  const [pulseKey, setPulseKey] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ lowMotion }));
    } catch {
      /* 保存できなくても動作には影響しない */
    }
  }, [lowMotion]);

  // 拍手・音声呼びかけ・ボタン共通の起動処理。同時に検知しても接続は 1 回だけ（二重接続防止）
  const [triggering, setTriggering] = useState(false);
  const gateRef = useRef(createTriggerGate());
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // 次の会話で使う声・音声調整（保存済みの設定。会話中に変えても次の会話から適用）
  const startOptsRef = useRef({ voice: voiceSettings.chosen, ...conversation.settings });
  startOptsRef.current = { voice: voiceSettings.chosen, ...conversation.settings };
  const triggerStart = useCallback(
    async (source: 'clap' | 'wake') => {
      if (phaseRef.current !== 'idle') return;
      await gateRef.current.run(async () => {
        setTriggering(true); // ここで拍手・音声の待機を止め、マイクを解放する
        try {
          await playChime();
          await start({ trigger: source, ...startOptsRef.current });
        } finally {
          setTriggering(false);
        }
      });
    },
    [start],
  );
  const onManualStart = useCallback(() => {
    setBurstKey((k) => k + 1);
    void gateRef.current.run(() => start({ ...startOptsRef.current }));
  }, [start]);

  const standbyPaused = phase !== 'idle' || triggering;
  const wake = useWakeController({ paused: standbyPaused, testMode, onWakeStart: () => triggerStart('wake') });
  const clap = useClapController({ paused: standbyPaused, testMode, onClapStart: () => triggerStart('clap') });

  // コアの演出は実際の検出イベントだけで動かす
  const lastWakeId = wake.lastDecision?.decision.accepted ? wake.lastDecision.id : null;
  useEffect(() => {
    if (lastWakeId !== null) setBurstKey((k) => k + 1); // 呼びかけ認識：アンバーのリングが広がる
  }, [lastWakeId]);
  const clapLogTop = clap.standby.log[0];
  const clapEventId = clapLogTop && clapLogTop.kind === 'note' ? `${clapLogTop.id}:${clapLogTop.text}` : null;
  useEffect(() => {
    if (!clapEventId) return;
    if (clapEventId.includes('1回目の拍手')) setPulseKey((k) => k + 1); // 拍手 1 回目：外周が反応
    else if (clapEventId.includes('拍手2回を検知')) setBurstKey((k) => k + 1);
  }, [clapEventId]);

  // 開発用（npm run dev のときだけ）：会話と同じ経路でツールを実行して画面を確認する
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // AI のツールと同じ処理（createWeatherActions）を呼ぶ
    const actions = createWeatherActions({ show: setDisplay, store: storeRef.current });
    (window as unknown as { __kaito?: unknown }).__kaito = {
      forecast: actions.forecast,
      hours: actions.hours,
      showMain: actions.mainScreen,
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch('/api/health')
      .then((r) => (r.ok ? (r.json() as Promise<HealthInfo>) : Promise.reject(new Error('bad status'))))
      .then((info) => alive && setServer({ kind: 'up', apiKeyConfigured: info.apiKeyConfigured, model: info.model, defaultVoice: info.defaultVoice }))
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
    wake: { on: wake.on, status: wake.status, error: wake.wake.error },
    clap: { on: clap.standbyOn, status: clap.status, error: clap.standby.error },
  });

  // レベル：会話中は会話用マイク、待機中は待機用マイクの実測値。使っていなければ null
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
    voiceSettings.previewError ? `試聴：${voiceSettings.previewError}` : null,
  ].filter((e): e is string => Boolean(e));

  const remaining = phase === 'connected' && voice.remaining !== null ? `${Math.floor(voice.remaining / 60)}:${String(voice.remaining % 60).padStart(2, '0')}` : null;
  const apiKeyConfigured = server.kind === 'up' && server.apiKeyConfigured;

  return (
    <div className={`k6 state-${view.state.toLowerCase()} ${drawer ? 'drawer-open' : ''}`}>
      <TacticalBackdrop lowMotion={lowMotion} />
      <CommandHeader server={server} phase={phase} />
      <main className="stage" aria-live="polite">
        <DisplayHost
          view={display}
          onClose={() => {
            storeRef.current.displayedId = null;
            setDisplay({ kind: 'core' });
          }}
          core={<CommandCore view={view} readLevel={readCoreLevel} burstKey={burstKey} pulseKey={pulseKey} detail={remaining} />}
        />
        {view.notice && <p className="stage-notice">{view.notice}</p>}
      </main>
      <CommandBar
        wakeOn={wake.on}
        setWakeOn={wake.setOn}
        clapOn={clap.standbyOn}
        setClapOn={clap.setStandbyOn}
        phase={phase}
        triggering={triggering}
        test={testMode ? { wake: wake.testCount, clap: clap.testCount } : null}
        onStart={onManualStart}
        onStop={() => void stop()}
        onSettings={() => setDrawer((d) => (d ? null : errors.length ? 'diag' : 'voice'))}
        settingsOpen={drawer !== null}
        alert={errors.length > 0}
      />
      <SideDrawer tab={drawer} onTab={setDrawer} onClose={() => setDrawer(null)} alert={errors.length > 0}>
        {drawer === 'voice' && (
          <VoicePanel vs={voiceSettings} conv={conversation} defaultVoice={server.kind === 'up' ? server.defaultVoice : null} apiKeyConfigured={apiKeyConfigured} busy={phase !== 'idle' || triggering} />
        )}
        {drawer === 'detail' && (
          <DetailSettings
            wake={wake}
            clap={clap}
            busy={phase !== 'idle' || triggering}
            testMode={testMode}
            setTestMode={setTestMode}
            lowMotion={lowMotion}
            setLowMotion={setLowMotion}
            onCalibrate={() => {
              setCalibOpen(true);
              void clap.calib.start();
            }}
            readMicDb={readMicDb}
          />
        )}
        {drawer === 'diag' && <InfoPanel wake={wake} clap={clap} lines={voice.lines} connected={phase === 'connected'} errors={errors} notice={voice.notice} />}
      </SideDrawer>
      {calibOpen && <CalibrationModal clap={clap} onClose={() => setCalibOpen(false)} onManual={() => setDrawer('detail')} />}
    </div>
  );
}
