<?php
/** 管理画面（予約一覧・枠の停止・パスコードの再発行）。 */
require __DIR__ . '/../../app/bootstrap.php';

session_name((string)config('admin.session_name', 'mrbk_admin'));
session_set_cookie_params(['httponly' => true, 'samesite' => 'Lax',
    'secure' => !empty($_SERVER['HTTPS'])]);
session_start();

/* ───────── ログイン ───────── */
$loginError = '';
if (($_POST['do'] ?? '') === 'login') {
    $pw = (string)($_POST['password'] ?? '');
    if (password_verify($pw, (string)config('admin.password_hash'))) {
        session_regenerate_id(true);
        $_SESSION['auth'] = true;
        $_SESSION['csrf'] = bin2hex(random_bytes(16));
        Logs::info('admin.login', client_ip(), 'ログイン成功');
        header('Location: index.php'); exit;
    }
    $loginError = 'パスワードが違います。';
    Logs::warn('admin.login_failed', client_ip(), 'ログイン失敗');
    usleep(700000);
}
if (($_GET['do'] ?? '') === 'logout') {
    session_destroy();
    header('Location: index.php'); exit;
}

if (empty($_SESSION['auth'])) {
    ?><!doctype html><html lang="ja"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow"><title>管理画面</title>
    <link rel="stylesheet" href="../assets/style.css"></head>
    <body><main class="wrap narrow"><div class="card">
      <h1>管理画面</h1>
      <?php if ($loginError): ?><p class="notice warn"><?= h($loginError) ?></p><?php endif; ?>
      <form method="post">
        <input type="hidden" name="do" value="login">
        <div class="field"><label for="password">パスワード</label>
          <input type="password" id="password" name="password" autofocus required
                 style="width:100%;padding:10px 12px;font-size:16px;border:1px solid var(--line);border-radius:8px"></div>
        <button type="submit" class="btn primary">ログイン</button>
      </form>
    </div></main></body></html><?php
    exit;
}

/* ───────── ここからログイン後 ───────── */
$csrf = (string)($_SESSION['csrf'] ?? '');
function check_csrf(): void {
    if (!hash_equals((string)($_SESSION['csrf'] ?? ''), (string)($_POST['csrf'] ?? ''))) {
        http_response_code(400); exit('セッションが切れました。画面を更新してやり直してください。');
    }
}

$flash   = '';
$flashNg = false;
$action  = (string)($_POST['do'] ?? $_GET['do'] ?? '');

// 削除・キャンセルは必ず確認画面をはさむ
$confirm = null;
if ($action === 'cancel_confirm') {
    check_csrf();
    $confirm = Reservations::findByCode((string)($_POST['code'] ?? ''));
    if (!$confirm) { $flash = '対象の予約が見つかりません。'; $flashNg = true; }
}

if ($action === 'cancel_do') {
    check_csrf();
    $res = Reservations::cancel((string)($_POST['code'] ?? ''), 'admin');
    $flash   = !empty($res['ok']) ? 'ご予約をキャンセルしました。' : (string)($res['error'] ?? '失敗しました。');
    $flashNg = empty($res['ok']);
}

if ($action === 'reissue') {
    check_csrf();
    $r = Reservations::findByCode((string)($_POST['code'] ?? ''));
    if ($r && $r['status'] === 'confirmed') {
        if (!empty($r['key_id'])) SwitchBot::deletePasscode((string)$r['code'], (string)$r['key_id']);
        $res = Reservations::issueKey($r, true);
        $flash   = !empty($res['ok']) ? 'パスコードを再発行し、メールをお送りしました。' : '再発行に失敗: ' . (string)($res['error'] ?? '');
        $flashNg = empty($res['ok']);
    } else {
        $flash = '対象の予約が見つかりません。'; $flashNg = true;
    }
}

if ($action === 'resend') {
    check_csrf();
    $r = Reservations::findByCode((string)($_POST['code'] ?? ''));
    if ($r) {
        $ok = Mailer::reservationConfirmed($r);
        $flash = $ok ? 'ご案内メールを再送しました。' : 'メールの送信に失敗しました。';
        $flashNg = !$ok;
    }
}

if ($action === 'block_add') {
    check_csrf();
    $d  = (string)($_POST['date'] ?? '');
    $st = (string)($_POST['start_time'] ?? '');
    $et = (string)($_POST['end_time'] ?? '');
    if (Slots::parseDate($d)) {
        Db::conn()->prepare('INSERT INTO blocks (date, start_time, end_time, reason, created_at) VALUES (?,?,?,?,?)')
            ->execute([$d, $st ?: null, $et ?: null, (string)($_POST['reason'] ?? ''), Db::now()]);
        Logs::info('admin.block_add', $d, '受付停止を追加', ['start' => $st, 'end' => $et]);
        $flash = '受付停止を登録しました。';
    } else { $flash = '日付が正しくありません。'; $flashNg = true; }
}

if ($action === 'block_del') {
    check_csrf();
    Db::conn()->prepare('DELETE FROM blocks WHERE id = ?')->execute([(int)($_POST['id'] ?? 0)]);
    $flash = '受付停止を解除しました。';
}

if ($action === 'test_switchbot') {
    check_csrf();
    $res = SwitchBot::status();
    $flash = !empty($res['ok'])
        ? 'SwitchBot接続OK：' . json_encode($res['body'], JSON_UNESCAPED_UNICODE)
        : 'SwitchBot接続NG：' . (string)($res['error'] ?? '');
    $flashNg = empty($res['ok']);
}

if ($action === 'setup_sheets') {
    check_csrf();
    $res = Sheets::ensureSheets();
    $flash = !empty($res['ok']) ? 'スプレッドシートを準備しました。' : 'スプレッドシート準備NG：' . (string)($res['error'] ?? '');
    $flashNg = empty($res['ok']);
}

/* 一覧 */
$view = (string)($_GET['view'] ?? 'upcoming');
$sql  = match ($view) {
    'past'  => "SELECT * FROM reservations WHERE date < date('now','localtime') ORDER BY date DESC, start_time DESC LIMIT 200",
    'all'   => "SELECT * FROM reservations ORDER BY date DESC, start_time DESC LIMIT 200",
    default => "SELECT * FROM reservations WHERE date >= date('now','localtime') ORDER BY date, start_time LIMIT 200",
};
$rows   = Db::conn()->query($sql)->fetchAll();
$blocks = Db::conn()->query("SELECT * FROM blocks WHERE date >= date('now','localtime') ORDER BY date, start_time")->fetchAll();
$stuck  = Db::conn()->query('SELECT COUNT(*) c FROM outbox WHERE done_at IS NULL')->fetch()['c'] ?? 0;
?>
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>予約管理｜<?= h((string)config('site.name')) ?></title>
<link rel="stylesheet" href="../assets/style.css">
<style>
table{width:100%; border-collapse:collapse; font-size:.85rem}
th,td{border-bottom:1px solid var(--line); padding:8px 6px; text-align:left; vertical-align:top}
th{color:var(--muted); font-weight:700; white-space:nowrap}
.tag{display:inline-block; padding:1px 7px; border-radius:4px; font-size:.72rem; font-weight:700}
.tag.ok{background:#eaf3ed; color:var(--ok)}
.tag.ng{background:#fbeeea; color:var(--warn)}
.tag.mid{background:#f2efe8; color:var(--muted)}
.tabs{display:flex; gap:8px; margin-bottom:12px; font-size:.85rem}
.tabs a{padding:6px 12px; border-radius:999px; text-decoration:none; color:var(--muted); border:1px solid var(--line)}
.tabs a.on{background:var(--accent); color:#fff; border-color:var(--accent)}
.row-actions button{font-size:.75rem; padding:4px 8px; margin:2px 2px 0 0}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
.inline{display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:8px; align-items:end}
</style>
</head>
<body>
<main class="wrap" style="max-width:1080px">
  <div class="navbar">
    <h1>予約管理</h1>
    <a class="btn ghost" href="?do=logout">ログアウト</a>
  </div>

  <?php if ($flash): ?><p class="notice <?= $flashNg ? 'warn' : 'ok' ?>"><?= h($flash) ?></p><?php endif; ?>
  <?php if ($stuck): ?>
    <p class="notice warn">外部連携の未処理が <?= (int)$stuck ?> 件あります（cronで自動的に再試行されます）。</p>
  <?php endif; ?>

  <?php if ($confirm): /* ── キャンセル確認画面 ── */ ?>
  <div class="card">
    <h2>このご予約をキャンセルします</h2>
    <dl class="summary">
      <dt>予約番号</dt><dd class="mono"><?= h((string)$confirm['code']) ?></dd>
      <dt>日時</dt>    <dd><?= h((string)$confirm['date']) ?> <?= h((string)$confirm['start_time']) ?>〜<?= h((string)$confirm['end_time']) ?></dd>
      <dt>お名前</dt>  <dd><?= h((string)$confirm['name']) ?> 様</dd>
      <dt>メール</dt>  <dd><?= h((string)$confirm['email']) ?></dd>
    </dl>
    <p class="notice warn">発行済みのパスコードは無効になり、お客様へキャンセル通知メールが送信されます。この操作は取り消せません。</p>
    <div class="actions">
      <a class="btn ghost" href="index.php">やめる</a>
      <form method="post" style="margin:0">
        <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
        <input type="hidden" name="do"   value="cancel_do">
        <input type="hidden" name="code" value="<?= h((string)$confirm['code']) ?>">
        <button type="submit" class="btn primary">キャンセルを実行する</button>
      </form>
    </div>
  </div>
  <?php endif; ?>

  <div class="card">
    <div class="tabs">
      <a href="?view=upcoming" class="<?= $view === 'upcoming' ? 'on' : '' ?>">今後の予約</a>
      <a href="?view=past"     class="<?= $view === 'past' ? 'on' : '' ?>">過去</a>
      <a href="?view=all"      class="<?= $view === 'all' ? 'on' : '' ?>">すべて</a>
    </div>
    <table>
      <thead><tr>
        <th>日時</th><th>お客様</th><th>連絡先</th><th>人数</th>
        <th>パスコード</th><th>状態</th><th>操作</th>
      </tr></thead>
      <tbody>
      <?php if (!$rows): ?>
        <tr><td colspan="7" class="hint">該当する予約はありません。</td></tr>
      <?php endif; ?>
      <?php foreach ($rows as $r):
        $survey = json_decode((string)$r['survey_json'], true) ?: []; ?>
        <tr>
          <td><?= h((string)$r['date']) ?><br><?= h((string)$r['start_time']) ?>〜<?= h((string)$r['end_time']) ?>
              <div class="hint mono"><?= h((string)$r['code']) ?></div></td>
          <td><?= h((string)$r['name']) ?> 様<div class="hint"><?= h((string)$r['kana']) ?></div></td>
          <td class="hint"><?= h((string)$r['email']) ?><br><?= h((string)$r['tel']) ?></td>
          <td><?= (int)$r['party_size'] ?></td>
          <td class="mono"><?= h((string)($r['passcode'] ?? '—')) ?>
            <?php if ($r['key_status'] === 'issued'): ?><span class="tag ok">発行済</span>
            <?php elseif ($r['key_status'] === 'failed'): ?><span class="tag ng">発行失敗</span>
            <?php elseif ($r['key_status'] === 'revoked'): ?><span class="tag mid">無効</span>
            <?php else: ?><span class="tag mid">未発行</span><?php endif; ?>
            <?php if (!empty($r['key_error'])): ?><div class="hint"><?= h(mb_substr((string)$r['key_error'], 0, 80)) ?></div><?php endif; ?>
          </td>
          <td><?= match ((string)$r['status']) {
                'confirmed' => '<span class="tag ok">予約済</span>',
                'cancelled' => '<span class="tag ng">取消</span>',
                'done'      => '<span class="tag mid">終了</span>',
                default     => '<span class="tag mid">' . h((string)$r['status']) . '</span>',
              } ?></td>
          <td class="row-actions">
            <?php if ($r['status'] === 'confirmed'): ?>
            <form method="post" style="display:inline">
              <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
              <input type="hidden" name="code" value="<?= h((string)$r['code']) ?>">
              <button class="btn" name="do" value="reissue">再発行</button>
              <button class="btn" name="do" value="resend">メール再送</button>
              <button class="btn" name="do" value="cancel_confirm">取消</button>
            </form>
            <?php endif; ?>
          </td>
        </tr>
        <?php if ($survey): ?>
        <tr><td colspan="7" class="hint">
          <?php foreach ((array)config('survey', []) as $q):
            $v = (string)($survey[$q['key']] ?? ''); if ($v === '') continue; ?>
            <strong><?= h((string)$q['label']) ?>:</strong> <?= h($v) ?>
          <?php endforeach; ?>
        </td></tr>
        <?php endif; ?>
      <?php endforeach; ?>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>受付を止める（臨時休業・メンテナンス）</h2>
    <form method="post">
      <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
      <input type="hidden" name="do" value="block_add">
      <div class="inline">
        <div class="field"><label>日付</label><input type="date" name="date" required></div>
        <div class="field"><label>開始（空欄=終日）</label><input type="time" name="start_time" step="1800"></div>
        <div class="field"><label>終了</label><input type="time" name="end_time" step="1800"></div>
        <div class="field"><label>理由</label><input type="text" name="reason" maxlength="60"></div>
        <div class="field"><button type="submit" class="btn primary">登録</button></div>
      </div>
    </form>
    <?php if ($blocks): ?>
    <table>
      <thead><tr><th>日付</th><th>時間</th><th>理由</th><th></th></tr></thead>
      <tbody>
      <?php foreach ($blocks as $b): ?>
        <tr>
          <td><?= h((string)$b['date']) ?></td>
          <td><?= $b['start_time'] ? h((string)$b['start_time']) . '〜' . h((string)$b['end_time']) : '終日' ?></td>
          <td><?= h((string)$b['reason']) ?></td>
          <td><form method="post" style="margin:0">
            <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
            <input type="hidden" name="id" value="<?= (int)$b['id'] ?>">
            <button class="btn" name="do" value="block_del">解除</button>
          </form></td>
        </tr>
      <?php endforeach; ?>
      </tbody>
    </table>
    <?php endif; ?>
  </div>

  <div class="card">
    <h2>動作確認</h2>
    <form method="post" class="actions" style="justify-content:flex-start">
      <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
      <button class="btn" name="do" value="test_switchbot">SwitchBot接続テスト</button>
      <button class="btn" name="do" value="setup_sheets">スプレッドシート初期設定</button>
    </form>
    <p class="hint">「スプレッドシート初期設定」はシートと見出し行を作ります。最初に一度だけ実行してください。</p>
  </div>
</main>
</body>
</html>
