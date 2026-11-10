/**
 * ローカル挨拶：起動時の挨拶（例「はい、カイトです。」）を、事前に作った KAITO の声の音声で再生する。
 * - 音声はローカルサーバー（ユーザー専用フォルダ）から読み込み、ブラウザ内で再生する（OpenAI には接続しない）
 * - 声・話す速さ・挨拶の文が一致するときだけ使う。一致しなければ従来どおり Realtime API が挨拶を生成する
 * - 音声処理（AudioContext）は読み込み・再生のたびに作って閉じる（待機中に開いたままにしない）
 */
export interface GreetingKey {
  voice: string;
  speed: number;
}

export class LocalGreetingPlayer {
  private buffer: AudioBuffer | null = null;
  private loaded: (GreetingKey & { text: string }) | null = null;
  private loading: Promise<void> | null = null;

  /** 読み込み済みの音声の情報（無ければ null） */
  get info(): (GreetingKey & { text: string; seconds: number }) | null {
    return this.loaded && this.buffer ? { ...this.loaded, seconds: this.buffer.duration } : null;
  }

  /** 指定の声・速さの挨拶の音声を読み込む（無ければ何もしない） */
  load(key: GreetingKey): Promise<void> {
    const run = async () => {
      this.buffer = null;
      this.loaded = null;
      let ctx: AudioContext | null = null;
      try {
        const res = await fetch(`/api/greeting?voice=${encodeURIComponent(key.voice)}&speed=${key.speed}`);
        if (!res.ok) return;
        const text = decodeURIComponent(res.headers.get('X-Greeting-Text') ?? '');
        const data = await res.arrayBuffer();
        ctx = new AudioContext();
        this.buffer = await ctx.decodeAudioData(data);
        this.loaded = { ...key, text };
      } catch {
        this.buffer = null;
        this.loaded = null;
      } finally {
        void ctx?.close().catch(() => undefined);
      }
    };
    this.loading = (this.loading ?? Promise.resolve()).then(run);
    return this.loading;
  }

  /** 一致する音声があれば再生し、再生時間（ms）を返す。無ければ null。再生が終わったら音声処理を閉じる */
  async play(g: GreetingKey & { text: string }): Promise<number | null> {
    await this.loading;
    const l = this.loaded;
    const buf = this.buffer;
    if (!l || !buf || l.voice !== g.voice || l.speed !== g.speed || l.text !== g.text) return null;
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    if (ctx.state !== 'running') {
      void ctx.close().catch(() => undefined);
      return null;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => void ctx.close().catch(() => undefined);
    src.start();
    return Math.round(buf.duration * 1000);
  }
}
