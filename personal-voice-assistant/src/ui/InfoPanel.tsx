import { useEffect, useState } from 'react';
import { ASSISTANT_NAME } from '../../shared/assistant';
import { getMicHubInfo, type MicHubInfo } from '../audio/micHub';
import type { ClapController } from '../clap/useClapController';
import { OUTCOME_LABEL, type ClapTriggerRecord, type SoundSummary } from '../clap/clapHistory';
import type { LogEntry } from '../clap/useClapStandby';
import type { TranscriptLine } from '../useVoiceSession';
import type { WakeController } from '../wake/useWakeController';
import type { WakeLogEntry } from '../wake/useWakeStandby';
import { fmtDb, fmtNum } from './parts';
import { LatencyCard } from './LatencyCard';
import type { LatencyRecord } from '../latency/latencyTrace';

export interface InfoPanelProps {
  wake: WakeController;
  clap: ClapController;
  lines: TranscriptLine[];
  connected: boolean;
  errors: string[];
  notice: string | null;
  latency: LatencyRecord[];
  onClearLatency: () => void;
}

type Item =
  | { at: number; src: 'wake'; e: WakeLogEntry }
  | { at: number; src: 'clap'; e: LogEntry };

export function InfoPanel({ wake, clap, lines, connected, errors, notice, latency, onClearLatency }: InfoPanelProps) {
  const items: Item[] = [
    ...wake.wake.log.map((e) => ({ at: e.at, src: 'wake' as const, e })),
    ...clap.standby.log.map((e) => ({ at: e.at, src: 'clap' as const, e })),
  ].sort((a, b) => b.at - a.at);
  const latest = items.find((i) => (i.src === 'wake' ? i.e.kind === 'decision' : i.e.kind === 'sound'));

  return (
    <aside className="k-info" aria-label="情報">
      <section className="k-card">
        <h2 className="k-card-title">
          <span>認識結果</span>
          <span className="k-card-en">LAST DETECTION</span>
        </h2>
        {latest ? <LatestDecision item={latest} /> : <p className="k-empty">判定なし</p>}
      </section>

      <section className="k-card k-card-grow">
        <h2 className="k-card-title">
          <span>会話履歴</span>
          <span className="k-card-en">TRANSCRIPT</span>
        </h2>
        {lines.length === 0 ? (
          <p className="k-empty">{connected ? '発話なし' : '会話なし'}</p>
        ) : (
          <ul className="k-transcript">
            {lines.map((l) => (
              <li key={l.id} className={`k-line k-line-${l.role}`}>
                <span className="k-line-who">{l.role === 'user' ? 'あなた' : ASSISTANT_NAME}</span>
                <span className={l.text ? 'k-line-text' : 'k-line-text is-missing'}>
                  {l.text ?? (l.pending ? '（音声を処理中…）' : '（文字起こしは届いていないか、取得できませんでした）')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={`k-card ${errors.length ? 'k-card-alert' : ''}`}>
        <h2 className="k-card-title">
          <span>エラー</span>
          <span className="k-card-en">ALERTS</span>
        </h2>
        {errors.length === 0 ? (
          <p className="k-empty">なし</p>
        ) : (
          <ul className="k-errors" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {notice && <p className="k-notice">{notice}</p>}
      </section>

      <MicCard />
      {wake.wake.level && (
        <section className={`k-card ${wake.wake.level.backlogSec > 1.5 ? 'k-card-alert' : ''}`}>
          <h2 className="k-card-title">
            <span>音声認識の遅れ</span>
            <span className="k-card-en">RECOGNIZER</span>
          </h2>
          <p className="k-empty">
            {wake.wake.level.backlogSec.toFixed(1)} 秒（まだ処理していない音声。通常は 0.0〜0.3 秒）{wake.wake.restarts ? ` ／ 作り直し ${wake.wake.restarts} 回` : ''}
          </p>
          {wake.wake.level.backlogSec > 1.5 && <p className="k-notice">PC の処理が追いついていません。遅れが続くと、静かなときに自動で認識を作り直します（音声待機を OFF → ON でも同じです）。</p>}
        </section>
      )}

      <LatencyCard list={latency} onClear={onClearLatency} />

      <ClapTriggerHistory clap={clap} />

      {items.length > 0 && (
        <details className="k-card k-history">
          <summary className="k-card-title">
            <span>判定の履歴</span>
            <span className="k-card-en">LOG</span>
          </summary>
          <ul>
            {items.slice(0, 20).map((i) => (
              <li key={`${i.src}-${i.e.id}`} className={historyTone(i)}>
                <time>{new Date(i.at).toLocaleTimeString('ja-JP')}</time>
                <span className="k-src">{i.src === 'wake' ? '声' : '拍手'}</span>
                {historyText(i)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  );
}

function LatestDecision({ item }: { item: Item }) {
  if (item.src === 'wake' && item.e.kind === 'decision') {
    const d = item.e.decision;
    return (
      <div className={`k-decision ${d.accepted ? 'is-ok' : 'is-ng'}`}>
        <div className="k-decision-head">
          <span className="k-badge">音声</span>
          <strong>{d.accepted ? '起動' : '起動しない'}</strong>
          <span className="k-decision-meta">「{d.text.replace(/\[unk\]/g, '…')}」・{new Date(item.at).toLocaleTimeString('ja-JP')}</span>
        </div>
        {d.reason && <p className="k-reason">理由：{d.reason}</p>}
        <ul className="k-checks">
          {d.checks.map((c) => (
            <li key={c.key} className={c.pass ? 'pass' : 'fail'}>
              <span className="mark">{c.pass ? '✓' : '✗'}</span>
              {c.label}
              <span className="k-check-detail">{c.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (item.src === 'clap' && item.e.kind === 'sound') {
    const s = item.e.info;
    return (
      <div className={`k-decision ${s.accepted ? 'is-ok' : 'is-ng'}`}>
        <div className="k-decision-head">
          <span className="k-badge">拍手</span>
          <strong>{s.accepted ? '拍手と判定' : '拍手ではない'}</strong>
          <span className="k-decision-meta">{new Date(item.at).toLocaleTimeString('ja-JP')}</span>
        </div>
        {s.reason && <p className="k-reason">理由：{s.reason}</p>}
        <ul className="k-checks">
          {s.checks.map((c) => (
            <li key={c.key} className={c.pass ? 'pass' : 'fail'}>
              <span className="mark">{c.pass ? '✓' : '✗'}</span>
              {c.label}
              <span className="k-check-detail">
                {fmtNum(c.value)}
                {c.unit}（基準 {c.kind === 'min' ? '≥' : '≤'} {fmtNum(c.threshold)}
                {c.unit}）
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return null;
}

function historyTone(i: Item): string {
  if (i.src === 'wake') return i.e.kind === 'decision' ? (i.e.decision.accepted ? 'tone-ok' : 'tone-warn') : '';
  if (i.e.kind === 'sound') return i.e.info.accepted ? 'tone-ok' : 'tone-warn';
  return i.e.tone === 'ok' ? 'tone-ok' : i.e.tone === 'warn' ? 'tone-warn' : '';
}

function historyText(i: Item): string {
  if (i.src === 'wake') {
    const e = i.e;
    if (e.kind === 'decision') {
      return e.decision.accepted
        ? `呼びかけを検知（${e.decision.phrase === 'nee' ? 'ねえ、カイト' : 'カイト'}）`
        : `呼びかけと判定せず：${e.decision.reason ?? ''}`;
    }
    return e.text;
  }
  const e = i.e;
  if (e.kind === 'sound') return e.info.accepted ? `拍手と判定（${fmtDb(e.info.levelDb)}）` : `拍手ではない：${e.info.reason ?? ''}`;
  return e.text;
}

/** 待機用マイクの名前と音声加工の実際の適用状態（ブラウザが返した値のみ表示） */
function MicCard() {
  const [info, setInfo] = useState<MicHubInfo>(getMicHubInfo);
  useEffect(() => {
    const id = window.setInterval(() => setInfo(getMicHubInfo()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const p = info.processing;
  const items: Array<[string, boolean | null]> = p
    ? [
        ['自動音量調整', p.autoGainControl],
        ['ノイズ抑制', p.noiseSuppression],
        ['エコーキャンセル', p.echoCancellation],
      ]
    : [];
  return (
    <section className="k-card">
      <h2 className="k-card-title">
        <span>マイク</span>
        <span className="k-card-en">DEVICE</span>
      </h2>
      {!p ? (
        <p className="k-empty">未使用</p>
      ) : (
        <>
          <p className="k-mic-name">
            {p.label || '（名前を取得できません）'}
            <span className="k-mic-rate">{Math.round(p.sampleRate / 100) / 10} kHz</span>
          </p>
          <div className="k-proc">
            {items.map(([name, v]) => (
              <span key={name} className={`k-pchip ${v === true ? 'is-on' : v === false ? 'is-off' : ''}`}>
                {name} {v === true ? 'ON' : v === false ? 'OFF' : '不明'}
              </span>
            ))}
          </div>
          {items.some(([, v]) => v === true) && <p className="k-meta">音声加工が ON：Windows のマイク設定で強化機能をオフに</p>}
        </>
      )}
    </section>
  );
}

/** 拍手で起動したときの履歴（判定値・直前の静けさ・その後に話しかけたか）。数値だけを表示・コピーする */
function ClapTriggerHistory({ clap }: { clap: ClapController }) {
  const [copied, setCopied] = useState(false);
  const list = clap.history;
  if (list.length === 0) return null;
  const noSpeech = list.filter((r) => r.outcome === 'no-speech').length;
  return (
    <details className="k-card k-history k-clap-history">
      <summary className="k-card-title">
        <span>
          拍手で起動した履歴（{list.length} 件{noSpeech ? `・話しかけなし ${noSpeech} 件` : ''}）
        </span>
        <span className="k-card-en">CLAP TRIGGERS</span>
      </summary>
      <ul>
        {list.map((r) => (
          <li key={r.id} className={r.outcome === 'no-speech' ? 'tone-warn' : r.outcome === 'spoke' ? 'tone-ok' : ''}>
            <time>{new Date(r.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
            <span className="k-src">{OUTCOME_LABEL[r.outcome]}</span>
            {recordText(r)}
          </li>
        ))}
      </ul>
      <div className="row-actions">
        <button
          className="btn btn-small"
          onClick={() => {
            void navigator.clipboard?.writeText(JSON.stringify(list, null, 1)).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? 'コピーしました' : '数値をコピー（調整の相談用）'}
        </button>
        <button className="btn btn-small btn-ghost" onClick={clap.clearHistory}>
          履歴を消す
        </button>
      </div>
    </details>
  );
}

function soundText(s: SoundSummary): string {
  return `${fmtNum(s.levelDb)}dB・急変${fmtNum(s.jumpDb)}・短さ${fmtNum(s.decayDb)}・余韻${fmtNum(s.tailDb)}・尖り${fmtNum(s.crest)}${s.kbd !== null ? `・キーボード差${fmtNum(s.kbd)}` : ''}`;
}

function recordText(r: ClapTriggerRecord): string {
  return `間隔 ${(r.intervalMs / 1000).toFixed(2)}秒／直前の静けさ ${(r.quietBeforeMs / 1000).toFixed(1)}秒（直前6秒の小さな鋭い音 ${r.softBefore} 回）／1回目 ${soundText(r.sounds[0])}／2回目 ${soundText(r.sounds[1])}／反応ライン ${fmtNum(r.triggerDb)}dB・感度 ${r.sensitivity}${r.usedSignature ? '・キーボード音登録あり' : ''}`;
}
