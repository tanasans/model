import { PREVIEW_SAMPLES, VOICES, type VoiceId } from '../../shared/assistant';
import { PRIORITY_VOICES, VOICE_NOTES, type VoiceSettings } from '../voice/useVoiceSettings';

/** 声の選択と試聴。採用はユーザーが決めるまで既定のまま（強制変更しない） */
export function VoicePanel({ vs, defaultVoice, apiKeyConfigured, busy }: { vs: VoiceSettings; defaultVoice: string | null; apiKeyConfigured: boolean; busy: boolean }) {
  const current = vs.chosen ?? defaultVoice ?? 'marin';
  const ordered: VoiceId[] = [...PRIORITY_VOICES, ...VOICES.filter((v) => !PRIORITY_VOICES.includes(v))];
  return (
    <div className="vp">
      <p className="vp-current">
        現在の声：<b>{current}</b>
        {vs.chosen ? '（あなたが採用）' : '（サーバーの既定）'}　<span className="muted">変更は次の新しい会話から適用されます。</span>
      </p>
      <p className="vp-cost">
        <b>料金について：</b>試聴は会話と同じ OpenAI Realtime API を使うため、1 回ごとに料金がかかります（短い文 1 回で数円程度の目安・料金表で要確認）。
        {!apiKeyConfigured && ' 現在は APIキー未設定のため試聴できません。'}
      </p>
      {vs.previewError && <p className="vp-error">{vs.previewError}</p>}
      <ul className="vp-list">
        {ordered.map((v) => (
          <li key={v} className={`vp-row ${current === v ? 'is-current' : ''}`}>
            <div className="vp-name">
              <b>{v}</b>
              <span className="muted">{VOICE_NOTES[v]}</span>
            </div>
            <div className="vp-samples">
              {PREVIEW_SAMPLES.map((s, i) => {
                const playing = vs.previewing?.voice === v && vs.previewing.sampleId === s.id;
                return (
                  <button
                    key={s.id}
                    className="btn btn-small"
                    title={`試聴：「${s.text}」（料金がかかります）`}
                    disabled={!apiKeyConfigured || busy || vs.previewing !== null}
                    onClick={() => void vs.preview(v, s.id)}
                  >
                    {playing ? '再生準備…' : `▶ ${i + 1}`}
                  </button>
                );
              })}
              <button className="btn btn-small btn-accent" disabled={current === v} onClick={() => vs.choose(v)}>
                {current === v ? '使用中' : '採用'}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <ol className="vp-texts muted">
        {PREVIEW_SAMPLES.map((s) => (
          <li key={s.id}>「{s.text}」</li>
        ))}
      </ol>
      {vs.chosen && (
        <button className="btn btn-small" onClick={() => vs.choose(null)}>
          既定の声（{defaultVoice ?? 'marin'}）に戻す
        </button>
      )}
      {vs.results.length > 0 && (
        <table className="vp-results">
          <caption>試聴の記録（応答速度の比較）</caption>
          <thead>
            <tr>
              <th>声</th>
              <th>文</th>
              <th>最初の音まで</th>
              <th>全体</th>
              <th>音声の長さ</th>
            </tr>
          </thead>
          <tbody>
            {vs.results.map((r) => (
              <tr key={r.at}>
                <td>{r.voice}</td>
                <td>{PREVIEW_SAMPLES.findIndex((s) => s.id === r.sampleId) + 1}</td>
                <td>{Number.isFinite(r.firstAudioMs) ? `${(r.firstAudioMs / 1000).toFixed(2)}秒` : '—'}</td>
                <td>{Number.isFinite(r.totalMs) ? `${(r.totalMs / 1000).toFixed(2)}秒` : '—'}</td>
                <td>{Number.isFinite(r.audioSeconds) ? `${r.audioSeconds.toFixed(1)}秒` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
