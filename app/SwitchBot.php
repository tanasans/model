<?php
declare(strict_types=1);

/**
 * SwitchBot API v1.1 クライアント（スマートロック＋キーパッドのパスコード発行）。
 *
 * 仕組み:
 *   予約が入った時点で「有効期限付きパスコード」をキーパッドに登録する。
 *   鍵そのものを時間で開け閉めするのではなく、パスコードに有効時間を持たせるので、
 *   当日サーバーやネットが落ちていても解錠でき、時間外は番号を打っても開かない。
 */
final class SwitchBot
{
    private const BASE = 'https://api.switch-bot.com/v1.1';

    /**
     * 予約時間帯だけ有効なパスコードを発行する。
     * @return array{ok:bool, passcode?:string, key_id?:string, error?:string}
     */
    public static function issuePasscode(string $code, DateTimeImmutable $from, DateTimeImmutable $to): array
    {
        $passcode = self::generatePasscode();

        if (!config('switchbot.enabled', true)) {
            Logs::info('switchbot.skipped', $code, 'switchbot.enabled が false のため発行をスキップ');
            return ['ok' => true, 'passcode' => $passcode, 'key_id' => 'DRYRUN'];
        }

        $res = self::command((string)config('switchbot.device_id'), 'createKey', [
            'name'      => 'MR' . preg_replace('/[^A-Z0-9]/', '', $code),
            'type'      => (string)config('switchbot.key_type', 'timeLimit'),
            'password'  => $passcode,
            'startTime' => $from->getTimestamp(),
            'endTime'   => $to->getTimestamp(),
        ]);

        if (!$res['ok']) {
            Logs::error('switchbot.issue_failed', $code, $res['error'], $res);
            return ['ok' => false, 'error' => $res['error']];
        }

        $keyId = (string)($res['body']['id'] ?? $res['body']['keyId'] ?? '');
        Logs::info('switchbot.issued', $code, 'パスコード発行', [
            'key_id' => $keyId,
            'from'   => $from->format('Y-m-d H:i'),
            'to'     => $to->format('Y-m-d H:i'),
        ]);
        return ['ok' => true, 'passcode' => $passcode, 'key_id' => $keyId];
    }

    /** 発行済みパスコードを削除する（キャンセル時・終了後の後片付け）。 */
    public static function deletePasscode(string $code, string $keyId): array
    {
        if (!config('switchbot.enabled', true) || $keyId === '' || $keyId === 'DRYRUN') {
            return ['ok' => true];
        }
        $res = self::command((string)config('switchbot.device_id'), 'deleteKey', ['id' => $keyId]);
        if ($res['ok']) {
            Logs::info('switchbot.deleted', $code, 'パスコード削除', ['key_id' => $keyId]);
        } else {
            Logs::error('switchbot.delete_failed', $code, $res['error'], ['key_id' => $keyId]);
        }
        return $res;
    }

    /** 施錠／解錠（管理者の手動操作・緊急時用）。 */
    public static function lockControl(string $action): array
    {
        $cmd = $action === 'unlock' ? 'unlock' : 'lock';
        return self::command((string)config('switchbot.device_id'), $cmd, null, 'command');
    }

    /** デバイスの現在状態を取得（接続確認用）。 */
    public static function status(): array
    {
        return self::request('GET', '/devices/' . rawurlencode((string)config('switchbot.device_id')) . '/status');
    }

    private static function command(string $deviceId, string $command, $parameter = null, string $type = 'command'): array
    {
        $body = [
            'command'     => $command,
            'commandType' => $type,
            'parameter'   => $parameter === null ? 'default' : $parameter,
        ];
        return self::request('POST', '/devices/' . rawurlencode($deviceId) . '/commands', $body);
    }

    /** 署名を付けてAPIを呼ぶ。 */
    private static function request(string $method, string $path, ?array $body = null): array
    {
        $token  = (string)config('switchbot.token');
        $secret = (string)config('switchbot.secret');
        if ($token === '' || $secret === '') {
            return ['ok' => false, 'error' => 'SwitchBotのトークン／シークレットが未設定です'];
        }

        $t     = (string)(int)round(microtime(true) * 1000);
        $nonce = bin2hex(random_bytes(8));
        $sign  = base64_encode(hash_hmac('sha256', $token . $t . $nonce, $secret, true));

        $ch = curl_init(self::BASE . $path);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 20,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_HTTPHEADER     => [
                'Authorization: ' . $token,
                'sign: ' . $sign,
                't: ' . $t,
                'nonce: ' . $nonce,
                'Content-Type: application/json; charset=utf8',
            ],
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
        }

        $raw  = curl_exec($ch);
        $err  = curl_error($ch);
        $http = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($raw === false) {
            return ['ok' => false, 'error' => '通信エラー: ' . $err, 'http' => $http];
        }
        $json = json_decode((string)$raw, true);
        if (!is_array($json)) {
            return ['ok' => false, 'error' => '応答の解析に失敗: ' . substr((string)$raw, 0, 300), 'http' => $http];
        }
        // statusCode 100 が成功
        if ((int)($json['statusCode'] ?? -1) !== 100) {
            return [
                'ok'    => false,
                'error' => 'SwitchBot エラー ' . ($json['statusCode'] ?? '?') . ': ' . ($json['message'] ?? ''),
                'http'  => $http,
                'body'  => $json['body'] ?? null,
            ];
        }
        return ['ok' => true, 'body' => $json['body'] ?? [], 'http' => $http];
    }

    /**
     * 6桁のパスコードを作る。
     * ぞろ目・連番・既存の有効なコードとの重複は避ける。
     */
    public static function generatePasscode(): string
    {
        $used = array_column(
            Db::conn()->query(
                "SELECT passcode FROM reservations
                 WHERE passcode IS NOT NULL AND status = 'confirmed' AND date >= date('now','-1 day')"
            )->fetchAll(),
            'passcode'
        );

        for ($i = 0; $i < 200; $i++) {
            $p = str_pad((string)random_int(100000, 999999), 6, '0', STR_PAD_LEFT);
            if (preg_match('/^(\d)\1{5}$/', $p)) continue;             // 111111 など
            if (str_contains('0123456789', $p) || str_contains('9876543210', $p)) continue; // 連番
            if (in_array($p, $used, true)) continue;
            return $p;
        }
        throw new RuntimeException('パスコードの生成に失敗しました');
    }
}
