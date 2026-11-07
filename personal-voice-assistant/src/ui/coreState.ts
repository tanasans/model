import type { StandbyStatus } from '../clap/useClapStandby';
import type { Phase } from '../useVoiceSession';
import type { WakeStatus } from '../wake/useWakeStandby';
import type { WakePhraseMode } from '../wake/wakePolicy';

/**
 * 中央の AI コアに表示する状態を、実際の各機能の状態だけから決める（画面の見た目のための推測・偽装はしない）。
 */
export type CoreState = 'STANDBY' | 'LISTENING' | 'ACTIVE' | 'ERROR';

export interface CoreInputs {
  phase: Phase;
  /** 起動音を鳴らして接続を始めるまでの間 */
  triggering: boolean;
  server: 'checking' | 'down' | 'up';
  apiKeyConfigured: boolean | null;
  voiceError: string | null;
  testMode: boolean;
  wake: { on: boolean; status: WakeStatus; error: string | null; mode: WakePhraseMode };
  clap: { on: boolean; status: StandbyStatus; error: string | null };
}

export interface CoreView {
  state: CoreState;
  /** コア中央の小さな日本語表示 */
  sub: string;
  /** コアの下の説明文 */
  hint: string;
}

const PHASE_SUB: Record<Phase, string> = {
  idle: '',
  'requesting-mic': 'マイクを準備中',
  'fetching-token': '接続準備中',
  connecting: 'OpenAI に接続中',
  connected: '会話中',
  stopping: '終了処理中',
};

export function wakePhraseText(mode: WakePhraseMode): string {
  if (mode === 'nee') return '『ねえ、カイト』';
  if (mode === 'kaito') return '『カイト』';
  return '『ねえ、カイト』（または『カイト』）';
}

export function deriveCoreView(i: CoreInputs): CoreView {
  // 1. 会話中・接続処理中
  if (i.triggering || i.phase !== 'idle') {
    return {
      state: 'ACTIVE',
      sub: i.triggering && i.phase === 'idle' ? '起動中' : PHASE_SUB[i.phase],
      hint: i.phase === 'connected' ? '会話中です。話しかけてください。終わったら「会話終了」を押してください。' : '会話を開始しています…',
    };
  }

  // 2. エラー（落ち着いた警告表示にする。点滅はしない）
  const wakeErr = i.wake.on && (i.wake.status === 'error' || i.wake.status === 'not-installed');
  const clapErr = i.clap.on && i.clap.status === 'error';
  if (i.server === 'down' || wakeErr || clapErr || i.voiceError) {
    let sub = '会話を開始できませんでした';
    let hint = i.voiceError ?? '';
    if (i.server === 'down') {
      sub = 'サーバー未接続';
      hint = 'ローカルサーバーに接続できません。PowerShell で npm run dev が動いているか確認してください。';
    } else if (wakeErr) {
      sub = i.wake.status === 'not-installed' ? '音声認識モデル未設置' : '音声待機エラー';
      hint =
        i.wake.status === 'not-installed'
          ? '音声待機には認識モデルが必要です。PowerShell で npm run setup:wake を実行し、ページを再読み込みしてください。'
          : (i.wake.error ?? '音声待機を開始できませんでした。');
    } else if (clapErr) {
      sub = '拍手待機エラー';
      hint = i.clap.error ?? '拍手待機を開始できませんでした。';
    }
    return { state: 'ERROR', sub, hint };
  }

  // 3. 待機（実際にマイクで聞いている間だけ LISTENING）
  const wakeListening = i.wake.on && i.wake.status === 'listening';
  const clapListening = i.clap.on && (i.clap.status === 'listening' || i.clap.status === 'first-clap');
  if (wakeListening || clapListening) {
    const ways = [wakeListening ? wakePhraseText(i.wake.mode) : null, clapListening ? '拍手2回' : null].filter(Boolean);
    const sub = i.clap.status === 'first-clap' ? '1回目の拍手を検知' : i.testMode ? 'テストモード' : '待機中';
    const hint =
      `${ways.join('または')}で起動します` +
      (i.testMode ? '（テストモード：会話は始めず、検知回数だけ数えます）' : '');
    return { state: 'LISTENING', sub, hint };
  }

  // 4. 何も聞いていない
  const preparing = (i.wake.on && (i.wake.status === 'checking' || i.wake.status === 'loading')) || (i.clap.on && i.clap.status === 'starting');
  return {
    state: 'STANDBY',
    sub: preparing ? (i.wake.status === 'loading' ? '音声認識モデル読込中' : '準備中') : '待機 OFF',
    hint: preparing
      ? 'まもなく待機を開始します…'
      : i.apiKeyConfigured === false
        ? 'APIキーが未設定のため会話は開始できません（.env を設定してサーバーを再起動してください）。'
        : '下の「音声待機」「拍手待機」を ON にすると、呼びかけや拍手で起動します。「会話開始」でもすぐ始められます。',
  };
}
