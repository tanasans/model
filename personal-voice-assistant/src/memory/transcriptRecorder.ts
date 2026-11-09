/**
 * Realtime API のサーバーイベントから、確定した文字起こしだけを取り出す（画面から独立した純粋なロジック）。
 *
 * - ユーザーの発言：conversation.item.input_audio_transcription.completed（確定）／ .failed（失敗）
 *   ※ .delta は途中経過なので保存しない
 * - KAITO の回答：response.output_audio_transcript.done（確定）。 .delta は途中経過
 *   ※ 返答の途中でユーザーが話し始めた場合（conversation.item.truncated）は「途中で中断」とする
 *     （生成された文字はあるが、音声は最後まで再生されていないため）
 * - 発言順序：会話に項目が追加された順（conversation.item.added など）
 * 文字起こしが取得できなかった発言は、推測で補わず text=null・status='failed' にする。
 */
import type { TranscriptStatus } from '../../shared/memory';

export interface RecordedMessage {
  itemId: string;
  seq: number;
  role: 'user' | 'assistant';
  text: string | null;
  status: TranscriptStatus;
}

interface ItemState {
  role: 'user' | 'assistant';
  seq: number;
  emitted: RecordedMessage | null;
  truncated: boolean;
}

type AnyEvent = { type?: string; [k: string]: unknown };

export class TranscriptRecorder {
  private items = new Map<string, ItemState>();
  private seq = 0;
  private finals: RecordedMessage[] = [];

  constructor(private readonly onMessage: (m: RecordedMessage) => void) {}

  /** 確定したユーザー発言の数（空でない文字起こし） */
  get userFinalCount(): number {
    return this.finals.filter((m) => m.role === 'user' && m.status === 'final' && m.text).length;
  }

  /** 直近の確定したユーザー発言（保存の依頼の確認用） */
  recentUserTexts(n = 3): string[] {
    return this.finals.filter((m) => m.role === 'user' && m.text).slice(-n).map((m) => m.text!);
  }

  private ensure(itemId: string, role: 'user' | 'assistant'): ItemState {
    let s = this.items.get(itemId);
    if (!s) {
      s = { role, seq: ++this.seq, emitted: null, truncated: false };
      this.items.set(itemId, s);
    }
    return s;
  }

  private emit(itemId: string, s: ItemState, text: string | null, status: TranscriptStatus): void {
    const clean = text?.trim() || null;
    const m: RecordedMessage = { itemId, seq: s.seq, role: s.role, text: clean, status: clean ? status : 'failed' };
    if (s.emitted && s.emitted.text === m.text && s.emitted.status === m.status) return;
    s.emitted = m;
    this.finals = [...this.finals.filter((x) => x.itemId !== itemId), m];
    this.onMessage(m);
  }

  handle(ev: AnyEvent): void {
    const type = ev.type;
    if (!type) return;
    if (type === 'conversation.item.added' || type === 'conversation.item.created' || type === 'response.output_item.added') {
      const item = ev.item as { id?: string; type?: string; role?: string } | undefined;
      if (item?.id && item.type === 'message' && (item.role === 'user' || item.role === 'assistant')) this.ensure(item.id, item.role);
      return;
    }
    const itemId = typeof ev.item_id === 'string' ? ev.item_id : null;
    if (!itemId) return;
    if (type === 'conversation.item.input_audio_transcription.completed') {
      this.emit(itemId, this.ensure(itemId, 'user'), typeof ev.transcript === 'string' ? ev.transcript : null, 'final');
    } else if (type === 'conversation.item.input_audio_transcription.failed') {
      this.emit(itemId, this.ensure(itemId, 'user'), null, 'failed');
    } else if (type === 'response.output_audio_transcript.done' || type === 'response.output_text.done') {
      const s = this.ensure(itemId, 'assistant');
      const text = typeof ev.transcript === 'string' ? ev.transcript : typeof ev.text === 'string' ? ev.text : null;
      this.emit(itemId, s, text, s.truncated ? 'interrupted' : 'final');
    } else if (type === 'conversation.item.truncated') {
      const s = this.items.get(itemId);
      if (!s || s.role !== 'assistant') return;
      s.truncated = true;
      if (s.emitted && s.emitted.status === 'final') this.emit(itemId, s, s.emitted.text, 'interrupted');
    }
  }
}
