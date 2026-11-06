/** 起動音（ブラウザ内で合成。外部ファイル・通信なし）。鳴り終わるまで待つ */
export async function playChime(): Promise<void> {
  const Ctx = window.AudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  try {
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    const t0 = ctx.currentTime + 0.02;
    const notes: Array<[number, number]> = [
      [880, 0],
      [1318.5, 0.13],
    ];
    for (const [freq, offset] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + offset);
      gain.gain.linearRampToValueAtTime(0.25, t0 + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + offset + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.25);
    }
    await new Promise((r) => setTimeout(r, 420));
  } finally {
    void ctx.close().catch(() => undefined);
  }
}
