import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WakeRecognizers } from '../src/wake/voskEngine.ts';
import type { RecognizerSpec } from '../src/wake/wakePolicy.ts';

/** vosk-browser の代わり：送られた音声のかたまりを数え、処理済みの通知を手動で出す */
function fakeModel() {
  const recs: FakeRec[] = [];
  class FakeRec {
    handlers: Record<string, (m: unknown) => void> = {};
    chunks = 0;
    constructor() {
      recs.push(this);
    }
    setWords() {}
    on(ev: string, h: (m: unknown) => void) {
      this.handlers[ev] = h;
    }
    acceptWaveformFloat() {
      this.chunks++;
    }
    remove() {}
    processPartial() {
      this.handlers.partialresult?.({ event: 'partialresult', result: { partial: '' } });
    }
    processFinal(text: string) {
      this.handlers.result?.({ event: 'result', result: { text, result: [] } });
    }
  }
  return { model: { KaldiRecognizer: FakeRec } as never, recs };
}

const spec = (id: string) => ({ id, grammar: ['カイト'], accepts: 'any' }) as unknown as RecognizerSpec;

test('音声認識の遅れ: 送った音声のうち、まだ処理されていない長さ（秒）を数える', () => {
  const { model, recs } = fakeModel();
  const finals: string[] = [];
  const w = new WakeRecognizers(model, [spec('lone'), spec('nee')], (_s, f) => finals.push(f.text));
  const chunk = new Float32Array(1600); // 0.1 秒（16kHz）
  for (let i = 0; i < 30; i++) w.accept(chunk);
  assert.equal(w.backlogSec(), 3, '30 かたまり＝3 秒が未処理');
  for (let i = 0; i < 25; i++) recs[0]!.processPartial();
  for (let i = 0; i < 29; i++) recs[1]!.processPartial();
  assert.ok(Math.abs(w.backlogSec() - 0.5) < 1e-9, '遅い方の認識器（残り 5 かたまり）に合わせる');
  recs[0]!.processFinal('カイト');
  assert.deepEqual(finals, ['カイト']);
  assert.ok(Math.abs(w.backlogSec() - 0.4) < 1e-9, '確定結果も 1 かたまりの処理として数える');
  w.dispose();
  recs[0]!.processFinal('カイト');
  assert.equal(finals.length, 1, '解放後の結果は使わない');
});
