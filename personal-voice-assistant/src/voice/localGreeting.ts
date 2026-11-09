/**
 * ローカル挨拶：起動時の挨拶（例「はい、カイトです。」）を、事前に作った KAITO の声の音声で再生する。
 * - 音声はローカルサーバー（ユーザー専用フォルダ）から読み込み、ブラウザ内で再生する（OpenAI には接続しない）
 * - 声・話す速さ・挨拶の文が一致するときだけ使う。一致しなければ従来どおり Realtime API が挨拶を生成する
 */
export interface GreetingKey {
  voice: string;
  speed: number;
}

export class LocalGreetingPlayer {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private loaded: (GreetingKey & { text: string }) | null = null;
  private loading: Promise<void> | null = null;

  /** 読み込み済みの音声の情報（無ければ null） */
  get info(): (GreetingKey & { text: string; seconds: number }) | null {
    return this.loaded && this.buffer ? { ...this.loaded, seconds: this.buffer.duration } : null;
  }

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  /** 指定の声・速さの挨拶の音声を読み込む（無ければ何もしない） */
  load(key: GreetingKey): Promise<void> {
    const run = async () => {
      this.buffer = null;
      this.loaded = null;
      try {
        const res = await fetch(`/api/greeting?voice=${encodeURIComponent(key.voice)}&speed=${key.speed}`);
        if (!res.ok) return;
        const text = decodeURIComponent(res.headers.get('X-Greeting-Text') ?? '');
        const data = await res.arrayBuffer();
        this.buffer = await this.context().decodeAudioData(data);
        this.loaded = { ...key, text };
      } catch {
        this.buffer = null;
        this.loaded = null;
      }
    };
    this.loading = (this.loading ?? Promise.resolve()).then(run);
    return this.loading;
  }

  /** 一致する音声があれば再生し、再生時間（ms）を返す。無ければ null */
  async play(g: GreetingKey & { text: string }): Promise<number | null> {
    await this.loading;
    const l = this.loaded;
    if (!l || !this.buffer || l.voice !== g.voice || l.speed !== g.speed || l.text !== g.text) return null;
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    if (ctx.state !== 'running') return null;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(ctx.destination);
    src.start();
    return Math.round(this.buffer.duration * 1000);
  }
}
