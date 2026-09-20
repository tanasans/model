<?php
/**
 * モデルルーム見学予約システム 設定ファイル
 *
 * このファイルを config.php という名前でコピーし、実際の値を入れてください。
 * config.php は公開ディレクトリの外に置き、絶対にGit等へ入れないこと。
 */

return [

    // ───────── 施設・運用 ─────────
    'site' => [
        'name'        => 'ユニコモデルルーム',          // メール等に出る名称
        'company'     => '株式会社フォレストヴィレッジ',
        'tel'         => '000-000-0000',
        'address'     => '〇〇県〇〇市〇〇町1-2-3',
        'base_url'    => 'https://yoyaku.forest-v.jp',  // 末尾スラッシュなし
        'timezone'    => 'Asia/Tokyo',
    ],

    // ───────── 予約枠 ─────────
    // slot_minutes と start_times を書き換えるだけで 30分枠などに変更できます。
    // 例）30分枠にする場合:
    //   'slot_minutes' => 30,
    //   'start_times'  => ['10:00','10:30','11:00', ... ,'16:30'],
    'booking' => [
        'slot_minutes'    => 60,
        'start_times'     => ['10:00','11:00','13:00','14:00','15:00','16:00'],
        'open_days'       => [0,1,2,3,4,5,6], // 0=日 … 6=土。定休日は外す
        'lead_hours'      => 3,     // 何時間先から予約可能か（直前予約の防止）
        'horizon_days'    => 30,    // 何日先まで予約可能か
        'max_party_size'  => 6,
        'buffer_before'   => 10,    // 解錠を何分前から有効にするか
        'buffer_after'    => 10,    // 施錠猶予（終了後 何分まで有効か）
    ],

    // ───────── SwitchBot ─────────
    'switchbot' => [
        'token'      => 'ここにSwitchBotアプリで取得したトークン',
        'secret'     => 'ここにシークレットキー',
        'device_id'  => 'ロック本体のデバイスID',   // キーパッドではなく「ロック」のID
        // パスコード種別:
        //   'timeLimit'  = 予約時間帯の間は何度でも入退室可（推奨）
        //   'disposable' = その時間帯で1回だけ使える（一度出ると再入室不可）
        'key_type'   => 'timeLimit',
        'enabled'    => true,   // false にするとAPIを呼ばず、発行済みの体で動作（テスト用）
    ],

    // ───────── メール ─────────
    'mail' => [
        'from_name'   => 'ユニコモデルルーム 予約受付',
        'from'        => 'yoyaku@forest-v.jp',
        'admin_to'    => ['tanasans777777@gmail.com'], // 管理者への通知先（複数可）
        'envelope_from' => 'yoyaku@forest-v.jp',       // さくらのSPF対策(-f)
    ],

    // ───────── Googleスプレッドシート転記 ─────────
    'sheets' => [
        'enabled'          => true,
        'spreadsheet_id'   => 'スプレッドシートURLの /d/ と /edit の間の文字列',
        'sheet_reservations' => '予約',   // シート（タブ）名
        'sheet_logs'         => 'ログ',
        // サービスアカウントのJSONキーのパス（公開ディレクトリの外に置くこと）
        'credentials_path' => __DIR__ . '/../storage/google-service-account.json',
    ],

    // ───────── 管理画面 ─────────
    'admin' => [
        // パスワードは password_hash('好きなパスワード', PASSWORD_DEFAULT) の結果を貼る
        'password_hash' => '$2y$10$CHANGE_ME_CHANGE_ME_CHANGE_ME_CHANGE_ME_CHANGE_MEabcdefg',
        'session_name'  => 'mrbk_admin',
    ],

    // ───────── アンケート項目 ─────────
    // key は英数字。ここを編集すればフォームの設問がそのまま変わります。
    'survey' => [
        ['key'=>'purpose',  'label'=>'ご検討の内容', 'type'=>'select', 'required'=>true,
         'options'=>['新築戸建て','建て替え','リフォーム','土地探し','情報収集のみ']],
        ['key'=>'timing',   'label'=>'ご入居のご希望時期', 'type'=>'select', 'required'=>true,
         'options'=>['3ヶ月以内','半年以内','1年以内','2年以上先','未定']],
        ['key'=>'budget',   'label'=>'ご予算の目安', 'type'=>'select', 'required'=>false,
         'options'=>['〜2,000万円','2,000〜3,000万円','3,000〜4,000万円','4,000万円〜','未定']],
        ['key'=>'area',     'label'=>'ご希望のエリア', 'type'=>'text', 'required'=>false],
        ['key'=>'source',   'label'=>'当社をお知りになったきっかけ', 'type'=>'select', 'required'=>false,
         'options'=>['インターネット検索','SNS','チラシ','看板','ご紹介','その他']],
        ['key'=>'note',     'label'=>'ご質問・ご要望', 'type'=>'textarea', 'required'=>false],
    ],

    // ───────── その他 ─────────
    'storage_dir' => __DIR__ . '/../storage',
    'debug'       => false,
];
