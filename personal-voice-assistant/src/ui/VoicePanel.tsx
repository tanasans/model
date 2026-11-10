import { useState } from 'react';
import { PREVIEW_SAMPLES, VOICES, type PreviewSampleId, type VoiceId } from '../../shared/assistant';
import { AUDIO_PROFILE_LABEL, AUDIO_PROFILES, SPEECH_SPEEDS, type AudioProfileId, type SpeechSpeed } from '../../shared/conversationAudio';
import type { ConversationSettingsController } from '../voice/conversationSettings';
import { PRIORITY_VOICES, type VoiceSettings } from '../voice/useVoiceSettings';
import { Toggle } from './parts';

/** 音声の選択と試聴（コンパクト版）。採用するまで既定の声は変わらない */
export function VoicePanel({
  vs,
  conv,
  greeting,
  defaultVoice,
  apiKeyConfigured,
  busy,
}: {
  vs: VoiceSettings;
  conv: ConversationSettingsController;
  greeting: { info: { voice: string; speed: number; text: string; seconds: number } | null; voice: string | null; reload: () => Promise<void> };
  defaultVoice: string | null;
  apiKeyConfigured: boolean;
  busy: boolean;
}) {
  const speed = conv.settings.speechSpeed;
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
                void vs.preview(candidate, sample, speed);
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
          前回の試聴：最初の音まで {(last.firstAudioMs / 1000).toFixed(2)} 秒（速さ {last.speed.toFixed(2)}）
        </p>
      )}
      {vs.previewError && <p className="vp-error">{vs.previewError}</p>}

      <label className="field">
        <span>話す速さ</span>
        <select value={String(speed)} onChange={(e) => conv.update({ speechSpeed: Number(e.target.value) as SpeechSpeed })}>
          {SPEECH_SPEEDS.map((v) => (
            <option key={v} value={String(v)}>
              {v === 1 ? '1.00（標準）' : v.toFixed(2)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>周囲の音（テレビ）対策</span>
        <select value={conv.settings.audioProfile} onChange={(e) => conv.update({ audioProfile: e.target.value as AudioProfileId })}>
          {AUDIO_PROFILES.map((p) => (
            <option key={p} value={p}>
              {AUDIO_PROFILE_LABEL[p]}
            </option>
          ))}
        </select>
      </label>
      {conv.settings.audioProfile === 'tv_strong' && <p className="muted small">強：KAITO の返答中に声で割り込んで止めることはできません。</p>}
      <GreetingSection conv={conv} greeting={greeting} apiKeyConfigured={apiKeyConfigured} busy={busy} />
      <p className="muted small">変更は次の会話から適用されます。</p>
    </div>
  );
}

/** ローカル挨拶：起動時の挨拶を KAITO の声で事前に作り、接続と同時に再生する（生成を待たない） */
function GreetingSection({
  conv,
  greeting,
  apiKeyConfigured,
  busy,
}: {
  conv: ConversationSettingsController;
  greeting: { info: { voice: string; speed: number; text: string; seconds: number } | null; voice: string | null; reload: () => Promise<void> };
  apiKeyConfigured: boolean;
  busy: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const speed = conv.settings.speechSpeed;
  const info = greeting.info;
  const make = async () => {
    setWorking(true);
    setMsg(null);
    try {
      const res = await fetch('/api/greeting/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: greeting.voice, speed }) });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) throw new Error(body?.message ?? `作成できませんでした（HTTP ${res.status}）。`);
      await greeting.reload();
      setMsg('挨拶の音声を作成しました。次の会話から、接続と同時に再生します。');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '作成できませんでした。');
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="vp-greet">
      <Toggle label="起動時の挨拶をローカル音声で再生（高速）" checked={conv.settings.localGreeting} onChange={(v) => conv.update({ localGreeting: v })} />
      <Toggle label="高速起動（起動音と並行して接続の準備）" checked={conv.settings.fastStart} onChange={(v) => conv.update({ fastStart: v })} />
      <p className="muted small">約 0.4 秒速くなりますが、PC によっては呼びかけの認識に影響することがあります。認識しにくいときは OFF にしてください（既定 ON）。</p>
      <p className="muted small">
        {info ? `作成済み：「${info.text}」（${info.voice}・速さ ${info.speed.toFixed(2)}・${info.seconds.toFixed(1)}秒）` : `この声（${greeting.voice ?? '—'}）・速さ ${speed.toFixed(2)} の挨拶の音声はまだありません。作成するまでは、従来どおり接続後に挨拶を生成します。`}
      </p>
      {confirming ? (
        <div className="vp-confirm">
          <p>挨拶の音声の作成に API 料金がかかります（1 回で数円程度）。声・速さ・挨拶の文を変えたら作り直してください。</p>
          <div className="row-actions">
            <button
              className="btn btn-accent"
              onClick={() => {
                setConfirming(false);
                void make();
              }}
            >
              作成する
            </button>
            <button className="btn" onClick={() => setConfirming(false)}>
              やめる
            </button>
          </div>
        </div>
      ) : (
        <button className="btn btn-small" disabled={!apiKeyConfigured || busy || working || !greeting.voice} onClick={() => setConfirming(true)}>
          {working ? '作成中…' : info ? '挨拶の音声を作り直す' : '挨拶の音声を作る'}
        </button>
      )}
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}
