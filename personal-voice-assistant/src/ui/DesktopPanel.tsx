import type { DesktopController } from '../desktop/useDesktop';
import { Toggle } from './parts';

function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}時間${m}分` : `${m}分`;
}

/** 設定 →「デスクトップ」：起動状態・自動起動・終了・バージョン・ログ・エラーの履歴・ポート */
export function DesktopPanel({ d, busy }: { d: DesktopController; busy: boolean }) {
  const s = d.status;
  if (!s) return <p className="muted small">読み込み中…</p>;
  const a = s.autostart;
  return (
    <div className="mp">
      <section className="mp-sec">
        <h3 className="mp-h">起動状態</h3>
        <p className="small">
          {s.desktopMode ? 'デスクトップ版（本番用サーバー）で動作中' : '開発用（npm run dev）で動作中'} ／ 起動から {fmtUptime(s.uptimeSec)} ／ メモリ {s.memoryMB}MB
        </p>
        <p className="muted small">
          バージョン {s.version} ／ ポート {s.port} ／ PID {s.pid} ／ Node.js {s.nodeVersion}
        </p>
        <button className="btn btn-accent" disabled={d.busy} onClick={() => void d.quit()}>
          KAITO を終了
        </button>
        <p className="muted small">待機・マイク・会話を止め、会話履歴と記憶を保存してからサーバーを止めます。Chrome 本体やほかのアプリは終了しません。</p>
      </section>
      <section className="mp-sec">
        <h3 className="mp-h">Windows の自動起動</h3>
        {a.supported ? (
          <>
            <Toggle label="Windows のログイン時に KAITO を起動する" checked={a.enabled} disabled={d.busy || busy} onChange={(v) => void d.setAutostart(v)} />
            <p className="muted small">
              {a.enabled ? (a.matchesThisFolder ? '登録済み（このフォルダの KAITO）' : '登録済み（別のフォルダの KAITO を指しています。OFF → ON で更新できます）') : '未登録'}。
              自動起動では、待機（呼びかけ・拍手）だけを始めます。OpenAI への接続や「はい、カイトです」の再生はしません。
            </p>
          </>
        ) : (
          <p className="muted small">自動起動の登録は Windows のみです。</p>
        )}
      </section>
      <section className="mp-sec">
        <h3 className="mp-h">ショートカット</h3>
        <button className="btn btn-small" disabled={d.busy || !a.supported} onClick={() => void d.installShortcut()}>
          デスクトップのショートカットを作り直す
        </button>
        <p className="muted small">新しい ZIP を別のフォルダに展開したときは、新しいフォルダの KAITO から押してください。記憶と設定はそのまま使えます。</p>
        <p className="mp-path">{s.appDir}</p>
      </section>
      <section className="mp-sec">
        <h3 className="mp-h">ログ・データ</h3>
        <p className="mp-path">{s.logDir}</p>
        <p className="muted small">ログには APIキーや会話の内容は書きません。記憶・個人設定・挨拶の音声は {s.dataDir} にあります。</p>
        <h3 className="mp-h">起動・終了のエラー（最新 10 件）</h3>
        {s.errors.length === 0 ? (
          <p className="muted small">なし</p>
        ) : (
          <ul className="mp-list">
            {s.errors.map((e, i) => (
              <li key={i} className="small">
                {new Date(e.at).toLocaleString('ja-JP')}：{e.message ?? e.event}
              </li>
            ))}
          </ul>
        )}
      </section>
      {d.error && <p className="vp-error">{d.error}</p>}
      {d.message && <p className="pp-ok">{d.message}</p>}
    </div>
  );
}
