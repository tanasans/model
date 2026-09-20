<?php
declare(strict_types=1);

/**
 * Googleスプレッドシートへの書き出し。
 * サービスアカウントのJSONキーで自己署名JWTを作り、アクセストークンを取得する。
 * composer や外部ライブラリは不要（openssl と curl のみ）。
 */
final class Sheets
{
    private const TOKEN_URL = 'https://oauth2.googleapis.com/token';
    private const SCOPE     = 'https://www.googleapis.com/auth/spreadsheets';

    public static function enabled(): bool
    {
        return (bool)config('sheets.enabled', false)
            && is_file((string)config('sheets.credentials_path'))
            && (string)config('sheets.spreadsheet_id') !== '';
    }

    /** 予約1件を「予約」シートに追記する。 */
    public static function appendReservation(array $r): array
    {
        $survey = json_decode((string)$r['survey_json'], true) ?: [];
        $row = [
            $r['created_at'],
            $r['code'],
            self::statusLabel((string)$r['status']),
            $r['date'],
            $r['start_time'],
            $r['end_time'],
            $r['name'],
            $r['kana'],
            $r['email'],
            "'" . $r['tel'],                 // 先頭の0が消えないよう文字列として入れる
            $r['party_size'],
            "'" . (string)$r['passcode'],
            $r['key_status'],
            (string)$r['key_id'],
        ];
        foreach ((array)config('survey', []) as $q) {
            $row[] = (string)($survey[$q['key']] ?? '');
        }
        $row[] = $r['ip'];

        return self::append((string)config('sheets.sheet_reservations', '予約'), [$row]);
    }

    /** 予約の状態変更をシートに反映する（予約番号で行を探して更新）。 */
    public static function updateReservation(array $r): array
    {
        $sheet = (string)config('sheets.sheet_reservations', '予約');
        $find  = self::request('GET', '/values/' . rawurlencode($sheet . '!B:B'));
        if (!$find['ok']) return $find;

        $rows  = $find['body']['values'] ?? [];
        $rowNo = null;
        foreach ($rows as $i => $cols) {
            if (($cols[0] ?? '') === $r['code']) { $rowNo = $i + 1; break; }
        }
        if ($rowNo === null) return self::appendReservation($r);  // 未転記なら追記に切り替える

        return self::request(
            'PUT',
            '/values/' . rawurlencode($sheet . '!C' . $rowNo) . '?valueInputOption=USER_ENTERED',
            ['values' => [[self::statusLabel((string)$r['status'])]]]
        );
    }

    /** ログ行をまとめて「ログ」シートへ追記する。 */
    public static function appendLogs(array $logRows): array
    {
        if (!$logRows) return ['ok' => true];
        $values = array_map(fn($l) => [
            $l['ts'], $l['level'], $l['event'], $l['ref'], $l['message'], $l['context'],
        ], $logRows);
        return self::append((string)config('sheets.sheet_logs', 'ログ'), $values);
    }

    /** シートが無ければ作り、見出し行を入れる。初回セットアップ用。 */
    public static function ensureSheets(): array
    {
        $meta = self::request('GET', '');
        if (!$meta['ok']) return $meta;

        $existing = array_map(
            fn($s) => $s['properties']['title'] ?? '',
            $meta['body']['sheets'] ?? []
        );

        $resSheet = (string)config('sheets.sheet_reservations', '予約');
        $logSheet = (string)config('sheets.sheet_logs', 'ログ');

        $requests = [];
        foreach ([$resSheet, $logSheet] as $title) {
            if (!in_array($title, $existing, true)) {
                $requests[] = ['addSheet' => ['properties' => ['title' => $title]]];
            }
        }
        if ($requests) {
            $res = self::request('POST', ':batchUpdate', ['requests' => $requests]);
            if (!$res['ok']) return $res;
        }

        $header = ['受付日時','予約番号','状態','見学日','開始','終了','お名前','フリガナ','メール','電話','人数','パスコード','鍵状態','キーID'];
        foreach ((array)config('survey', []) as $q) $header[] = $q['label'];
        $header[] = 'IP';

        self::request('PUT', '/values/' . rawurlencode($resSheet . '!A1') . '?valueInputOption=USER_ENTERED',
            ['values' => [$header]]);
        self::request('PUT', '/values/' . rawurlencode($logSheet . '!A1') . '?valueInputOption=USER_ENTERED',
            ['values' => [['日時','種別','イベント','対象','内容','詳細']]]);

        return ['ok' => true];
    }

    private static function append(string $sheet, array $values): array
    {
        return self::request(
            'POST',
            '/values/' . rawurlencode($sheet . '!A1') . ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
            ['values' => $values]
        );
    }

    private static function request(string $method, string $suffix, ?array $body = null): array
    {
        if (!self::enabled()) {
            return ['ok' => false, 'error' => 'スプレッドシート連携が無効、または認証情報がありません'];
        }

        $token = self::accessToken();
        if (!$token['ok']) return $token;

        $url = 'https://sheets.googleapis.com/v4/spreadsheets/'
             . rawurlencode((string)config('sheets.spreadsheet_id')) . $suffix;

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 25,
            CURLOPT_HTTPHEADER     => [
                'Authorization: Bearer ' . $token['token'],
                'Content-Type: application/json; charset=UTF-8',
            ],
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
        }
        $raw  = curl_exec($ch);
        $err  = curl_error($ch);
        $http = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($raw === false) return ['ok' => false, 'error' => '通信エラー: ' . $err];
        if ($http >= 300)   return ['ok' => false, 'error' => 'Sheets APIエラー(' . $http . '): ' . substr((string)$raw, 0, 300)];

        return ['ok' => true, 'body' => json_decode((string)$raw, true) ?: []];
    }

    /** サービスアカウントのJWTでアクセストークンを取得（有効期限まで使い回す）。 */
    private static function accessToken(): array
    {
        static $cached = null;
        if ($cached && $cached['expires'] > time() + 60) {
            return ['ok' => true, 'token' => $cached['token']];
        }

        $json = json_decode((string)file_get_contents((string)config('sheets.credentials_path')), true);
        if (!is_array($json) || empty($json['client_email']) || empty($json['private_key'])) {
            return ['ok' => false, 'error' => 'サービスアカウントのJSONが不正です'];
        }

        $now    = time();
        $header = ['alg' => 'RS256', 'typ' => 'JWT'];
        $claim  = [
            'iss'   => $json['client_email'],
            'scope' => self::SCOPE,
            'aud'   => self::TOKEN_URL,
            'exp'   => $now + 3600,
            'iat'   => $now,
        ];
        $input = self::b64((string)json_encode($header)) . '.' . self::b64((string)json_encode($claim));

        $sig = '';
        if (!openssl_sign($input, $sig, $json['private_key'], OPENSSL_ALGO_SHA256)) {
            return ['ok' => false, 'error' => 'JWTの署名に失敗しました'];
        }
        $jwt = $input . '.' . self::b64($sig);

        $ch = curl_init(self::TOKEN_URL);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 20,
            CURLOPT_POSTFIELDS     => http_build_query([
                'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                'assertion'  => $jwt,
            ]),
        ]);
        $raw = curl_exec($ch);
        $err = curl_error($ch);
        curl_close($ch);

        if ($raw === false) return ['ok' => false, 'error' => 'トークン取得の通信エラー: ' . $err];
        $res = json_decode((string)$raw, true);
        if (empty($res['access_token'])) {
            return ['ok' => false, 'error' => 'トークン取得失敗: ' . substr((string)$raw, 0, 300)];
        }

        $cached = ['token' => $res['access_token'], 'expires' => $now + (int)($res['expires_in'] ?? 3600)];
        return ['ok' => true, 'token' => $cached['token']];
    }

    private static function b64(string $s): string
    {
        return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
    }

    private static function statusLabel(string $status): string
    {
        return match ($status) {
            'confirmed' => '予約済み',
            'cancelled' => 'キャンセル',
            'done'      => '見学済み',
            'noshow'    => '未来場',
            default     => $status,
        };
    }
}
