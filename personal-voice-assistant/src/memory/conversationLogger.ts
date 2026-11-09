/**
 * 1 回の会話の記録（会話履歴の保存と、記憶ツールが使う「この会話の状況」）。
 * - ユーザーの確定した発言が 1 回もない会話（誤起動など）は保存しない
 *   → 最初の確定したユーザー発言の時点で会話を作り、それまでの KAITO の発言（挨拶など）もまとめて送る
 * - 会話履歴の保存が OFF ならサーバーは何も保存しない（その場合も、記憶ツールの確認に使う発言は手元に保持する）
 * - 送信先はローカルサーバーだけ（OpenAI には送らない）
 */
import type { SessionTrigger } from '../../shared/memory';
import { TranscriptRecorder, type RecordedMessage } from './transcriptRecorder';

type Fetch = typeof fetch;

export class ConversationLogger {
  readonly recorder: TranscriptRecorder;
  private serverId: string | null = null;
  private creating: Promise<string | null> | null = null;
  private pending: RecordedMessage[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private ended = false;

  constructor(
    private readonly trigger: SessionTrigger,
    private readonly startedAt: number,
    private readonly fetchImpl: Fetch = (...a) => fetch(...a),
  ) {
    this.recorder = new TranscriptRecorder((m) => this.onMessage(m));
  }

  /** 記憶ツールの「情報源の会話」として使う ID（保存していなければ null） */
  get sessionId(): string | null {
    return this.serverId;
  }

  handleEvent(ev: { type?: string; [k: string]: unknown }): void {
    if (!this.ended) this.recorder.handle(ev);
  }

  private onMessage(m: RecordedMessage): void {
    if (this.serverId) {
      this.send(m);
      return;
    }
    this.pending = [...this.pending.filter((x) => x.itemId !== m.itemId), m];
    if (m.role === 'user' && m.status === 'final' && m.text && !this.creating) {
      this.creating = this.createSession().then((id) => {
        this.serverId = id;
        if (id) for (const p of this.pending.sort((a, b) => a.seq - b.seq)) this.send(p);
        this.pending = [];
        return id;
      });
    }
  }

  private async createSession(): Promise<string | null> {
    try {
      const res = await this.fetchImpl('/api/memory/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: this.trigger, startedAt: this.startedAt }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { id: string | null };
      return body.id ?? null;
    } catch {
      return null;
    }
  }

  /** 発言を順番どおりに送る（失敗しても会話は続ける） */
  private send(m: RecordedMessage): void {
    const id = this.serverId;
    if (!id) return;
    this.queue = this.queue.then(() =>
      this.fetchImpl(`/api/memory/sessions/${encodeURIComponent(id)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m),
        keepalive: true,
      }).catch(() => undefined),
    );
  }

  /** 会話の終了。送信待ちを終えてから終了時刻を記録する */
  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.creating) await this.creating;
    await this.queue;
    const id = this.serverId;
    if (!id) return;
    await this.fetchImpl(`/api/memory/sessions/${encodeURIComponent(id)}/end`, { method: 'POST', keepalive: true }).catch(() => undefined);
  }
}
