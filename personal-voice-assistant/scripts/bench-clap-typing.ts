/**
 * 拍手検出の誤起動ベンチマーク（合成音。実機の音ではありません）。
 *   npm run bench:clap            … タイピング各 30 分 × キーボード音量 3 段階 × 感度 5/7、拍手 2 回 200 試行
 * 実機の確認は README「拍手：キーボードの誤起動対策」の手順で行ってください。
 */
import { ClapDetector } from '../src/clap/clapDetector.ts';
import { SR, Track, dbToAmp, rng } from '../tests/synth.ts';

function doubles(tr: Track, sens: number, maxI: number): number {
  const d = new ClapDetector({ sampleRate: SR, sensitivity: sens, maxIntervalMs: maxI });
  let n = 0;
  for (let i = 0; i < tr.data.length; i += 2048) for (const e of d.process(tr.data.subarray(i, i + 2048))) if (e.type === 'double-clap') n++;
  return n;
}

const minutes = Number(process.argv[2] ?? 30);
for (const [sens, maxI] of [[5, 600], [7, 500]] as const) {
  for (const peak of [0.1, 0.2, 0.4]) {
    let real = 0, words = 0, extreme = 0;
    for (let m = 0; m < minutes; m++) {
      real += doubles(new Track(61, -55, m + 1).typingReal(500, 60, peak, m + 101), sens, maxI);
      words += doubles(new Track(61, -55, m + 2).typingWords(500, 60, peak, m + 201), sens, maxI);
      extreme += doubles(new Track(61, -58, m + 3).typing(500, 60, peak, m + 301), sens, maxI);
    }
    console.log(`感度${sens}・キーボード音量${peak}: ${minutes}分ずつ → 実機に近い打ち方 ${real} 回 / 文章入力 ${words} 回 / 2打鍵で止まる極端な打ち方 ${extreme} 回`);
  }
  let ok = 0;
  for (let s = 0; s < 200; s++) {
    const r = rng(s * 13 + sens);
    const u = () => r() + 0.5;
    const p = { peak: dbToAmp(-22 + u() * 18), attackMs: 0.2 + u() * 3, decayMs: 4 + u() * 10, centerHz: 1200 + u() * 2300, reverbDb: -24 + u() * 12, rt60: 0.2 + u() * 0.7 };
    const gap = 200 + u() * (maxI - 260);
    const tr = new Track(4, -62 + u() * 20, s).clap(1500, { ...p, seed: s }).clap(1500 + gap, { ...p, peak: p.peak * (0.7 + u() * 0.6), seed: s + 1 });
    if (doubles(tr, sens, maxI) === 1) ok++;
  }
  console.log(`感度${sens}（間隔${maxI / 1000}秒）: 拍手2回 ${ok}/200 回起動`);
}
