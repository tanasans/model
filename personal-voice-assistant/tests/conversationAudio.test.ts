import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { applyAudioProfile, AUDIO_PROFILES, isAudioProfileId, isSpeechSpeed, type ConversationAudio } from '../shared/conversationAudio.ts';
import { ASSISTANT_INSTRUCTIONS } from '../shared/assistant.ts';
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
  saveConversationSettings({ audioProfile: 'tv_strong', speechSpeed: 0.95 }, st);
  assert.deepEqual(JSON.parse(st.m.get(CONVERSATION_SETTINGS_KEY)!), { audioProfile: 'tv_strong', speechSpeed: 0.95 });
  assert.deepEqual(loadConversationSettings(st), { audioProfile: 'tv_strong', speechSpeed: 0.95 });
});

test('設定の保存と復元: 壊れた・不正な保存データは既定に戻す', () => {
  assert.deepEqual(loadConversationSettings(memoryStore({ [CONVERSATION_SETTINGS_KEY]: '{broken' })), DEFAULT_CONVERSATION_SETTINGS);
  assert.deepEqual(
    loadConversationSettings(memoryStore({ [CONVERSATION_SETTINGS_KEY]: JSON.stringify({ audioProfile: 'xx', speechSpeed: 3 }) })),
    DEFAULT_CONVERSATION_SETTINGS,
  );
  assert.deepEqual(
    loadConversationSettings(memoryStore({ [CONVERSATION_SETTINGS_KEY]: JSON.stringify({ audioProfile: 'tv_light' }) })),
    { audioProfile: 'tv_light', speechSpeed: 1 },
    '片方だけ正しければその値だけ使う',
  );
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.deepEqual(loadConversationSettings(throwing), DEFAULT_CONVERSATION_SETTINGS);
  assert.doesNotThrow(() => saveConversationSettings({ audioProfile: 'tv_light', speechSpeed: 0.9 }, throwing));
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

test('話し方の指示: 標準語の自然なアクセントを明示し、特定人物の模倣はしない', () => {
  assert.match(ASSISTANT_INSTRUCTIONS, /標準語/);
  assert.match(ASSISTANT_INSTRUCTIONS, /文末は自然に下げ/);
  assert.match(ASSISTANT_INSTRUCTIONS, /模倣するのではなく/);
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
