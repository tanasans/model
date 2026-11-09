import { useState } from 'react';
import { MEMORY_SPANS, span, START_SPANS, stat, type LatencyRecord } from '../latency/latencyTrace';

const KIND_LABEL = { wake: '呼びかけ', clap: '拍手', manual: 'ボタン', memory: '記憶検索' } as const;

/** 応答時間（各段階の ms。平均・中央値・最大）。数値はこのブラウザ内だけに保存 */
export function LatencyCard({ list, onClear }: { list: LatencyRecord[]; onClear: () => void }) {
  const [copied, setCopied] = useState(false);
  if (list.length === 0) return null;
  const starts = list.filter((r) => r.kind !== 'memory');
  const mems = list.filter((r) => r.kind === 'memory');
  const table = (rows: LatencyRecord[], spans: typeof START_SPANS) => (
    <table className="lt-table">
      <thead>
        <tr>
          <th>区間</th>
          <th>平均</th>
          <th>中央値</th>
          <th>最大</th>
          <th>最新</th>
        </tr>
      </thead>
      <tbody>
        {spans.map((s) => {
          const v = rows.map((r) => span(r, s.from, s.to)).filter((x): x is number => x !== null);
          const st = stat(v);
          const latest = rows[0] ? span(rows[0], s.from, s.to) : null;
          if (!st) return null;
          return (
            <tr key={s.label}>
              <td>{s.label}</td>
              <td>{st.mean}</td>
              <td>{st.median}</td>
              <td>{st.max}</td>
              <td>{latest ?? '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
  const server = (rows: LatencyRecord[], key: string) => stat(rows.map((r) => r.values[key]).filter((x): x is number => typeof x === 'number'));
  return (
    <details className="k-card k-history lt-card">
      <summary className="k-card-title">
        <span>応答時間（ms・{list.length} 件）</span>
        <span className="k-card-en">LATENCY</span>
      </summary>
      {starts.length > 0 && (
        <>
          <p className="muted small">
            起動 {starts.length} 件（{starts.map((r) => KIND_LABEL[r.kind]).slice(0, 6).join('・')}
            {starts.length > 6 ? '…' : ''}）／ 挨拶：{starts.filter((r) => r.notes.includes('ローカル挨拶')).length} 件がローカル挨拶
          </p>
          {table(starts, START_SPANS)}
          <p className="muted small">
            サーバー内訳（中央値）：KAITO.md {server(starts, 'server.persona')?.median ?? '—'}・長期記憶 {server(starts, 'server.memory')?.median ?? '—'}・一時キー発行（OpenAI）{server(starts, 'server.secret')?.median ?? '—'}
          </p>
        </>
      )}
      {mems.length > 0 && (
        <>
          <p className="muted small">記憶検索 {mems.length} 件 ／ SQLite など（中央値）{server(mems, 'sqliteMs')?.median ?? '—'} ms</p>
          {table(mems, MEMORY_SPANS)}
        </>
      )}
      <div className="row-actions">
        <button
          className="btn btn-small"
          onClick={() => void navigator.clipboard?.writeText(JSON.stringify(list, null, 1)).then(() => setCopied(true), () => setCopied(false))}
        >
          {copied ? 'コピーしました' : '数値をコピー'}
        </button>
        <button className="btn btn-small btn-ghost" onClick={onClear}>
          記録を消す
        </button>
      </div>
    </details>
  );
}
