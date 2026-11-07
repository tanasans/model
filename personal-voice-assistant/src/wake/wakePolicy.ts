/**
 * ウェイクワード（「カイト」「ねえ、カイト」）の判定ロジック。ブラウザ内で完結し、外部送信はしない。
 *
 * 音声認識（Vosk、端末内）が返す「確定結果」に対して、次の条件をすべて満たすときだけ起動する。
 *  1. 言葉     : 認識結果の先頭が「カイト」（または「ねえ カイト」）。文の途中のカイトは対象外
 *  2. 信頼度   : 認識エンジンの信頼度が基準以上
 *  3. 長さ     : 「カイト」の長さが自然な範囲（0.18〜1.0 秒）
 *  4. 前の静けさ: 呼びかけの直前（0.1〜0.45 秒前）が静か（会話・テレビの途中ではない）
 *  5. 後の静けさ: 呼びかけの直後（0.15〜0.55 秒後）が静か（「カイトが…」と文が続かない）
 *  6. 続く言葉 : 同じ確定結果の中で後ろに別の言葉が続かない
 * 合成音声＋本物の認識エンジンでの評価では、4〜6 によりテレビ風の連続音声・文中のカイトによる誤起動が 0 回になった。
 * 確定結果のみを使う（途中結果は誤起動が多いという他プロジェクトの実測があるため）。
 */

export type WakePhraseMode = 'kaito' | 'nee' | 'both';

export const WAKE_WORD = 'カイト';
export const NEE = 'ねえ';

/** 「ねえ、カイト」用：似た言葉を候補に入れて、誤認識を似た言葉側に吸収させる */
export const DECOY_WORDS = ['ライト', 'バイト', 'ナイト', 'サイト', 'タイト', 'ファイト', '回答', '外套', 'カイロ', '会社', '怪盗'];

export interface RecognizerSpec {
  id: 'lone' | 'nee';
  /** Vosk の文法（この語句と [unk] 以外は認識しない） */
  grammar: string[];
  /** この認識器で受け付ける呼びかけ */
  accepts: 'lone' | 'nee' | 'any';
}

/**
 * モードごとの認識器。
 * - 「カイト」単独は、似た言葉を候補に入れると取りこぼしが大きく増えた（評価で 33→10/90）ため入れない。
 * - 「ねえ、カイト」は似た言葉を入れると誤検出が 11→1/162 に減り、取りこぼしはほぼ変わらないため入れる。
 */
export function recognizersFor(mode: WakePhraseMode): RecognizerSpec[] {
  const lone: RecognizerSpec = { id: 'lone', grammar: [WAKE_WORD, `${NEE} ${WAKE_WORD}`, '[unk]'], accepts: 'any' };
  const nee: RecognizerSpec = { id: 'nee', grammar: [WAKE_WORD, `${NEE} ${WAKE_WORD}`, ...DECOY_WORDS, '[unk]'], accepts: 'nee' };
  if (mode === 'kaito') return [lone];
  if (mode === 'nee') return [nee];
  return [{ ...lone, accepts: 'lone' }, nee];
}

export interface VoskWord {
  word: string;
  conf: number;
  start: number;
  end: number;
}
export interface VoskFinal {
  text: string;
  result?: VoskWord[];
}

/** 音量の履歴（認識器に渡した音声と同じ時間軸、秒） */
export interface LevelProbe {
  /** 区間 [t0, t1) の最大レベル（dBFS）。区間にデータが無ければ null */
  maxDb(t0: number, t1: number): number | null;
  /** 周囲の騒音レベル（dBFS） */
  floorDb(): number;
}

export interface WakeThresholds {
  minConf: number;
  quietDb: number;
  maxTrailing: number;
  minDur: number;
  maxDur: number;
}

/** 感度 1（厳しい）〜 10（敏感）。既定 5 */
export function wakeThresholds(sensitivity: number): WakeThresholds {
  const s = Math.min(10, Math.max(1, Math.round(sensitivity)));
  return {
    minConf: round2(Math.min(0.9, Math.max(0.3, 0.85 - (s - 1) * 0.055))),
    quietDb: 10 + (s - 1),
    maxTrailing: s >= 9 ? 1 : 0,
    minDur: 0.18,
    maxDur: 1.0,
  };
}

export interface WakeCheck {
  key: 'position' | 'conf' | 'duration' | 'before' | 'after' | 'trailing';
  label: string;
  pass: boolean;
  detail: string;
}

export interface WakeDecision {
  accepted: boolean;
  phrase: 'lone' | 'nee';
  /** 認識された文字列（画面表示用。保存・送信はしない） */
  text: string;
  /** 呼びかけの開始・終了（認識器の時間軸、秒） */
  start: number;
  end: number;
  checks: WakeCheck[];
  reason?: string;
}

const FAIL_TEXT: Record<WakeCheck['key'], string> = {
  position: '文の途中の「カイト」（会話・テレビなど）',
  conf: '認識の信頼度が低い（似た言葉の可能性）',
  duration: '長さが不自然',
  before: '直前に別の声・音があった（会話・テレビの途中）',
  after: '直後に声・音が続いた（「カイトが…」など文の一部）',
  trailing: '後ろに別の言葉が続いた',
};

/**
 * 確定結果 1 つを判定する。呼びかけの言葉が含まれていなければ null。
 */
export function evaluateFinal(
  final: VoskFinal,
  spec: RecognizerSpec,
  probe: LevelProbe,
  sensitivity: number,
): WakeDecision | null {
  const tokens = final.text.split(/\s+/).filter(Boolean);
  const idx = tokens.indexOf(WAKE_WORD);
  if (idx < 0) return null;
  const words = final.result ?? [];
  const w = words.find((x) => x.word === WAKE_WORD);
  if (!w) return null;
  const before = tokens.slice(0, idx);
  const hasNee = before.length > 0 && before[before.length - 1] === NEE;
  const phrase: 'lone' | 'nee' = hasNee ? 'nee' : 'lone';
  if (spec.accepts !== 'any' && spec.accepts !== phrase) return null;

  const th = wakeThresholds(sensitivity);
  const nee = hasNee ? [...words].reverse().find((x) => x.word === NEE && x.end <= w.start + 0.05) : undefined;
  const start = nee ? nee.start : w.start;
  const end = w.end;
  const floor = probe.floorDb();
  const pre = probe.maxDb(start - 0.45, start - 0.1);
  const post = probe.maxDb(end + 0.15, end + 0.55);
  const trailing = tokens.length - idx - 1;
  const dur = w.end - w.start;
  const fmt = (v: number | null) => (v === null ? '—' : `${Math.round(v)}dB`);

  const checks: WakeCheck[] = [
    {
      key: 'position',
      label: '言葉の位置',
      pass: before.every((t) => t === NEE),
      detail: before.length ? `前に「${before.map((t) => (t === '[unk]' ? '…' : t)).join(' ')}」` : '先頭',
    },
    { key: 'conf', label: '信頼度', pass: w.conf >= th.minConf, detail: `${w.conf.toFixed(2)}（基準 ≥ ${th.minConf}）` },
    {
      key: 'duration',
      label: '長さ',
      pass: dur >= th.minDur && dur <= th.maxDur,
      detail: `${dur.toFixed(2)}秒`,
    },
    {
      key: 'before',
      label: '前の静けさ',
      pass: pre === null || pre < floor + th.quietDb,
      detail: `${fmt(pre)}（基準 < ${Math.round(floor + th.quietDb)}dB）`,
    },
    {
      key: 'after',
      label: '後の静けさ',
      pass: post === null || post < floor + th.quietDb,
      detail: `${fmt(post)}（基準 < ${Math.round(floor + th.quietDb)}dB）`,
    },
    { key: 'trailing', label: '続く言葉', pass: trailing <= th.maxTrailing, detail: trailing ? `${trailing}語` : 'なし' },
  ];
  const failed = checks.filter((c) => !c.pass);
  return {
    accepted: failed.length === 0,
    phrase,
    text: final.text,
    start,
    end,
    checks,
    reason: failed.length ? failed.map((c) => FAIL_TEXT[c.key]).join('／') : undefined,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 「両方」モードで感度を厳しめ（1〜3）にしたときの追加確認。
 * 似た言葉を候補に持つ認識器が、同じ時間に「バイト」「ライト」などと聞き取っていたら、単独の「カイト」は採用しない。
 * 評価では似た言葉・テレビの誤起動が 0 回になった一方、騒がしい部屋での単独「カイト」の検出が大きく減ったため、厳しめの設定でのみ使う。
 */
export const DECOY_VETO_MAX_SENSITIVITY = 3;

export function decoyVeto(d: WakeDecision, decoyWords: VoskWord[]): string | null {
  for (const w of decoyWords) {
    if (DECOY_WORDS.includes(w.word) && w.start < d.end + 0.2 && w.end > d.start - 0.2) return w.word;
  }
  return null;
}
