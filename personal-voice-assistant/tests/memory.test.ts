import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { buildMemoryInstructions, checkSaveRequest, isSaveRequest, resolveRange, similarity } from '../shared/memory.ts';
import { SYSTEM_RULES } from '../shared/persona.ts';
import { isInsideApp, resolveDataDir } from '../server/memory/dataDir.ts';
import { DB_FILE, openMemoryStore, type MemoryStore } from '../server/memory/store.ts';
import { runMemoryTool } from '../server/memory/service.ts';
import { memoryRouter, type MemoryHolder } from '../server/memory/routes.ts';
import { defaultPersonaPaths, migrateLegacyPersona } from '../server/persona.ts';
import { TranscriptRecorder, type RecordedMessage } from '../src/memory/transcriptRecorder.ts';
import { ConversationLogger } from '../src/memory/conversationLogger.ts';
import { gateSave } from '../src/memory/memoryTools.ts';

const APP = path.resolve(import.meta.dirname, '..');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'kaito-mem-'));
async function open(dir = tmp(), now?: () => number): Promise<{ store: MemoryStore; dir: string }> {
  const r = await openMemoryStore(dir, now);
  assert.equal(r.error, null, r.error ?? '');
  return { store: r.store!, dir };
}
const NOW = new Date(2026, 10, 9, 13, 0); // 2026-11-09 13:00（ローカル時刻）
const DAY = 86_400_000;

// ---------- 保存先 ----------
test('保存先: Windows はユーザー専用の LocalAppData、ほかの OS も適切な場所、KAITO_DATA_DIR で変更可', () => {
  assert.equal(resolveDataDir({ env: { LOCALAPPDATA: 'C:\\Users\\tana\\AppData\\Local' }, platform: 'win32', homedir: 'C:\\Users\\tana' }), 'C:\\Users\\tana\\AppData\\Local\\KAITO');
  assert.equal(resolveDataDir({ env: {}, platform: 'win32', homedir: 'C:\\Users\\tana' }), 'C:\\Users\\tana\\AppData\\Local\\KAITO');
  assert.equal(resolveDataDir({ env: {}, platform: 'darwin', homedir: '/Users/t' }), '/Users/t/Library/Application Support/KAITO');
  assert.equal(resolveDataDir({ env: {}, platform: 'linux', homedir: '/home/t' }), '/home/t/.local/share/kaito');
  assert.equal(resolveDataDir({ env: { XDG_DATA_HOME: '/x/data' }, platform: 'linux', homedir: '/home/t' }), '/x/data/kaito');
  assert.equal(resolveDataDir({ env: { KAITO_DATA_DIR: '/srv/kaito' }, platform: 'win32', homedir: 'C:\\U' }), path.resolve('/srv/kaito'));
  assert.equal(isInsideApp(path.join(APP, 'data'), APP), true, 'アプリのフォルダ内なら警告する');
  assert.equal(isInsideApp('/home/t/.local/share/kaito', APP), false);
});

test('GitHub に記憶データ・バックアップ・個人設定が入らない（.gitignore）', () => {
  const ignored = (f: string) => {
    try {
      execFileSync('git', ['check-ignore', '-q', f], { cwd: APP });
      return true;
    } catch {
      return false;
    }
  };
  for (const f of ['data/kaito-memory.sqlite', 'kaito-memory.sqlite', 'kaito-memory.sqlite-wal', 'kaito-memory-backup-2026-11-09.json', 'local/KAITO.local.md']) assert.equal(ignored(f), true, f);
  assert.equal(ignored('KAITO.md'), false);
});

test('記憶の処理は OpenAI に接続しない（server/memory は openai を読み込まない）', () => {
  const dir = path.join(APP, 'server', 'memory');
  for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(path.join(dir, f), 'utf8'), /from ['"]openai['"]|api\.openai\.com/, f);
});

// ---------- 長期記憶 ----------
test('テスト1・6: 記憶を保存して閉じ、開き直しても残る（アプリを新しい ZIP に入れ替えても保存先は同じ）', async () => {
  const dir = tmp();
  const a = await open(dir);
  a.store.addMemory({ content: '次の開発は長期記憶。11月中に完成させる', category: 'decision', origin: 'voice' });
  a.store.close();
  // 別のアプリのフォルダ（新しい ZIP）から起動しても、保存先はアプリの外なので同じ
  assert.equal(resolveDataDir({ env: { KAITO_DATA_DIR: dir }, platform: process.platform, homedir: os.homedir() }), path.resolve(dir));
  const b = await open(dir);
  const found = b.store.searchMemories({ query: '開発' });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.content, '次の開発は長期記憶。11月中に完成させる');
  b.store.close();
});

test('音声の検索: 「前に決めた開発予定は？」で決定事項を見つける。関係のない言葉では見つけない', async () => {
  const { store } = await open();
  store.addMemory({ content: '次の開発は長期記憶。11月中に完成させる', category: 'decision', origin: 'voice' });
  store.addMemory({ content: '朝はコーヒー', category: 'preference', origin: 'voice' });
  const r = runMemoryTool(store, 'search_memory', { query: '開発予定', target: 'memories', category: 'decision', date_from: null, date_to: null }, { sessionId: null, now: NOW });
  assert.deepEqual((r.memories as Array<{ content: string }>).map((m) => m.content), ['次の開発は長期記憶。11月中に完成させる']);
  const none = runMemoryTool(store, 'search_memory', { query: '旅行の予約', target: 'both', category: null, date_from: null, date_to: null }, { sessionId: null, now: NOW });
  assert.equal(none.found, 0);
  assert.match(String(none.instruction), /確認できません/);
});

test('テスト5: 同じ内容・ほぼ同じ内容は重複して保存しない', async () => {
  const { store } = await open();
  const first = store.addMemory({ content: 'コーヒーはブラックが好き', category: 'preference', origin: 'voice' });
  assert.equal(first.duplicate, false);
  assert.equal(store.addMemory({ content: 'コーヒーはブラックが好き。', category: 'preference', origin: 'voice' }).duplicate, true);
  assert.equal(store.addMemory({ content: 'ｺｰﾋｰは ブラックが好き', category: 'other', origin: 'voice' }).duplicate, true, '全角半角・空白の違い');
  assert.equal(store.addMemory({ content: '紅茶はミルクティーが好き', category: 'preference', origin: 'voice' }).duplicate, false);
  assert.equal(store.counts().memories, 2);
  assert.equal(store.addMemory({ content: 'コーヒーはブラックが好きです', category: 'preference', origin: 'voice' }).duplicate, true, '語尾だけの違い');
  assert.equal(store.addMemory({ content: 'コーヒーは好き', category: 'preference', origin: 'voice' }).duplicate, false, '内容が違えば別の記憶');
  assert.equal(store.counts().memories, 3);
  assert.ok(similarity('開発予定は来月', '開発予定は来月') === 1);
});

test('テスト3: 記憶を訂正すると、検索結果と次の会話の指示に新しい内容が使われる', async () => {
  const { store } = await open();
  const m = store.addMemory({ content: '呼び方は「たなさん」', category: 'preference', origin: 'voice' }).memory;
  store.updateMemory(m.id, { content: '呼び方は「ボス」' });
  assert.deepEqual(store.searchMemories({ query: '呼び方' }).map((x) => x.content), ['呼び方は「ボス」']);
  const ins = buildMemoryInstructions({ available: true, now: NOW, preferences: store.startPreferences() });
  assert.match(ins, /呼び方は「ボス」/);
  assert.doesNotMatch(ins, /たなさん/);
});

test('テスト4: 削除した記憶は検索・会話の最初の指示・バックアップに再登場せず、内容もデータベースから消える', async () => {
  const { store, dir } = await open();
  const m = store.addMemory({ content: '好きな色は赤', category: 'preference', origin: 'voice' }).memory;
  assert.equal(store.deleteMemory(m.id), true);
  assert.equal(store.searchMemories({ query: '赤' }).length, 0);
  assert.equal(store.searchMemories({}).length, 0);
  assert.equal(store.startPreferences().length, 0);
  assert.equal(store.getMemory(m.id), null);
  assert.equal(store.exportBackup().memories.length, 0);
  const reply = runMemoryTool(store, 'search_memory', { query: '好きな色', target: 'both' }, { sessionId: null, now: NOW });
  assert.equal(reply.found, 0);
  assert.match(String(reply.instruction), /確認できません/);
  store.close();
  // ファイルの中にも内容が残らない
  const raw = readFileSync(path.join(dir, DB_FILE));
  assert.equal(raw.includes(Buffer.from('好きな色は赤')), false);
});

test('テスト2: 前日の会話履歴を日付で検索できる（確定した文字起こしだけ）', async () => {
  let t = NOW.getTime();
  const { store } = await open(tmp(), () => t);
  const y = store.startSession('wake', NOW.getTime() - DAY);
  store.putMessage(y, { itemId: 'a', seq: 1, role: 'user', text: '来週の木曜に歯医者の予約がある', status: 'final' });
  store.putMessage(y, { itemId: 'b', seq: 2, role: 'assistant', text: '了解じゃ。木曜じゃね', status: 'final' });
  store.putMessage(y, { itemId: 'c', seq: 3, role: 'user', text: null, status: 'failed' });
  const today = store.startSession('manual', NOW.getTime());
  store.putMessage(today, { itemId: 'd', seq: 1, role: 'user', text: '今日は天気がええね', status: 'final' });
  t += 1000;
  const r = runMemoryTool(store, 'search_memory', { query: '', target: 'history', date_from: 'yesterday', date_to: 'yesterday' }, { sessionId: null, now: NOW });
  const history = r.history as Array<{ text: string; speaker: string }>;
  assert.deepEqual(history.map((h) => h.text), ['来週の木曜に歯医者の予約がある', '了解じゃ。木曜じゃね'], '前日の確定した発言だけ（失敗した発言は含めない）');
  const byWord = runMemoryTool(store, 'search_memory', { query: '歯医者', target: 'history', date_from: null, date_to: null }, { sessionId: null, now: NOW });
  assert.equal((byWord.history as unknown[]).length, 1);
  assert.equal(store.getMessages(y).length, 3, '失敗した発言も「取得失敗」として記録は残る（内容は補わない）');
  assert.equal(store.getMessages(y)[2]!.text, null);
  assert.equal(store.listSessions({ query: '歯医者' }).length, 1);
});

test('音声の記憶操作: 認証情報は保存しない／健康情報は確認が必要／削除は確認が必要', async () => {
  const { store } = await open();
  const ctx = { sessionId: null, now: NOW };
  assert.equal(runMemoryTool(store, 'save_memory', { content: 'API キー: sk-abcdefghijklmnopqrstuv', category: 'other' }, ctx).ok, false);
  const health = runMemoryTool(store, 'save_memory', { content: '毎朝、血圧の薬を飲む', category: 'other', sensitive_confirmed: false }, ctx);
  assert.equal(health.ok, false);
  assert.equal(health.needs_confirmation, true);
  assert.equal(store.counts().memories, 0);
  const ok = runMemoryTool(store, 'save_memory', { content: '毎朝、血圧の薬を飲む', category: 'other', sensitive_confirmed: true }, ctx);
  assert.equal(ok.ok, true);
  assert.equal(store.searchMemories({})[0]!.sensitive, true);
  store.addMemory({ content: '朝はコーヒー', category: 'preference', origin: 'voice' });
  store.addMemory({ content: '体重の記録は週1回', category: 'preference', sensitive: true, origin: 'voice' });
  assert.deepEqual(store.startPreferences().map((x) => x.content), ['朝はコーヒー'], '機微な情報は会話の最初に渡さない');
  const id = String((store.searchMemories({ query: 'コーヒー' })[0]!).id);
  const noConfirm = runMemoryTool(store, 'delete_memory', { memory_id: id, confirmed: false }, ctx);
  assert.equal(noConfirm.ok, false);
  assert.ok(store.getMemory(id), '確認なしでは消さない');
  assert.equal(runMemoryTool(store, 'delete_memory', { memory_id: id, confirmed: true }, ctx).ok, true);
  assert.equal(store.getMemory(id), null);
  assert.equal(runMemoryTool(null, 'search_memory', { query: 'x' }, ctx).ok, false, '記憶機能が使えないときは失敗を返す');
});

test('保存の依頼の確認: 「覚えといて」は保存、「覚えとる？」は保存しない。発言のない会話（誤起動）からは保存しない', () => {
  for (const t of ['これ覚えといて', 'それ覚えとって', '覚えておいてね', 'メモしといて', '忘れんようにしといて']) assert.equal(isSaveRequest(t), true, t);
  for (const t of ['昨日のこと覚えとる？', '前に決めたこと覚えてる？', '天気を教えて']) assert.equal(isSaveRequest(t), false, t);
  assert.equal(checkSaveRequest({ userFinalCount: 0, recentUserTexts: [], explicitRequest: true }).ok, false, '誤起動の会話');
  assert.equal(checkSaveRequest({ userFinalCount: 1, recentUserTexts: ['明日は晴れ？'], explicitRequest: false }).ok, false, '頼まれていない');
  assert.equal(checkSaveRequest({ userFinalCount: 1, recentUserTexts: ['開発は来月まで、覚えといて'], explicitRequest: false }).ok, true);
  assert.equal(checkSaveRequest({ userFinalCount: 1, recentUserTexts: ['（文字起こし失敗）'], explicitRequest: true }).ok, true, '確認して了承を得た場合');
  assert.equal(gateSave({ current: () => null }, true).ok, false, '会話の外からは保存しない');
});

test('日付: 昨日・今日・YYYY-MM-DD を範囲に直す', () => {
  const r = resolveRange('yesterday', 'yesterday', NOW);
  assert.equal(r.from, new Date(2026, 10, 8).getTime());
  assert.equal(r.to, new Date(2026, 10, 9).getTime());
  assert.equal(resolveRange('2026-02-30', null, NOW).from, null, '存在しない日付は不正');
});

test('会話の指示: 現在の日時・記憶の使い方・好み（上限あり）だけを渡し、システムの決まりと矛盾しない', () => {
  const prefs = Array.from({ length: 9 }, (_, i) => ({ content: `好み${i + 1}` }));
  const ins = buildMemoryInstructions({ available: true, now: NOW, preferences: prefs });
  assert.match(ins, /2026-11-09（月）13:00/);
  assert.match(ins, /search_memory/);
  assert.match(ins, /覚えているふりをしないでください/);
  assert.equal((ins.match(/^- 好み/gm) ?? []).length, 5, '好みは最大 5 件');
  assert.match(buildMemoryInstructions({ available: false, now: NOW, preferences: [] }), /記憶機能は使えません/);
  assert.doesNotMatch(SYSTEM_RULES, /長期記憶の機能はありません/);
});

// ---------- 異常系 ----------
test('壊れたデータベースは別名で残して作り直す（上書き・削除しない）', async () => {
  const dir = tmp();
  writeFileSync(path.join(dir, DB_FILE), 'これは SQLite ではない壊れたファイル'.repeat(50));
  const r = await openMemoryStore(dir);
  assert.equal(r.error, null);
  assert.ok(r.warnings.some((w) => /壊れていた/.test(w)));
  const kept = readdirSync(dir).filter((f) => f.startsWith('kaito-memory.corrupt-'));
  assert.equal(kept.length, 1);
  assert.match(readFileSync(path.join(dir, kept[0]!), 'utf8'), /壊れたファイル/);
  r.store!.addMemory({ content: '新しい記憶', category: 'other', origin: 'manual' });
  assert.equal(r.store!.counts().memories, 1);
});

test('新しい版のデータ形式なら記憶機能を無効にし、ファイルを変更しない', async () => {
  const dir = tmp();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, DB_FILE));
  db.exec('PRAGMA user_version = 99');
  db.close();
  const before = readFileSync(path.join(dir, DB_FILE));
  const r = await openMemoryStore(dir);
  assert.equal(r.store, null);
  assert.match(r.error ?? '', /新しい版/);
  assert.deepEqual(readFileSync(path.join(dir, DB_FILE)), before);
});

test('保存先に書き込めないときは記憶機能だけ無効にして理由を返す', async () => {
  const dir = tmp();
  const file = path.join(dir, 'not-a-dir');
  writeFileSync(file, 'x');
  const r = await openMemoryStore(path.join(file, 'kaito'));
  assert.equal(r.store, null);
  assert.ok(r.error);
});

// ---------- バックアップ・復元 ----------
test('バックアップと復元: 追加は重複させない、入れ替えは前の内容を自動で書き出す、壊れたファイルは拒否', async () => {
  const a = await open();
  a.store.addMemory({ content: '開発の次の段階は長期記憶', category: 'decision', origin: 'voice' });
  const sid = a.store.startSession('manual', NOW.getTime());
  a.store.putMessage(sid, { itemId: 'x', seq: 1, role: 'user', text: '覚えといて', status: 'final' });
  const backup = JSON.parse(JSON.stringify(a.store.exportBackup()));
  assert.equal(backup.format, 'kaito-memory-backup');

  const b = await open();
  b.store.addMemory({ content: '朝はコーヒー', category: 'preference', origin: 'voice' });
  assert.deepEqual(b.store.restoreBackup(backup, 'merge'), { memories: 1, sessions: 1, skipped: 0 });
  assert.deepEqual(b.store.restoreBackup(backup, 'merge'), { memories: 0, sessions: 0, skipped: 2 }, '2 回復元しても増えない');
  assert.equal(b.store.counts().memories, 2);

  const snap = b.store.snapshot(path.join(b.dir, 'backups'), 'before-restore');
  b.store.restoreBackup(backup, 'replace');
  assert.equal(b.store.counts().memories, 1);
  assert.ok(existsSync(snap));
  assert.equal(JSON.parse(readFileSync(snap, 'utf8')).memories.length, 2);
  assert.throws(() => b.store.restoreBackup({ format: 'other' }, 'merge'), /形式/);
  assert.throws(() => b.store.restoreBackup({ ...backup, memories: [{ id: 'x' }] }, 'merge'), /形式/);
});

// ---------- API（ローカルサーバー） ----------
async function withServer(holder: MemoryHolder, fn: (base: string) => Promise<void>) {
  const app = express();
  app.use('/api/memory', memoryRouter(holder, (_q, _s, n) => n(), () => {}));
  const srv = createServer(app);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/memory`;
  try {
    await fn(base);
  } finally {
    srv.close();
  }
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('API: 会話履歴の保存を OFF にすると会話を記録しない。状態に保存先が表示される', async () => {
  const { store, dir } = await open();
  const holder: MemoryHolder = { store, error: null, warnings: [], dataDir: dir, dbPath: path.join(dir, DB_FILE) };
  await withServer(holder, async (base) => {
    const st = await (await fetch(`${base}/status`)).json();
    assert.equal(st.available, true);
    assert.equal(st.dbPath, path.join(dir, DB_FILE));
    assert.equal(st.settings.historyEnabled, true, '既定は保存する');
    const on = await (await post(`${base}/sessions`, { trigger: 'clap' })).json();
    assert.ok(on.id);
    assert.equal((await post(`${base}/sessions/${on.id}/messages`, { itemId: 'i1', seq: 1, role: 'user', text: 'テスト', status: 'final' })).status, 204);
    await fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ historyEnabled: false }) });
    const off = await (await post(`${base}/sessions`, { trigger: 'clap' })).json();
    assert.equal(off.id, null);
    await post(`${base}/sessions/${on.id}/messages`, { itemId: 'i2', seq: 2, role: 'user', text: 'OFF 後の発言', status: 'final' });
    assert.equal(store.getMessages(on.id).length, 1, 'OFF にした後の発言は保存しない');
    assert.equal((await post(`${base}/sessions/${on.id}/messages`, { itemId: 'x', seq: 'a', role: 'x' })).status, 400);
    assert.equal((await post(`${base}/memories/delete-all`, {})).status, 400, '全件削除には確認が必要');
  });
  await withServer({ store: null, error: 'Node.js が古い', warnings: [], dataDir: dir, dbPath: '' }, async (base) => {
    assert.equal((await fetch(`${base}/memories`)).status, 503);
    const t = await (await post(`${base}/tool/search_memory`, { args: { query: 'x' } })).json();
    assert.equal(t.ok, false);
  });
});

// ---------- 文字起こし ----------
test('文字起こし: 途中経過は保存せず、確定・失敗・中断を区別する。順番は会話に追加された順', () => {
  const out: RecordedMessage[] = [];
  const r = new TranscriptRecorder((m) => out.push(m));
  r.handle({ type: 'conversation.item.added', item: { id: 'a1', type: 'message', role: 'assistant' } });
  r.handle({ type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'はい、' });
  assert.equal(out.length, 0, '途中経過は記録しない');
  r.handle({ type: 'response.output_audio_transcript.done', item_id: 'a1', transcript: 'はい、カイトです。' });
  r.handle({ type: 'conversation.item.added', item: { id: 'u1', type: 'message', role: 'user' } });
  r.handle({ type: 'conversation.item.added', item: { id: 'f1', type: 'function_call' } });
  r.handle({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'u1', delta: '明日の' });
  r.handle({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '明日の広島の天気は？' });
  r.handle({ type: 'conversation.item.added', item: { id: 'u2', type: 'message', role: 'user' } });
  r.handle({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'u2', error: { message: 'x' } });
  r.handle({ type: 'conversation.item.added', item: { id: 'a2', type: 'message', role: 'assistant' } });
  r.handle({ type: 'response.output_audio_transcript.done', item_id: 'a2', transcript: '明日は晴れじゃけぇ、傘は' });
  r.handle({ type: 'conversation.item.truncated', item_id: 'a2', audio_end_ms: 900 });
  r.handle({ type: 'conversation.item.added', item: { id: 'u3', type: 'message', role: 'user' } });
  r.handle({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u3', transcript: '   ' });
  const last = new Map(out.map((m) => [m.itemId, m]));
  assert.deepEqual([...last.values()].map((m) => [m.seq, m.role, m.status, m.text]), [
    [1, 'assistant', 'final', 'はい、カイトです。'],
    [2, 'user', 'final', '明日の広島の天気は？'],
    [3, 'user', 'failed', null],
    [4, 'assistant', 'interrupted', '明日は晴れじゃけぇ、傘は'],
    [5, 'user', 'failed', null],
  ]);
  assert.equal(r.userFinalCount, 1);
  assert.deepEqual(r.recentUserTexts(), ['明日の広島の天気は？']);
});

test('誤起動: ユーザーの発言がない会話（挨拶だけ）は保存しない。発言があれば挨拶も順番どおり保存', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === '/api/memory/sessions') return new Response(JSON.stringify({ id: 's1' }), { status: 200 });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const misfire = new ConversationLogger('clap', NOW.getTime(), fake);
  misfire.handleEvent({ type: 'response.output_audio_transcript.done', item_id: 'g', transcript: 'はい、カイトです。' });
  await misfire.end();
  assert.equal(calls.length, 0, '誤起動の会話はサーバーに何も送らない');

  const real = new ConversationLogger('wake', NOW.getTime(), fake);
  real.handleEvent({ type: 'conversation.item.added', item: { id: 'g', type: 'message', role: 'assistant' } });
  real.handleEvent({ type: 'response.output_audio_transcript.done', item_id: 'g', transcript: 'はい、カイトです。' });
  real.handleEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: '予定を覚えといて' });
  real.handleEvent({ type: 'response.output_audio_transcript.done', item_id: 'a', transcript: '覚えたけぇね' });
  await real.end();
  assert.deepEqual(calls.map((c) => c.url), ['/api/memory/sessions', '/api/memory/sessions/s1/messages', '/api/memory/sessions/s1/messages', '/api/memory/sessions/s1/messages', '/api/memory/sessions/s1/end']);
  assert.deepEqual(calls.slice(1, 4).map((c) => (c.body as RecordedMessage).text), ['はい、カイトです。', '予定を覚えといて', '覚えたけぇね']);
  assert.equal(real.sessionId, 's1');
});

// ---------- 個人設定の保存先 ----------
test('個人設定もユーザー専用フォルダへ。以前の local/KAITO.local.md は上書きせずに引き継ぐ', () => {
  const app = tmp();
  const data = tmp();
  mkdirSync(path.join(app, 'local'));
  writeFileSync(path.join(app, 'local', 'KAITO.local.md'), '## その他の指示\n\n旧設定\n');
  const p = defaultPersonaPaths(app, data);
  assert.equal(p.local, path.join(data, 'KAITO.local.md'));
  assert.equal(migrateLegacyPersona(app, p), true);
  assert.match(readFileSync(p.local, 'utf8'), /旧設定/);
  assert.ok(existsSync(path.join(app, 'local', 'KAITO.local.md')), '元のファイルは消さない');
  writeFileSync(p.local, '## その他の指示\n\n新設定\n');
  assert.equal(migrateLegacyPersona(app, p), false, '新しい場所にあれば上書きしない');
  assert.match(readFileSync(p.local, 'utf8'), /新設定/);
});
