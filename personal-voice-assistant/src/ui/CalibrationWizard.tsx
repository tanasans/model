import type { useCalibration } from '../clap/useCalibration';
import { CALIB_TIMING } from '../clap/useCalibration';
import { fmtDb, LevelBar } from './parts';

/** キャリブレーションの画面（進行・判定は useCalibration / CalibrationRun 側） */
export function CalibrationWizard({
  calib,
  onUse,
}: {
  calib: ReturnType<typeof useCalibration>;
  onUse: (which: 'calibrated' | 'ambient' | 'manual') => void;
}) {
  const { step, snap } = calib;
  const amb = snap?.ambient ?? null;
  const running = step === 'ambient' || step === 'claps' || step === 'noise';
  return (
    <div className="wizard" role="dialog" aria-label="キャリブレーション">
      <div className="wizard-steps">
        <span className={step === 'ambient' ? 'on' : ''}>1. 環境音</span>
        <span className={step === 'claps' ? 'on' : ''}>2. 拍手 {CALIB_TIMING.clapsTarget} 回</span>
        <span className={step === 'noise-ready' || step === 'noise' ? 'on' : ''}>3. 声・キーボード（任意）</span>
        <span className={step === 'result' ? 'on' : ''}>4. 結果</span>
      </div>
      <p className="meta">各手順は時間で自動的に次へ進みます。小さな物音があっても最初からやり直しにはなりません。</p>

      {step === 'ambient' && (
        <p>
          <strong>ふだんの部屋の状態のままお待ちください</strong>（完全な無音でなくて大丈夫です。拍手はまだしないでください）
          <br />
          環境音を測っています… 残り {snap?.secondsLeft ?? Math.round(CALIB_TIMING.ambientMs / 1000)} 秒
        </p>
      )}
      {step === 'claps' && snap && (
        <p>
          <strong>1秒ほど間をあけて、ふだん起動するときと同じ位置・強さで1回ずつ拍手</strong>してください。
          <br />
          拍手 <strong>{snap.clapCount}</strong> / {CALIB_TIMING.clapsTarget} 回（残り {snap.secondsLeft} 秒で自動的に次へ）
          {snap.ignoredCount > 0 && (
            <>
              <br />
              <small className="meta">
                しきい値に届かない小さな音を {snap.ignoredCount} 回無視しました
                {snap.lastIgnoredDb !== null && `（直近 ${fmtDb(snap.lastIgnoredDb)}）`}。拍手が数えられない場合は、もう少し強く叩いてください。
              </small>
            </>
          )}
        </p>
      )}
      {step === 'noise-ready' && snap && (
        <div>
          <p>
            拍手を {snap.clapCount} 回数えました。続けて、<strong>誤起動させたくない音</strong>（ふだんの声で話す・キーボードを打つ）を{' '}
            {Math.round(CALIB_TIMING.noiseMs / 1000)} 秒測ると、その音を登録して拍手と区別します。
            <br />
            <small className="meta">キーボードで誤起動する場合は、ふだんどおり文章を打ってください（Enter・スペースも含めて）。</small>
            <br />
            <small className="meta">{snap.secondsLeft} 秒操作がなければ、自動で結果へ進みます。</small>
          </p>
          <div className="row-actions">
            <button className="ghost" onClick={calib.startNoise}>
              測る（{Math.round(CALIB_TIMING.noiseMs / 1000)}秒）
            </button>
            <button className="ghost" onClick={calib.skipNoise}>
              スキップして結果へ
            </button>
          </div>
        </div>
      )}
      {step === 'noise' && snap && (
        <p>
          <strong>キーボードをふだんどおり打つ、またはふだんの声で話してください</strong>（拍手はしないでください）… 残り {snap.secondsLeft} 秒
        </p>
      )}

      {running && snap && (
        <div className="meter">
          <LevelBar levelDb={snap.levelDb} floorDb={amb?.floorDb ?? snap.liveFloorDb} gateDb={amb?.clapGateDb ?? null} />
          <div className="levels">
            <span>
              現在の入力 <strong>{fmtDb(snap.levelDb)}</strong>
            </span>
            <span>
              環境音の基準値 <strong>{fmtDb(amb?.floorDb ?? snap.liveFloorDb)}</strong>
              <small>{amb ? '（測定済み）' : '（測定中）'}</small>
            </span>
            <span>
              拍手判定しきい値 <strong>{amb ? fmtDb(amb.clapGateDb) : '測定後に決定'}</strong>
            </span>
          </div>
        </div>
      )}

      {step === 'result' && snap?.result && (
        <div>
          <p>
            <strong>{snap.result.ok ? 'キャリブレーション完了' : '拍手の測定ができませんでした'}</strong>
          </p>
          <ul className="notes">
            <li>
              環境音の基準値：{fmtDb(snap.result.summary.floorDb)}
              {snap.result.summary.smallSoundDb !== null && ` ／ 環境の小さな音：${fmtDb(snap.result.summary.smallSoundDb)}`}
              {' ／ '}拍手判定しきい値：{fmtDb(snap.result.ok ? snap.result.profile.minLevelDb : snap.result.fallbackProfile.minLevelDb)}
            </li>
            {snap.result.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <div className="row-actions">
            {snap.result.ok ? (
              <button onClick={() => onUse('calibrated')}>この基準を使う</button>
            ) : (
              <button onClick={() => onUse('ambient')}>環境音の結果だけで試す</button>
            )}
            <button className="ghost" onClick={() => onUse('manual')}>
              手動設定で試す
            </button>
            <button className="ghost" onClick={() => void calib.start()}>
              やり直す
            </button>
            <button className="ghost" onClick={calib.cancel}>
              閉じる
            </button>
          </div>
        </div>
      )}
      {step === 'error' && (
        <div>
          <div className="alert error">{calib.error}</div>
          <button className="ghost" onClick={calib.cancel}>
            閉じる
          </button>
        </div>
      )}
      {running && (
        <div className="row-actions">
          <button className="ghost" onClick={calib.cancel}>
            中止
          </button>
        </div>
      )}
    </div>
  );
}

