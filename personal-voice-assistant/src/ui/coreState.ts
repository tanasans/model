import type { StandbyStatus } from '../clap/useClapStandby';
import type { Phase } from '../useVoiceSession';
import type { WakeStatus } from '../wake/useWakeStandby';

/**
 * 中央の AI コアの表示を、実際の各機能の状態だけから決める（推測・偽装はしない）。
 * 起動方法の説明文は出さない。出すのは状態と、動作上必要な短い通知（拍手 1 回目・エラー）だけ。
 */
export type CoreState = 'STANDBY' | 'LISTENING' | 'ACTIVE' | 'ERROR';

export interface CoreInputs {
  phase: Phase;
  triggering: boolean;
  server: 'checking' | 'down' | 'up';
  apiKeyConfigured: boolean | null;
  voiceError: string | null;
  wake: { on: boolean; status: WakeStatus; error: string | null };
  clap: { on: boolean; status: StandbyStatus; error: string | null };
}

export interface CoreView {
  state: CoreState;
  /** コア内の短い状態語（無ければ空） */
  sub: string;
  /** コアの下の短い通知（エラー時など。通常は null） */
  notice: string | null;
  /** 接続処理中（外周を小さな光が移動） */
  connecting: boolean;
}

const PHASE_SUB: Record<Phase, string> = {
  idle: '',
  'requesting-mic': '接続準備',
  'fetching-token': '接続準備',
  connecting: '接続中',
  connected: '会話中',
  stopping: '終了処理',
};

export function deriveCoreView(i: CoreInputs): CoreView {
  if (i.triggering || i.phase !== 'idle') {
    return {
      state: 'ACTIVE',
      sub: i.triggering && i.phase === 'idle' ? '起動' : PHASE_SUB[i.phase],
      notice: null,
      connecting: i.phase !== 'connected' && i.phase !== 'stopping',
    };
  }

  const wakeErr = i.wake.on && (i.wake.status === 'error' || i.wake.status === 'not-installed');
  const clapErr = i.clap.on && i.clap.status === 'error';
  if (i.server === 'down') return err('サーバー未接続', 'ローカルサーバーに接続できません（npm run dev）');
  if (wakeErr) {
    return i.wake.status === 'not-installed'
      ? err('認識モデル未設置', 'npm run setup:wake を実行してください')
      : err('音声待機エラー', short(i.wake.error) ?? '音声待機を開始できません');
  }
  if (clapErr) return err('拍手待機エラー', short(i.clap.error) ?? '拍手待機を開始できません');
  if (i.voiceError) return err('接続できません', short(i.voiceError));

  const wakeListening = i.wake.on && i.wake.status === 'listening';
  const clapListening = i.clap.on && (i.clap.status === 'listening' || i.clap.status === 'first-clap');
  if (wakeListening || clapListening) {
    return { state: 'LISTENING', sub: i.clap.status === 'first-clap' ? '拍手 1' : '', notice: null, connecting: false };
  }

  const loading = i.wake.on && (i.wake.status === 'checking' || i.wake.status === 'loading');
  const starting = i.clap.on && i.clap.status === 'starting';
  return {
    state: 'STANDBY',
    sub: loading ? 'モデル読込' : starting ? '準備中' : '',
    notice: i.apiKeyConfigured === false ? 'APIキー未設定' : null,
    connecting: false,
  };
}

function err(sub: string, notice: string | null): CoreView {
  return { state: 'ERROR', sub, notice, connecting: false };
}

/** 長いエラー文は最初の文だけにする */
function short(s: string | null): string | null {
  if (!s) return null;
  const first = s.split(/[。\n]/)[0] ?? s;
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}
