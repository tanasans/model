<?php
/**
 * 初期セットアップ用の点検ページ。
 *
 * 安全のため storage/SETUP_ENABLED というファイルが存在するときだけ開きます。
 * 設置が終わったら必ず storage/SETUP_ENABLED を削除してください（このページが閉じます）。
 */
require __DIR__ . '/../app/bootstrap.php';

$flagFile = rtrim((string)config('storage_dir'), '/') . '/SETUP_ENABLED';
if (!is_file($flagFile)) {
    http_response_code(404);
    exit('このページは無効です。storage/SETUP_ENABLED を作成すると有効になります。');
}

$checks = [];
$add = function (string $name, bool $ok, string $detail = '') use (&$checks) {
    $checks[] = ['name' => $name, 'ok' => $ok, 'detail' => $detail];
};

/* PHPと拡張 */
$add('PHP バージョン (8.0以上)', version_compare(PHP_VERSION, '8.0', '>='), PHP_VERSION);
foreach (['pdo_sqlite' => 'SQLite', 'curl' => 'cURL', 'openssl' => 'OpenSSL', 'mbstring' => 'mbstring'] as $ext => $label) {
    $add("拡張モジュール {$label}", extension_loaded($ext), $ext);
}

/* ディレクトリ */
$add('storage ディレクトリに書き込み可', is_writable((string)config('storage_dir')), (string)config('storage_dir'));

/* データベース */
try {
    Db::conn();
    $n = Db::conn()->query('SELECT COUNT(*) c FROM reservations')->fetch()['c'] ?? 0;
    $add('データベース（自動作成）', true, '予約 ' . $n . ' 件');
} catch (Throwable $e) {
    $add('データベース（自動作成）', false, $e->getMessage());
}

/* 予約枠 */
$slots = Slots::forDate(date('Y-m-d', strtotime('+3 days')));
$add('予約枠の設定', count($slots) > 0, count($slots) . ' 枠 / 日');

/* 管理パスワード */
$hash = (string)config('admin.password_hash');
$add('管理画面パスワードの設定', $hash !== '' && !str_contains($hash, 'CHANGE_ME'),
     str_contains($hash, 'CHANGE_ME') ? 'config.php の admin.password_hash が未設定です' : '設定済み');

/* 外部連携 */
if (($_POST['do'] ?? '') === 'test_switchbot') {
    $res = SwitchBot::status();
    $add('SwitchBot 接続テスト', !empty($res['ok']),
         !empty($res['ok']) ? json_encode($res['body'], JSON_UNESCAPED_UNICODE) : (string)($res['error'] ?? ''));
}
if (($_POST['do'] ?? '') === 'test_sheets') {
    $res = Sheets::ensureSheets();
    $add('スプレッドシート接続テスト', !empty($res['ok']),
         !empty($res['ok']) ? 'シートを準備しました' : (string)($res['error'] ?? ''));
}
if (($_POST['do'] ?? '') === 'test_mail') {
    $to = (string)(config('mail.admin_to')[0] ?? '');
    $ok = $to !== '' && Mailer::send($to, '【テスト】予約システムの送信確認',
        "このメールが届いていれば、サーバーからのメール送信は正常です。\n" . date('Y-m-d H:i:s'));
    $add('テストメール送信', $ok, $to !== '' ? $to . ' 宛に送信しました' : 'mail.admin_to が未設定です');
}

$genHash = '';
if (($_POST['do'] ?? '') === 'hash' && ($_POST['pw'] ?? '') !== '') {
    $genHash = password_hash((string)$_POST['pw'], PASSWORD_DEFAULT);
}
?>
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>セットアップ点検</title>
<link rel="stylesheet" href="assets/style.css">
<style>
.chk{display:grid; grid-template-columns:1.6em 1fr; gap:6px 10px; font-size:.9rem; margin:0}
.chk .mark{font-weight:700}
.chk .ng{color:var(--warn)} .chk .okc{color:var(--ok)}
.chk .detail{grid-column:2; font-size:.78rem; color:var(--muted); margin:-4px 0 8px; word-break:break-all}
code{background:#f3f0ea; padding:2px 6px; border-radius:4px; word-break:break-all}
</style>
</head>
<body>
<main class="wrap narrow">
  <h1>セットアップ点検</h1>
  <p class="notice warn">設置が終わったら <code>storage/SETUP_ENABLED</code> を必ず削除してください。</p>

  <div class="card">
    <h2>動作環境</h2>
    <div class="chk">
      <?php foreach ($checks as $c): ?>
        <span class="mark <?= $c['ok'] ? 'okc' : 'ng' ?>"><?= $c['ok'] ? '○' : '×' ?></span>
        <span><?= h($c['name']) ?></span>
        <?php if ($c['detail'] !== ''): ?><span class="detail"><?= h($c['detail']) ?></span><?php endif; ?>
      <?php endforeach; ?>
    </div>
  </div>

  <div class="card">
    <h2>接続テスト</h2>
    <form method="post" class="actions" style="justify-content:flex-start">
      <button class="btn" name="do" value="test_switchbot">SwitchBot</button>
      <button class="btn" name="do" value="test_sheets">スプレッドシート</button>
      <button class="btn" name="do" value="test_mail">テストメール</button>
    </form>
  </div>

  <div class="card">
    <h2>管理画面パスワードの作成</h2>
    <p class="hint">ここで作った文字列を config.php の <code>admin.password_hash</code> に貼り付けてください。</p>
    <form method="post">
      <input type="hidden" name="do" value="hash">
      <div class="field"><label for="pw">設定したいパスワード</label>
        <input type="text" id="pw" name="pw" autocomplete="off"></div>
      <button type="submit" class="btn primary">ハッシュを作る</button>
    </form>
    <?php if ($genHash): ?>
      <p class="notice ok"><code><?= h($genHash) ?></code></p>
    <?php endif; ?>
  </div>
</main>
</body>
</html>
