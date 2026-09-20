<?php
/** お客様ご自身によるキャンセル画面（メール内のリンクから開く）。 */
require __DIR__ . '/../app/bootstrap.php';

$code  = (string)($_GET['code'] ?? $_POST['code'] ?? '');
$token = (string)($_GET['t']    ?? $_POST['t']    ?? '');

$r       = Reservations::findByCode($code);
$valid   = $r && hash_equals((string)$r['cancel_token'], $token);
$message = null;
$done    = false;

if (!$valid) {
    $message = 'ご予約が確認できませんでした。お手数ですがお電話にてご連絡ください。';
} elseif ($r['status'] === 'cancelled') {
    $message = 'このご予約はすでにキャンセル済みです。';
    $done = true;
} elseif ($r['status'] !== 'confirmed') {
    $message = 'このご予約はすでに終了しております。';
    $done = true;
} elseif (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $start = Slots::at((string)$r['date'], (string)$r['start_time']);
    if ($start && $start < new DateTimeImmutable('now')) {
        $message = '開始時刻を過ぎたご予約はこちらからキャンセルできません。お電話にてご連絡ください。';
    } else {
        $res = Reservations::cancel($code, 'customer');
        if (!empty($res['ok'])) {
            $message = 'ご予約をキャンセルいたしました。発行済みのパスコードは無効になりました。';
            $done = true;
            $r = $res['reservation'];
        } else {
            $message = (string)($res['error'] ?? 'キャンセルできませんでした。');
        }
    }
}
?>
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>ご予約のキャンセル｜<?= h((string)config('site.name')) ?></title>
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<main class="wrap narrow">
  <h1>ご予約のキャンセル</h1>

  <?php if ($message): ?>
    <p class="notice <?= $done ? 'ok' : 'warn' ?>"><?= h($message) ?></p>
  <?php endif; ?>

  <?php if ($valid && $r): ?>
    <dl class="summary">
      <dt>ご予約番号</dt><dd><?= h((string)$r['code']) ?></dd>
      <dt>お名前</dt>    <dd><?= h((string)$r['name']) ?> 様</dd>
      <dt>ご見学日時</dt><dd><?= h(Mailer::dateLabel((string)$r['date'])) ?> <?= h((string)$r['start_time']) ?>〜<?= h((string)$r['end_time']) ?></dd>
      <dt>状態</dt>      <dd><?= $r['status'] === 'cancelled' ? 'キャンセル済み' : ($r['status'] === 'confirmed' ? 'ご予約済み' : '終了') ?></dd>
    </dl>

    <?php if ($r['status'] === 'confirmed' && !$done): ?>
      <form method="post" onsubmit="return confirm('このご予約をキャンセルします。よろしいですか？');">
        <input type="hidden" name="code" value="<?= h((string)$r['code']) ?>">
        <input type="hidden" name="t"    value="<?= h((string)$token) ?>">
        <button type="submit" class="btn danger">このご予約をキャンセルする</button>
      </form>
      <p class="hint">キャンセル後、再度ご希望の場合はお手数ですが改めてご予約ください。</p>
    <?php endif; ?>
  <?php endif; ?>

  <p class="hint">
    <?= h((string)config('site.company')) ?>　TEL: <?= h((string)config('site.tel')) ?>
  </p>
</main>
</body>
</html>
