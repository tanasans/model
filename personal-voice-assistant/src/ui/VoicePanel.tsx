import { useState } from 'react';
import { PREVIEW_SAMPLES, VOICES, type PreviewSampleId, type VoiceId } from '../../shared/assistant';
import { PRIORITY_VOICES, type VoiceSettings } from '../voice/useVoiceSettings';

/** 音声の選択と試聴（コンパクト版）。採用するまで既定の声は変わらない */
export function VoicePanel({ vs, defaultVoice, apiKeyConfigured, busy }: { vs: VoiceSettings; defaultVoice: string | null; apiKeyConfigured: boolean; busy: boolean }) {
  const current = (vs.chosen ?? defaultVoice ?? 'marin') as VoiceId;
  const [candidate, setCandidate] = useState<VoiceId>(current);
  const [sample, setSample] = useState<PreviewSampleId>('greet');
  const [confirming, setConfirming] = useState(false);
  const others = VOICES.filter((v) => !PRIORITY_VOICES.includes(v));
  const last = vs.results.find((r) => r.voice === candidate);

  return (
    <div className="vp">
      <div className="vp-now">
        <span className="label">使用中</span>
        <b>{current}</b>
        {!vs.chosen && <span className="muted small">既定</span>}
      </div>

      <label className="field">
        <span>声を選ぶ</span>
        <select value={candidate} onChange={(e) => setCandidate(e.target.value as VoiceId)}>
          <optgroup label="優先候補">
            {PRIORITY_VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
                {v === 'marin' ? '（既定）' : ''}
              </option>
            ))}
          </optgroup>
          <optgroup label="その他">
            {others.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </optgroup>
        </select>
      </label>

      <label className="field">
        <span>試聴する文</span>
        <select value={sample} onChange={(e) => setSample(e.target.value as PreviewSampleId)}>
          {PREVIEW_SAMPLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.text}
            </option>
          ))}
        </select>
      </label>

      {confirming ? (
        <div className="vp-confirm">
          <p>試聴は 1 回ごとに API 料金がかかります（数円程度）。</p>
          <div className="row-actions">
            <button
              className="btn btn-accent"
              onClick={() => {
                setConfirming(false);
                void vs.preview(candidate, sample);
              }}
            >
              試聴する
            </button>
            <button className="btn" onClick={() => setConfirming(false)}>
              やめる
            </button>
          </div>
        </div>
      ) : (
        <div className="row-actions">
          <button className="btn" disabled={!apiKeyConfigured || busy || vs.previewing !== null} onClick={() => setConfirming(true)}>
            {vs.previewing ? '再生準備…' : '▶ 試聴'}
          </button>
          <button className="btn btn-accent" disabled={candidate === current} onClick={() => vs.choose(candidate)}>
            この声を採用
          </button>
          {vs.chosen && (
            <button className="btn btn-ghost" onClick={() => vs.choose(null)}>
              既定に戻す
            </button>
          )}
        </div>
      )}
      {!apiKeyConfigured && <p className="muted small">APIキー未設定のため試聴できません。</p>}
      {last && Number.isFinite(last.firstAudioMs) && (
        <p className="muted small">
          前回の試聴：最初の音まで {(last.firstAudioMs / 1000).toFixed(2)} 秒
        </p>
      )}
      {vs.previewError && <p className="vp-error">{vs.previewError}</p>}
      <p className="muted small">変更は次の会話から適用されます。</p>
    </div>
  );
}
