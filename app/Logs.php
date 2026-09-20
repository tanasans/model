<?php
declare(strict_types=1);

/** 監査ログ。DBに必ず残し、スプレッドシートへは後から転記する。 */
final class Logs
{
    public static function write(string $level, string $event, string $ref = '', string $message = '', array $context = []): void
    {
        try {
            $st = Db::conn()->prepare(
                'INSERT INTO logs (ts, level, event, ref, message, context) VALUES (?,?,?,?,?,?)'
            );
            $st->execute([
                Db::now(), $level, $event, $ref, $message,
                json_encode($context, JSON_UNESCAPED_UNICODE),
            ]);
        } catch (Throwable $e) {
            error_log('log write failed: ' . $e->getMessage());
        }
    }

    public static function info(string $event, string $ref = '', string $msg = '', array $ctx = []): void
    { self::write('info', $event, $ref, $msg, $ctx); }

    public static function warn(string $event, string $ref = '', string $msg = '', array $ctx = []): void
    { self::write('warn', $event, $ref, $msg, $ctx); }

    public static function error(string $event, string $ref = '', string $msg = '', array $ctx = []): void
    { self::write('error', $event, $ref, $msg, $ctx); }
}
