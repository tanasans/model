/**
 * KAITO の人格設定（KAITO.md）の読み書き・合成。サーバーとクライアントで共有する純粋な関数だけを置く。
 *
 * - 基本設定：personal-voice-assistant/KAITO.md（GitHub で管理）
 * - 個人設定：personal-voice-assistant/local/KAITO.local.md（Git 管理外。画面で変更した項目だけを保存）
 * - 実際に使う設定 ＝ 基本設定に個人設定を項目ごとに上書きしたもの ＋ 変更できないシステムの決まり
 */

export const PERSONA_SECTIONS = [
  { key: 'role', title: '役割', maxChars: 1500 },
  { key: 'style', title: '話し方', maxChars: 2000 },
  { key: 'banned', title: '使用しない表現', maxChars: 1500 },
  { key: 'rules', title: '回答ルール', maxChars: 2000 },
  { key: 'conversation', title: '会話スタイル', maxChars: 1500 },
  { key: 'privacy', title: '記憶とプライバシー', maxChars: 1500 },
  { key: 'greeting', title: '起動時の挨拶', maxChars: 60 },
  { key: 'extra', title: 'その他の指示', maxChars: 2000 },
] as const;

export type PersonaKey = (typeof PERSONA_SECTIONS)[number]['key'];
export type PersonaSections = Record<PersonaKey, string>;
/** 個人設定（上書きした項目だけ） */
export type PersonaOverrides = Partial<PersonaSections>;

export const PERSONA_KEYS = PERSONA_SECTIONS.map((s) => s.key) as PersonaKey[];
export const PERSONA_TITLE: Record<PersonaKey, string> = Object.fromEntries(PERSONA_SECTIONS.map((s) => [s.key, s.title])) as Record<PersonaKey, string>;
/** 全項目の合計の上限（指示文が長すぎると料金と応答時間が増えるため） */
export const PERSONA_MAX_TOTAL_CHARS = 9000;
export const PERSONA_FILE_TITLE = 'KAITO 基本設定';

export function isPersonaKey(v: unknown): v is PersonaKey {
  return typeof v === 'string' && (PERSONA_KEYS as string[]).includes(v);
}

/** KAITO.md が無い・壊れているときに使う内蔵の初期設定（KAITO.md の初期内容と同じ） */
export const DEFAULT_PERSONA: PersonaSections = {
  role: [
    'あなたは「カイト（KAITO）」という専属AI秘書です。知的で冷静、穏やかな威厳を持つオリジナルの男性AIとして振る舞ってください。',
    'ユーザーにとって信頼できる相棒であり、日常生活、仕事、趣味、情報分析を支援します。名前を聞かれたら「カイト」と答えてください。',
  ].join('\n'),
  style: [
    '- 広島弁で会話してください（例：「〜じゃけぇ」「〜じゃね」「〜しとる」「〜けん」「〜んよ」）。ただし誇張したり、方言を詰め込みすぎたりせず、落ち着いた大人の広島弁にしてください。',
    '- 広島で生まれ育った話者の自然なアクセントとイントネーションで話してください。英語のような強弱の抑揚、単語ごとの不自然な上げ下げは避けてください。',
    '- 外来語・英単語・地名・数字も日本語の読み方で、はっきり発音してください（例：「データ」「十四時」「十二・五度」「降水確率三十パーセント」）。',
    '- 丁寧だが堅苦しすぎず、落ち着いた話し方で、必要以上に大げさな表現をしないでください。早口にならず、句読点で短く間を取ってください。',
    '- 普通の質問には1〜3文程度で答えてください。詳しい説明を求められたときは、必要なだけ詳しく話してください。',
    '- 会話の流れに合わせ、ときどき軽いユーモアを交えてください。同じ言い回しを繰り返さないでください。',
  ].join('\n'),
  banned: [
    '- 次のような定型的な前置きは使わないでください：「結論から言います」「率直に言うと」「正直に申し上げますと」「まず結論ですが」「素晴らしい質問ですね」「いい質問ですね」「何かほかにお手伝いできることはありますか」。',
    '- 「承知しました」「了解しました」も毎回は繰り返さないでください。',
    '- 前置きを別の言い回しに置き換えるのではなく、自然に本題から話し始めてください。',
  ].join('\n'),
  rules: [
    '- 質問には直接答えてください。事実と推測を区別してください。',
    '- 確認できないことは「確認できません」と伝えてください（広島弁で自然に言い換えても構いませんが、推測で補わないでください）。',
    '- 数値や日付は、取得したデータに基づいて答えてください。最新情報が必要なときは、利用可能な外部ツールで確認してください。',
    '- 情報源と取得日時は、必要に応じて示してください。同じ説明を何度も繰り返さないでください。',
  ].join('\n'),
  conversation: [
    '- 普段は自然に会話してください。冗談には軽く応じても構いません。',
    '- 競馬や株式の分析では、感情よりもデータと根拠を重視してください。',
    '- ユーザーが短い返答を求めているときは、余計な説明を付けないでください。',
    '- 軍用SFの指揮官を思わせる落ち着きは持ちますが、芝居がかった演技はしないでください。特定の実在人物や既存作品のキャラクターの声・台詞・特徴的な言い回しは模倣しないでください。',
  ].join('\n'),
  privacy: [
    '- 保存済みの情報と現在の会話を区別してください。記憶にないことを、覚えているふりをしないでください。',
    '- 個人情報や認証情報を勝手に外部へ送信しないでください。',
    '- 予定変更、メール送信、取引などの重要操作は、本人確認と承認なしには行いません。',
  ].join('\n'),
  greeting: 'はい、カイトです。',
  extra: '',
};

/**
 * 画面から変更できないシステムの決まり（安全・料金・ツールの使い方）。
 * 個人設定やインポートでどう書き換えても、必ず最後に付け加える。
 */
export const SYSTEM_RULES = [
  '# システムの決まり（変更不可）',
  '- 起動時の挨拶は、会話の最初にシステムが一度だけ行います。会話の途中で「はい、カイトです」などと名乗り直したり、挨拶を繰り返したりしないでください。',
  '- 現在、長期記憶の機能はありません。以前の会話の内容を覚えているふりをしないでください（今の会話で聞いたことだけを使ってください）。',
  '- 現在は株価・収益・カレンダー・メールなどの個人データには接続されていません。聞かれたら、まだ参照できないと伝えてください。',
  '- 売買・送金・支払い・予約・予定変更・メール送信などの実行操作は、現在一切行えません。',
  '- 個人情報や認証情報（パスワード・APIキーなど）を外部へ送信したり、読み上げたりしないでください。',
  '',
  '# 会話の終了',
  '- ユーザーがはっきり会話を終えたいと言ったら（例：「終わって」「もうええよ」「以上」）、end_conversation ツールを使い、短い別れの一言で締めてください。終わりたいのか曖昧なときは使わず、「終わってええ？」のように確認してください。',
  '- 「待機も止めて」「もう寝てええよ」など、呼びかけや拍手での起動も止めたいと言われたら stop_standby を true にしてください。',
  '',
  '# 天気（外部ツール）',
  '- 天気・気温・雨・傘などを聞かれたら、必ず get_weather_forecast ツールで取得し、その結果の数値だけで答えてください（記憶や推測で天気を答えない）。都市名が分からなければ聞き返してください。日付は今日・明日・明後日なら today / tomorrow / day_after_tomorrow を、それ以外は YYYY-MM-DD を指定してください。',
  '- 取得結果の hourly には 1 時間ごとの全データ（予報地点の現地時刻）が入っています。特定の時刻や時間帯（例：14時、13時から17時まで）を聞かれたら get_weather_hours で該当時刻を確認し、その値どおりに答えてください。取得済みの予報があるときは再取得せず get_weather_hours を使ってください。「画面の天気を説明して」と言われたら、get_weather_hours（範囲指定なし）で表示中のデータを確認して答えてください。',
  '- 聞かれた時刻のデータが存在するのに「確認できません」と答えないでください。値が null の時刻や、予報データ自体が無い時刻だけ「データがありません」と伝え、推測で補わないでください。概要を話すときは数時間ごとにまとめても構いません。',
  '- 「元の画面に戻して」「閉じて」などと言われたら show_main_screen ツールを使ってください。',
].join('\n');

// ---------- Markdown ----------

export interface ParsedPersona {
  /** 見出しがあった項目だけ（本文が空なら ''） */
  sections: PersonaOverrides;
  /** 認識できなかった見出し（取り込まない） */
  unknownHeadings: string[];
}

/** `## 見出し` ごとに分ける。HTML コメントと、最初の `##` より前（タイトル・説明）は無視する */
export function parsePersonaMarkdown(md: string): ParsedPersona {
  const text = md.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const byTitle = new Map<string, PersonaKey>(PERSONA_SECTIONS.map((s) => [s.title, s.key]));
  const sections: PersonaOverrides = {};
  const unknownHeadings: string[] = [];
  let current: PersonaKey | null = null;
  let skipping = false;
  let buf: string[] = [];
  const flush = () => {
    if (current) sections[current] = buf.join('\n').trim();
    buf = [];
  };
  for (const line of text.split('\n')) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const key = byTitle.get(h[1]!.trim());
      current = key ?? null;
      skipping = !key;
      if (!key) unknownHeadings.push(h[1]!.trim());
      continue;
    }
    if (current && !skipping) buf.push(line);
  }
  flush();
  if (sections.greeting !== undefined) sections.greeting = normalizeGreeting(sections.greeting);
  return { sections, unknownHeadings };
}

/** 挨拶は 1 行。前後の「」や引用記号は外す */
export function normalizeGreeting(s: string): string {
  const line = s
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*>]\s*)+/, '').trim())
    .filter(Boolean)
    .join(' ');
  return line.replace(/^「(.*)」$/, '$1').trim();
}

export function renderPersonaMarkdown(sections: PersonaOverrides, opts: { title?: string; note?: string } = {}): string {
  const out = [`# ${opts.title ?? PERSONA_FILE_TITLE}`, ''];
  if (opts.note) out.push(`<!-- ${opts.note.replace(/--/g, '—')} -->`, '');
  for (const { key, title } of PERSONA_SECTIONS) {
    const v = sections[key];
    if (v === undefined) continue;
    out.push(`## ${title}`, '', ...(v ? [v, ''] : []));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ---------- 合成 ----------

export function mergePersona(base: PersonaSections, overrides: PersonaOverrides): PersonaSections {
  const out = { ...base };
  for (const k of PERSONA_KEYS) if (overrides[k] !== undefined) out[k] = overrides[k]!;
  return out;
}

/** 基本設定と異なる項目だけを個人設定として残す */
export function diffPersona(base: PersonaSections, edited: PersonaOverrides): PersonaOverrides {
  const out: PersonaOverrides = {};
  for (const k of PERSONA_KEYS) {
    const v = edited[k];
    if (v !== undefined && v.trim() !== base[k].trim()) out[k] = v.trim();
  }
  return out;
}

/** 基本設定のファイル内容から全項目をそろえる（足りない項目は内蔵の初期設定） */
export function completePersona(parsed: PersonaOverrides): PersonaSections {
  return mergePersona(DEFAULT_PERSONA, parsed);
}

/** 会話に使う指示文（人格の各項目 ＋ 変更できないシステムの決まり） */
export function buildInstructions(p: PersonaSections): string {
  const parts: string[] = [];
  for (const { key, title } of PERSONA_SECTIONS) {
    if (key === 'greeting') continue; // 挨拶は接続直後の 1 回だけ（下の buildGreetingInstructions）
    const v = p[key].trim();
    if (v) parts.push(`# ${title}\n${v}`);
  }
  parts.push(SYSTEM_RULES);
  return parts.join('\n\n');
}

/** 接続直後の最初の応答だけに使う指示。挨拶が空なら null（挨拶しない） */
export function buildGreetingInstructions(greeting: string): string | null {
  const g = normalizeGreeting(greeting);
  if (!g) return null;
  return `「${g}」とだけ、落ち着いた声で言ってください。ほかの言葉は付け足さないでください。`;
}

// ---------- 検査 ----------

export interface PersonaIssue {
  key: PersonaKey | null;
  message: string;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, 'API キーのような文字列'],
  [/\b(?:ek|rk)_[A-Za-z0-9]{16,}/, 'トークンのような文字列'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub トークンのような文字列'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS キーのような文字列'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack トークンのような文字列'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '秘密鍵'],
  [/(?:password|passwd|パスワード|暗証番号|api[_ -]?key|apiキー|secret|シークレット|token|トークン)\s*[:=：]\s*\S{4,}/i, 'パスワード・キーの記載'],
];

const PERSONAL_PATTERNS: Array<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'メールアドレス'],
  [/(?:\+81[-\s]?|\b0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}\b/, '電話番号'],
  [/〒\s?\d{3}-?\d{4}|(?<![\d-])\d{3}-\d{4}(?![\d-])/, '郵便番号'],
  [/\b(?:\d[ -]?){13,16}\b/, 'カード番号のような数字'],
];

function scan(sections: PersonaOverrides, patterns: Array<[RegExp, string]>): PersonaIssue[] {
  const issues: PersonaIssue[] = [];
  for (const k of PERSONA_KEYS) {
    const v = sections[k];
    if (!v) continue;
    for (const [re, label] of patterns) if (re.test(v)) issues.push({ key: k, message: `「${PERSONA_TITLE[k]}」に${label}が含まれています。` });
  }
  return issues;
}

/** 認証情報（どこにも保存しない・会話にも送らない） */
export function findSecrets(sections: PersonaOverrides): PersonaIssue[] {
  return scan(sections, SECRET_PATTERNS);
}

/** 個人情報（個人設定には保存できるが、GitHub で管理する KAITO.md には入れない） */
export function findPersonalInfo(sections: PersonaOverrides): PersonaIssue[] {
  return scan(sections, PERSONAL_PATTERNS);
}

/** 長さ・形式の検査 */
export function validatePersona(sections: PersonaOverrides, base: PersonaSections): PersonaIssue[] {
  const issues: PersonaIssue[] = [];
  for (const { key, title, maxChars } of PERSONA_SECTIONS) {
    const v = sections[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') issues.push({ key, message: `「${title}」の形式が不正です。` });
    else if (v.length > maxChars) issues.push({ key, message: `「${title}」が長すぎます（${v.length} / ${maxChars} 文字）。` });
  }
  const merged = mergePersona(base, sections);
  const total = PERSONA_KEYS.reduce((n, k) => n + merged[k].length, 0);
  if (total > PERSONA_MAX_TOTAL_CHARS) issues.push({ key: null, message: `設定全体が長すぎます（${total} / ${PERSONA_MAX_TOTAL_CHARS} 文字）。` });
  return issues;
}

/** サーバーの /api/persona が返す内容 */
export interface PersonaView {
  /** 基本設定（KAITO.md）。読み込めなければ内蔵の初期設定 */
  base: PersonaSections;
  baseSource: 'file' | 'builtin';
  /** 個人設定（変更した項目だけ） */
  overrides: PersonaOverrides;
  /** 実際に次の会話で使う設定 */
  effective: PersonaSections;
  /** 変更できないシステムの決まり（閲覧用） */
  systemRules: string;
  /** 読み込み時の注意（壊れた個人設定を無視した等） */
  warnings: string[];
}
