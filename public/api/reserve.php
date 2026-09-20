<?php
/** 予約の受付。 */
require __DIR__ . '/../../app/bootstrap.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    json_out(['ok' => false, 'error' => '不正なリクエストです。'], 405);
}

$raw = file_get_contents('php://input');
$in  = json_decode((string)$raw, true);
if (!is_array($in)) $in = $_POST;

/** 入力値の整形と検証 */
$errors = [];

// 制御文字を除いて前後の空白を落とす。配列などが送られてきても落ちないようにする。
$trim = static function ($v): string {
    if (!is_scalar($v)) return '';
    return trim((string)preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/u', '', (string)$v));
};

$name  = $trim($in['name']  ?? '');
$kana  = $trim($in['kana']  ?? '');
$email = $trim($in['email'] ?? '');
$tel   = $trim($in['tel']   ?? '');
$date  = $trim($in['date']  ?? '');
$start = $trim($in['start_time'] ?? '');
$party = (int)(is_scalar($in["party_size"] ?? null) ? $in["party_size"] : 1);
$agree = !empty($in['agree']);

// 入力欄に見せかけた罠（自動投稿対策）。人間なら空のまま。
// 気づかれないよう、受け付けたように見せて何も登録しない。
if ($trim($in['website'] ?? '') !== '') {
    Logs::warn('reserve.honeypot', client_ip(), '自動投稿とみなして破棄');
    json_out(['ok' => true, 'reservation' => [
        'code'            => 'RECEIVED',
        'date'            => $date,
        'start_time'      => $start,
        'end_time'        => $start,
        'name'            => $name,
        'party_size'      => max(1, $party),
        'passcode_issued' => false,
        'email'           => $email,
    ]]);
}

if ($name === '' || mb_strlen($name) > 60)   $errors['name']  = 'お名前をご入力ください。';
if (mb_strlen($kana) > 60)                    $errors['kana']  = 'フリガナが長すぎます。';
if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    $errors['email'] = 'メールアドレスをご確認ください。';
}
if ($tel !== '' && !preg_match('/\A[0-9０-９\-\+\(\)\s]{8,20}\z/u', $tel)) {
    $errors['tel'] = '電話番号をご確認ください。';
}
if (!Slots::parseDate($date))                 $errors['date'] = '見学日をお選びください。';
if (!preg_match('/\A\d{2}:\d{2}\z/', $start)) $errors['start_time'] = '見学時間をお選びください。';

$maxParty = (int)config('booking.max_party_size', 6);
if ($party < 1 || $party > $maxParty) {
    $errors['party_size'] = 'ご来場人数は1〜' . $maxParty . '名でご指定ください。';
}
if (!$agree) $errors['agree'] = '個人情報の取り扱いについてご同意ください。';

// アンケート
$surveyIn = is_array($in['survey'] ?? null) ? $in['survey'] : [];
$survey   = [];
foreach ((array)config('survey', []) as $q) {
    $raw = $surveyIn[$q['key']] ?? '';
    $v   = $trim(is_scalar($raw) ? (string)$raw : '');
    if (($q['type'] ?? '') === 'select' && $v !== '' && !in_array($v, (array)($q['options'] ?? []), true)) {
        $errors['survey_' . $q['key']] = $q['label'] . 'の選択内容が正しくありません。';
        continue;
    }
    if (!empty($q['required']) && $v === '') {
        $errors['survey_' . $q['key']] = $q['label'] . 'をご入力ください。';
    }
    $survey[$q['key']] = mb_substr($v, 0, 1000);
}

if ($errors) {
    json_out(['ok' => false, 'error' => 'ご入力内容をご確認ください。', 'fields' => $errors], 422);
}

// 短時間の連続送信を抑える
if (Reservations::recentCountByEmail($email, 10) >= 2 || Reservations::recentCountByIp(client_ip(), 10) >= 3) {
    Logs::warn('reserve.rate_limited', $email, '短時間に複数回の送信');
    json_out([
        'ok'    => false,
        'error' => '短時間に複数のお申し込みをいただいております。恐れ入りますが少し時間をおいてお試しください。',
    ], 429);
}

try {
    $res = Reservations::create([
        'name'       => $name,
        'kana'       => $kana,
        'email'      => $email,
        'tel'        => $tel,
        'date'       => $date,
        'start_time' => $start,
        'party_size' => $party,
        'survey'     => $survey,
    ]);
} catch (Throwable $e) {
    Logs::error('reserve.exception', $email, $e->getMessage());
    Mailer::toAdmins('[障害] 予約処理でエラーが発生しました', $e->getMessage() . "\n" . $e->getTraceAsString());
    json_out([
        'ok'    => false,
        'error' => '申し訳ございません。システムの不具合により受付できませんでした。お手数ですがお電話にてご連絡ください。',
    ], 500);
}

if (empty($res['ok'])) {
    json_out([
        'ok'           => false,
        'error'        => $res['error'],
        'reason'       => $res['reason'] ?? null,
        'alternatives' => $res['alternatives'] ?? [],
    ], 409);
}

$r = $res['reservation'];
json_out([
    'ok' => true,
    'reservation' => [
        'code'        => $r['code'],
        'date'        => $r['date'],
        'start_time'  => $r['start_time'],
        'end_time'    => $r['end_time'],
        'name'        => $r['name'],
        'party_size'  => (int)$r['party_size'],
        // パスコードは画面には出さず、必ずメールでのみお知らせする
        'passcode_issued' => $r['key_status'] === 'issued',
        'email'       => $r['email'],
    ],
]);
