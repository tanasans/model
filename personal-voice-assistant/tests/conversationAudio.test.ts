import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { applyAudioProfile, AUDIO_PROFILES, isAudioProfileId, isSpeechSpeed, type ConversationAudio } from '../shared/conversationAudio.ts';
import { ASSISTANT_INSTRUCTIONS, GREETING_INSTRUCTIONS, GREETING_TEXT } from '../shared/assistant.ts';
import { buildRealtimeSession } from '../server/sessionConfig.ts';
import { previewVoice } from '../server/voicePreview.ts';
import {
  CONVERSATION_SETTINGS_KEY,
  DEFAULT_CONVERSATION_SETTINGS,
  loadConversationSettings,
  saveConversationSettings,
} from '../src/voice/conversationSettings.ts';

/** .env 未設定時の基本設定（従来の既定） */
const ENV_DEFAULT: ConversationAudio = {
  turnDetection: { type: 'semantic_vad', eagerness: 'medium' },
  inputNoiseReduction: null,
  interruptResponse: null,
};
const common = { model: 'gpt-realtime-2.1', instructions: 'KAITO', voice: 'marin', transcriptionModel: 'gpt-4o-mini-transcribe', effort: 'low' as const };

test('会話音声: 標準（既定）では client secret の送信内容が従来と完全に同じ', () => {
  const s = buildRealtimeSession({ ...common, audio: applyAudioProfile('standard', ENV_DEFAULT), speechSpeed: 1 });
  // 従来版（claude/kaito-weather-hourly）の issueClientSecret が送っていた内容
  assert.deepEqual(s, {
    type: 'realtime',
    model: 'gpt-realtime-2.1',
    instructions: 'KAITO',
    output_modalities: ['audio'],
    reasoning: { effort: 'low' },
    audio: {
      input: {
        transcription: { model: 'gpt-4o-mini-transcribe', language: 'ja' },
        turn_detection: { type: 'semantic_vad', eagerness: 'medium' },
      },
      output: { voice: 'marin' },
    },
  });
});

test('会話音声: 標準は .env の任意設定（server_vad・雑音低減・割り込み）をそのまま使う', () => {
  const env: ConversationAudio = {
    turnDetection: { type: 'server_vad', silenceDurationMs: 800, prefixPaddingMs: 300, threshold: 0.7 },
    inputNoiseReduction: 'near_field',
    interruptResponse: true,
  };
  assert.equal(applyAudioProfile('standard', env), env);
  const s = buildRealtimeSession({ ...common, effort: null, audio: env, speechSpeed: 1 });
  assert.deepEqual(s.audio.input, {
    transcription: { model: 'gpt-4o-mini-transcribe', language: 'ja' },
    noise_reduction: { type: 'near_field' },
    turn_detection: { type: 'server_vad', silence_duration_ms: 800, prefix_padding_ms: 300, threshold: 0.7, interrupt_response: true },
  });
  assert.equal('reasoning' in s, false);
});

test('会話音声: テレビ対策は段階ごとに 1 つずつ対策が増える', () => {
  const light = buildRealtimeSession({ ...common, audio: applyAudioProfile('tv_light', ENV_DEFAULT), speechSpeed: 1 });
  assert.deepEqual(light.audio.input.noise_reduction, { type: 'far_field' });
  assert.deepEqual(light.audio.input.turn_detection, { type: 'semantic_vad', eagerness: 'medium' }, '弱では割り込み設定は変えない');

  const strong = buildRealtimeSession({ ...common, audio: applyAudioProfile('tv_strong', ENV_DEFAULT), speechSpeed: 1 });
  assert.deepEqual(strong.audio.input.noise_reduction, { type: 'far_field' });
  assert.deepEqual(strong.audio.input.turn_detection, { type: 'semantic_vad', eagerness: 'medium', interrupt_response: false });

  // .env で server_vad を選んでいても、VAD 方式・しきい値は保ったまま重ねる
  const env: ConversationAudio = { ...ENV_DEFAULT, turnDetection: { type: 'server_vad', silenceDurationMs: 700, prefixPaddingMs: 300, threshold: 0.65 } };
  const a = applyAudioProfile('tv_strong', env);
  assert.deepEqual(a.turnDetection, env.turnDetection);
  assert.equal(a.interruptResponse, false);
  assert.equal(env.inputNoiseReduction, null, '元の設定は書き換えない');
});

test('会話音声: 話す速さは 1 なら送らず（従来どおり）、それ以外は audio.output.speed で送る', () => {
  assert.deepEqual(buildRealtimeSession({ ...common, audio: ENV_DEFAULT, speechSpeed: 1 }).audio.output, { voice: 'marin' });
  assert.deepEqual(buildRealtimeSession({ ...common, audio: ENV_DEFAULT, speechSpeed: 0.9 }).audio.output, { voice: 'marin', speed: 0.9 });
});

test('会話音声: 許可リスト以外の値は受け付けない', () => {
  for (const p of AUDIO_PROFILES) assert.ok(isAudioProfileId(p));
  for (const bad of ['', 'TV', 'unrestricted', null, 1, {}]) assert.equal(isAudioProfileId(bad), false);
  for (const s of [0.85, 0.9, 0.95, 1]) assert.ok(isSpeechSpeed(s));
  for (const bad of [0.25, 1.5, 2, '0.9', NaN, null]) assert.equal(isSpeechSpeed(bad), false);
});

/** localStorage の代わり（テスト用） */
function memoryStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

test('設定の保存と復元: 保存した値が次回起動時に復元される', () => {
  const st = memoryStore();
  assert.deepEqual(loadConversationSettings(st), DEFAULT_CONVERSATION_SETTINGS, '未保存なら既定（従来どおり）');
  saveConversationSettings({ audioProfile: 'tv_strong', speechSpeed: 0.95, localGreeting: false }, st);
  assert.deepEqual(JSON.parse(st.m.get(CONVERSATION_SETTINGS_KEY)!), { audioProfile: 'tv_strong', speechSpeed: 0.95, localGreeting: false });
  assert.deepEqual(loadConversationSettings(st), { audioProfile: 'tv_strong', speechSpeed: 0.95, localGreeting: false });
  // 以前の版で保存した設定（localGreeting なし）は既定（ON：作成済みの音声があるときだけ使う）で読み込む
  st.m.set(CONVERSATION_SETTINGS_KEY, JSON.stringify({ audioProfile: 'tv_light', speechSpeed: 1 }));
  assert.equal(loadConversationSettings(st).localGreeting, true);
});

test('設定の保存と復元: 壊れた・不正な保存データは既定に戻す', () => {
  assert.deepEqual(loadConversationSettings(memoryStore({ [CONVERSATION_SETTINGS_KEY]: '{broken' })), DEFAULT_CONVERSATION_SETTINGS);
  assert.deepEqual(
    loadConversationSettings(memoryStore({ [CONVERSATION_SETTINGS_KEY]: JSON.stringify({ audioProfile: 'xx', speechSpeed: 3 }) })),
    DEFAULT_CONVERSATION_SETTINGS,
  );
  assert.deepEqual(
    loadConversationSettings(memoryStore({ [CONVERSATION_SETTINGS_KEY]: JSON.stringify({ audioProfile: 'tv_light' }) })),
    { audioProfile: 'tv_light', speechSpeed: 1, localGreeting: true },
    '片方だけ正しければその値だけ使う',
  );
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.deepEqual(loadConversationSettings(throwing), DEFAULT_CONVERSATION_SETTINGS);
  assert.doesNotThrow(() => saveConversationSettings({ audioProfile: 'tv_light', speechSpeed: 0.9, localGreeting: true }, throwing));
  assert.deepEqual(loadConversationSettings(null), DEFAULT_CONVERSATION_SETTINGS);
});

test('試聴: 話す速さを指定すると session.update に speed が入り、1 なら送らない', async () => {
  const seen: Array<Record<string, any>> = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) =>
    ws.on('message', (raw) => {
      const ev = JSON.parse(String(raw));
      seen.push(ev);
      if (ev.type === 'response.create') {
        ws.send(JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.alloc(4800).toString('base64') }));
        ws.send(JSON.stringify({ type: 'response.done' }));
      }
    }),
  );
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  try {
    const base = { apiKey: 'sk-test', model: 'm', voice: 'cedar', text: 'テスト', instructions: 'KAITO', url };
    await previewVoice({ ...base, speed: 0.9 });
    await previewVoice(base);
    const updates = seen.filter((e) => e.type === 'session.update');
    assert.equal(updates[0]!.session.audio.output.speed, 0.9);
    assert.equal('speed' in updates[1]!.session.audio.output, false);
  } finally {
    wss.close();
  }
});

test('基本設定: 広島弁・自然なアクセント・模倣しない・起動時の挨拶', () => {
  assert.match(ASSISTANT_INSTRUCTIONS, /広島弁で会話/);
  assert.match(ASSISTANT_INSTRUCTIONS, /英語のような強弱の抑揚/);
  assert.match(ASSISTANT_INSTRUCTIONS, /模倣しないでください/);
  assert.match(ASSISTANT_INSTRUCTIONS, /会話の途中で「はい、カイトです」などと名乗り直したり/, '挨拶は最初の 1 回だけ');
  assert.equal(GREETING_TEXT, 'はい、カイトです。');
  assert.match(GREETING_INSTRUCTIONS, /はい、カイトです。」とだけ/);
});

test('基本設定: 使用しない前置きを列挙し、それを促す指示は残っていない', () => {
  for (const p of ['結論から言います', '率直に言うと', '正直に申し上げますと', 'まず結論ですが', '素晴らしい質問ですね', 'いい質問ですね', '何かほかにお手伝いできることはありますか']) {
    assert.ok(ASSISTANT_INSTRUCTIONS.includes(`「${p}」`), p);
  }
  assert.doesNotMatch(ASSISTANT_INSTRUCTIONS, /結論を先に述べ/);
  assert.match(ASSISTANT_INSTRUCTIONS, /本題から話し始め/);
});

test('基本設定: 記憶・プライバシー・重要操作のルールと、既存の天気ツールの指示を保つ', () => {
  assert.match(ASSISTANT_INSTRUCTIONS, /覚えているふりをしない/);
  assert.match(ASSISTANT_INSTRUCTIONS, /認証情報を勝手に外部へ送信しない/);
  assert.match(ASSISTANT_INSTRUCTIONS, /本人確認と承認なしには行いません/);
  assert.match(ASSISTANT_INSTRUCTIONS, /実行操作は、現在一切行えません/);
  for (const t of ['get_weather_forecast', 'get_weather_hours', 'show_main_screen', 'end_conversation', 'stop_standby', 'データがありません']) assert.ok(ASSISTANT_INSTRUCTIONS.includes(t), t);
});

/**
 * ブラウザに保存するデータの棚卸し。新しい保存項目（将来の長期記憶など）を追加するときは、
 * ここと README の「保存されるデータ」を必ず更新する（意図しない個人情報の保存を防ぐ）。
 */
const KNOWN_STORAGE_KEYS = [
  'pva.clapSettings.v1',
  'pva.clapProfile.v1',
  'pva.clapProfile.v2',
  'pva.wakeSettings.v1',
  'pva.voice.v1',
  'pva.ui.v1',
  'pva.conversation.v1',
  'pva.latency.v1',
].sort();

test('保存データの棚卸し: ブラウザに保存するキーは既知のものだけ', () => {
  const root = path.resolve(import.meta.dirname, '..', 'src');
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f)) for (const m of readFileSync(p, 'utf8').matchAll(/['"`](pva\.[A-Za-z0-9_.]+)['"`]/g)) found.add(m[1]!);
    }
  };
  walk(root);
  assert.deepEqual([...found].sort(), KNOWN_STORAGE_KEYS);
});
