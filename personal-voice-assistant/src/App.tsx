import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { PersonaPanel } from './ui/PersonaPanel';
import { MemoryPanel } from './ui/MemoryPanel';
import { DesktopPanel } from './ui/DesktopPanel';
import { launchMode, useDesktop } from './desktop/useDesktop';
import { useMemory } from './memory/useMemory';
import { ConversationLogger } from './memory/conversationLogger';
import { createMemoryTools } from './memory/memoryTools';
import { usePersona } from './persona/usePersona';
import { TacticalBackdrop } from './ui/TacticalBackdrop';
import { useVoiceSession, type SessionEndInfo } from './useVoiceSession';
import { LatencyTrace, loadLatency, saveLatency, LATENCY_MAX, type LatencyRecord } from './latency/latencyTrace';
import { LocalGreetingPlayer } from './voice/localGreeting';
import type { WakeDecision } from './wake/wakePolicy';
import { createKaitoTools, createWeatherActions } from './tools/kaitoTools';
import { ForecastStore } from './tools/forecastStore';
import { useVoiceSettings } from './voice/useVoiceSettings';
import { useConversationSettings } from './voice/conversationSettings';
import { useWakeController } from './wake/useWakeController';

const UI_KEY = 'pva.ui.v1';
/** 待機（音声・拍手）の ON/OFF の記録。デスクトップ版の起動時に、この状態で待機を再開する */
const STANDBY_KEY = 'pva.standby.v1';
function loadStandbyPref(): { wake: boolean; clap: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(STANDBY_KEY) ?? '{}') as { wake?: unknown; clap?: unknown };
    return { wake: v.wake === true, clap: v.clap === true };
  } catch {
    return { wake: false, clap: false };
  }
}
function saveStandbyPref(p: { wake: boolean; clap: boolean }): void {
  try {
    localStorage.setItem(STANDBY_KEY, JSON.stringify(p));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}
/** 起動音の長さ（ms）。この間は会話用マイクの音を送らない */
const CHIME_MS = 450;
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
  // 声での終了（end_conversation）。待機の OFF は下で定義する controller を参照するため ref 経由
  const endByVoiceRef = useRef<(o: { stopStandby: boolean }) => boolean>(() => false);
  // 会話の記録（確定した文字起こしだけをローカルの記憶データベースへ。誤起動で発言がない会話は保存しない）
  const loggerRef = useRef<ConversationLogger | null>(null);
  // 応答時間の記録（数値のみ・このブラウザ内）
  const [latency, setLatency] = useState<LatencyRecord[]>(loadLatency);
  const addLatency = useCallback((r: LatencyRecord) => {
    setLatency((l) => {
      const next = [r, ...l].slice(0, LATENCY_MAX);
      saveLatency(next);
      return next;
    });
    if (import.meta.env.DEV) (window as unknown as { __kaitoLatency?: { last: unknown } }).__kaitoLatency = { last: r };
  }, []);
  // 記憶検索の計測：ユーザーの発言の終わり → ツール要求 → 結果を返す → 回答音声
  const lastSpeechStopRef = useRef<number | null>(null);
  const memTraceRef = useRef<LatencyTrace | null>(null);
  const onMemoryCall = useCallback(
    (e: { tool: string; phase: 'start' | 'end'; serverMs?: number }) => {
      if (e.phase === 'start') {
        memTraceRef.current?.finish();
        const t = new LatencyTrace('memory', addLatency);
        if (lastSpeechStopRef.current !== null) t.mark('speechEnd', lastSpeechStopRef.current);
        t.mark('toolRequested');
        t.note(e.tool);
        memTraceRef.current = t;
        window.setTimeout(() => t.finish(), 20_000);
      } else {
        const t = memTraceRef.current;
        t?.mark('toolReturned');
        if (e.serverMs !== undefined) t?.value('sqliteMs', e.serverMs);
      }
    },
    [addLatency],
  );
  const observer = useMemo(
    () => ({
      onStart: (trigger: 'manual' | 'clap' | 'wake', startedAt: number) => {
        loggerRef.current = new ConversationLogger(trigger, startedAt);
      },
      onEvent: (ev: { type?: string; [k: string]: unknown }) => {
        loggerRef.current?.handleEvent(ev);
        if (ev.type === 'input_audio_buffer.speech_stopped') lastSpeechStopRef.current = performance.now();
        if (ev.type === 'output_audio_buffer.started' && memTraceRef.current?.has('toolReturned')) {
          memTraceRef.current.mark('serverAudio');
          memTraceRef.current.finish();
          memTraceRef.current = null;
        }
      },
      onEnd: () => {
        const l = loggerRef.current;
        loggerRef.current = null;
        void l?.end();
      },
    }),
    [],
  );
  const getTools = useCallback(
    () => [
      ...createKaitoTools({ show: setDisplay, store: storeRef.current, endConversation: (o) => endByVoiceRef.current(o) }),
      ...createMemoryTools({
        current: () => {
          const l = loggerRef.current;
          return l ? { sessionId: l.sessionId, userFinalCount: l.recorder.userFinalCount, recentUserTexts: l.recorder.recentUserTexts() } : null;
        },
        onCall: (e) => onMemoryCallRef.current(e),
      }),
    ],
    [],
  );
  const onMemoryCallRef = useRef(onMemoryCall);
  onMemoryCallRef.current = onMemoryCall;
  // 会話の終了時：拍手で起動した会話なら、話しかけたかどうかを拍手の履歴に記録する（誤起動の判定）
  const onSessionEndRef = useRef<(i: SessionEndInfo) => void>(() => {});
  const voice = useVoiceSession({ getTools, observer, onEnded: (i) => onSessionEndRef.current(i) });
  const { phase, start, stop } = voice;
  const voiceSettings = useVoiceSettings();
  const conversation = useConversationSettings();
  const [server, setServer] = useState<ServerView>({ kind: 'checking' });
  // ローカル挨拶の音声（作成済みなら読み込んでおく。ローカルサーバーからの読み込みだけで、OpenAI には接続しない）
  const greetingRef = useRef(new LocalGreetingPlayer());
  const [greetingInfo, setGreetingInfo] = useState(greetingRef.current.info);
  const greetingVoice = voiceSettings.chosen ?? (server.kind === 'up' ? server.defaultVoice : null);
  const reloadGreeting = useCallback(async () => {
    if (!greetingVoice) return;
    await greetingRef.current.load({ voice: greetingVoice, speed: conversation.settings.speechSpeed });
    setGreetingInfo(greetingRef.current.info);
  }, [greetingVoice, conversation.settings.speechSpeed]);
  useEffect(() => {
    void reloadGreeting();
  }, [reloadGreeting]);
  const [testMode, setTestMode] = useState(false);
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  // KAITO 設定は「KAITO設定」タブを開いたときだけ読み込む（待機中に無駄な処理をしない。OpenAI には接続しない）
  const persona = usePersona(drawer === 'persona');
  // 記憶の管理画面は「MEMORY」タブを開いたときだけ読み込む（ローカルの SQLite のみ。OpenAI には接続しない）
  const memory = useMemory(drawer === 'memory');
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
  const pickStartOpts = () => ({ voice: voiceSettings.chosen, audioProfile: conversation.settings.audioProfile, speechSpeed: conversation.settings.speechSpeed });
  const startOptsRef = useRef(pickStartOpts());
  startOptsRef.current = pickStartOpts();
  const useLocalGreetingRef = useRef(conversation.settings.localGreeting);
  useLocalGreetingRef.current = conversation.settings.localGreeting;
  const earlyGreetingRef = useRef(conversation.settings.earlyGreeting);
  earlyGreetingRef.current = conversation.settings.earlyGreeting;
  const fastStartRef = useRef(conversation.settings.fastStart);
  fastStartRef.current = conversation.settings.fastStart;
  /** 起動時の共通オプション（計測・ローカル挨拶） */
  const startExtras = useCallback(
    (trace: LatencyTrace) => ({
      trace,
      ...(useLocalGreetingRef.current ? { localGreeting: (g: { text: string; voice: string; speed: number }) => greetingRef.current.play(g) } : {}),
      earlyGreeting: earlyGreetingRef.current,
    }),
    [],
  );
  const triggerStart = useCallback(
    async (source: 'clap' | 'wake', d?: WakeDecision) => {
      if (phaseRef.current !== 'idle') return;
      const trace = new LatencyTrace(source, addLatency);
      if (d?.timing) {
        trace.mark('speechEnd', d.timing.speechEndAt);
        trace.mark('recognized', d.timing.recognizedAt);
      }
      await gateRef.current.run(async () => {
        // 認識した瞬間に、起動音と画面の発光で知らせる（OpenAI への接続完了を待たない）
        trace.mark('trigger');
        setTriggering(true); // ここで拍手・音声の待機を止め、マイクを解放する
        setRecognizedAt(Date.now());
        const fast = fastStartRef.current;
        try {
          if (fast) {
            // 高速起動：鳴り終わりを待たずに接続の準備を始める。起動音（約 0.4 秒）の間は会話用マイクの音を送らない
            void playChime();
            await start({ trigger: source, ...startOptsRef.current, ...startExtras(trace), muteMicUntil: performance.now() + CHIME_MS, parallelPrep: true });
          } else {
            // 従来どおり：起動音が鳴り終わってから、マイク → 一時キーの順に準備する
            await playChime();
            await start({ trigger: source, ...startOptsRef.current, ...startExtras(trace) });
          }
        } finally {
          setTriggering(false);
        }
      });
    },
    [start, startExtras, addLatency],
  );
  const onManualStart = useCallback(() => {
    setBurstKey((k) => k + 1);
    const trace = new LatencyTrace('manual', addLatency);
    trace.mark('trigger');
    void gateRef.current.run(async () => {
      await start({ ...startOptsRef.current, ...startExtras(trace), parallelPrep: fastStartRef.current });
    });
  }, [start, startExtras, addLatency]);
  // 「認識しました」の表示（起動処理の開始から約 0.9 秒。その後は「接続中」）
  const [recognizedAt, setRecognizedAt] = useState(0);
  const [recognized, setRecognized] = useState(false);
  useEffect(() => {
    if (!recognizedAt) return;
    setRecognized(true);
    const t = window.setTimeout(() => setRecognized(false), 900);
    return () => window.clearTimeout(t);
  }, [recognizedAt]);

  const standbyPaused = phase !== 'idle' || triggering;
  const wake = useWakeController({ paused: standbyPaused, testMode, onWakeStart: (d) => triggerStart('wake', d) });
  const clap = useClapController({ paused: standbyPaused, testMode, onClapStart: () => triggerStart('clap') });

  // ---------- デスクトップ版 ----------
  const launch = useMemo(() => launchMode(), []);
  // 利用者が待機を ON/OFF したときだけ記録する（終了処理による OFF は記録しない＝次回の起動で再開する）
  const setWakeByUser = (v: boolean) => {
    wake.setOn(v);
    saveStandbyPref({ ...loadStandbyPref(), wake: v });
  };
  const setClapByUser = (v: boolean) => {
    clap.setStandbyOn(v);
    saveStandbyPref({ ...loadStandbyPref(), clap: v });
  };
  // デスクトップから起動したら、記録した状態で待機を再開する（OpenAI には接続しない・挨拶もしない）
  useEffect(() => {
    if (!launch) return;
    const p = loadStandbyPref();
    if (p.wake) wake.setOn(true);
    if (p.clap) clap.setStandbyOn(true);
  }, [launch]);
  const desktopCtl = useDesktop({
    loadStatus: drawer === 'desktop',
    onShutdown: async () => {
      // 終了の順番：待機の停止 → マイクの解放 → 会話の終了（会話履歴の送信を含む）
      wake.setOn(false);
      clap.setStandbyOn(false);
      await stop();
      await new Promise((r) => setTimeout(r, 600));
    },
  });
  // ブラウザの制限で音声処理が止まっているか（自動起動の直後など。画面をクリックすると再開する）
  const [audioBlocked, setAudioBlocked] = useState(false);
  useEffect(() => {
    const id = window.setInterval(() => setAudioBlocked(getMicHubInfo().blocked), 1000);
    return () => window.clearInterval(id);
  }, []);
  const [autostartNotice, setAutostartNotice] = useState(launch === 'autostart');
  useEffect(() => {
    if (!autostartNotice) return;
    const t = window.setTimeout(() => setAutostartNotice(false), 15_000);
    return () => window.clearTimeout(t);
  }, [autostartNotice]);
  onSessionEndRef.current = ({ trigger, connected, userSpoke }) => {
    if (trigger !== 'clap') return;
    clap.markOutcome(!connected ? 'not-started' : userSpoke ? 'spoke' : 'no-speech');
  };
  endByVoiceRef.current = ({ stopStandby }) => {
    const ok = voice.endAfterReply();
    if (ok && stopStandby) {
      // 待機を OFF に（会話中は一時停止しているので、会話が終わっても再開しない）
      wake.setOn(false);
      clap.setStandbyOn(false);
    }
    return ok;
  };

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
    recognized,
    ready: voice.ready,
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
      {desktopCtl.closed && (
        <div className="desk-closed" role="alert">
          <p>KAITO を終了しました。</p>
          <p className="muted small">このウィンドウは閉じてかまいません（デスクトップの「KAITO」アイコンでまた起動できます）。</p>
        </div>
      )}
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
        {audioBlocked ? (
          <p className="stage-notice">ブラウザの制限で待機の音声処理が止まっています。画面をクリックすると待機が始まります。</p>
        ) : autostartNotice && (wake.on || clap.standbyOn) ? (
          <p className="stage-notice">ログイン時に起動しました。待機中です（会話は呼びかけ・拍手で始まります）。</p>
        ) : (
          (clap.guardNotice ?? view.notice) && <p className="stage-notice">{clap.guardNotice ?? view.notice}</p>
        )}
      </main>
      <CommandBar
        wakeOn={wake.on}
        setWakeOn={setWakeByUser}
        clapOn={clap.standbyOn}
        setClapOn={setClapByUser}
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
          <VoicePanel vs={voiceSettings} conv={conversation} greeting={{ info: greetingInfo, voice: greetingVoice, reload: reloadGreeting }} defaultVoice={server.kind === 'up' ? server.defaultVoice : null} apiKeyConfigured={apiKeyConfigured} busy={phase !== 'idle' || triggering} />
        )}
        {drawer === 'persona' && <PersonaPanel p={persona} />}
        {drawer === 'memory' && <MemoryPanel m={memory} busy={phase !== 'idle'} />}
        {drawer === 'desktop' && <DesktopPanel d={desktopCtl} busy={phase !== 'idle'} />}
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
        {drawer === 'diag' && <InfoPanel wake={wake} clap={clap} lines={voice.lines} connected={phase === 'connected'} errors={errors} notice={voice.notice} latency={latency} onClearLatency={() => {
              setLatency([]);
              saveLatency([]);
            }} />}
      </SideDrawer>
      {calibOpen && <CalibrationModal clap={clap} onClose={() => setCalibOpen(false)} onManual={() => setDrawer('detail')} />}
    </div>
  );
}
