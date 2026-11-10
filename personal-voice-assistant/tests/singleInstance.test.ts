import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acquireUi, takeOverUi, UI_LOCK_NAME } from '../src/desktop/singleInstance.js';

/** Web Locks の簡易版（同じ名前のロックは 1 つだけ。steal で奪うと元の持ち主の request が失敗する） */
function fakeLocks() {
  let holder: { reject: (e: Error) => void } | null = null;
  return {
    request(name: string, opts: { ifAvailable?: boolean; steal?: boolean }, cb: (lock: unknown) => Promise<unknown>) {
      assert.equal(name, UI_LOCK_NAME);
      return new Promise((_res, reject) => {
        if (holder && opts.ifAvailable) {
          void cb(null).then(_res);
          return;
        }
        if (holder && opts.steal) holder.reject(new Error('AbortError'));
        holder = { reject };
        void cb({ name });
      });
    },
  };
}

test('二重起動の防止：最初の画面だけが動き、2 つ目は「すでに起動しています」', async () => {
  const locks = fakeLocks();
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true });
  let lost1 = 0;
  assert.equal(await acquireUi(() => lost1++), 'owner');
  assert.equal(await acquireUi(() => undefined), 'busy');
  assert.equal(await acquireUi(() => undefined), 'busy');
  // 「こちらで使う」：先の画面は止まる
  await takeOverUi(() => undefined);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lost1, 1);
});

test('二重起動の防止：Web Locks が無いブラウザでは従来どおり動く', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  assert.equal(await acquireUi(() => undefined), 'owner');
});

test('2 つ目の画面は App（待機・マイク）を読み込まない', () => {
  const src = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(src, /r === 'owner' \? renderApp\(\) : renderBusy\(\)/);
});

test('styles.css の括弧が閉じている（閉じ忘れで後ろの見た目が効かなくなるのを防ぐ）', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    assert.ok(depth >= 0);
  }
  assert.equal(depth, 0);
});
