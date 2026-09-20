<?php
declare(strict_types=1);

/** SQLite への接続とスキーマ管理。 */
final class Db
{
    private static ?PDO $pdo = null;

    public static function conn(): PDO
    {
        if (self::$pdo instanceof PDO) return self::$pdo;

        $file = rtrim((string)config('storage_dir'), '/') . '/booking.sqlite';
        $pdo = new PDO('sqlite:' . $file, null, null, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA busy_timeout = 5000');
        $pdo->exec('PRAGMA foreign_keys = ON');
        self::$pdo = $pdo;
        self::migrate($pdo);
        @chmod($file, 0600);
        return $pdo;
    }

    private static function migrate(PDO $pdo): void
    {
        $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS reservations (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            code            TEXT    NOT NULL UNIQUE,
            status          TEXT    NOT NULL DEFAULT 'confirmed', -- confirmed / cancelled / done / noshow
            date            TEXT    NOT NULL,        -- YYYY-MM-DD
            start_time      TEXT    NOT NULL,        -- HH:MM
            end_time        TEXT    NOT NULL,        -- HH:MM
            name            TEXT    NOT NULL,
            kana            TEXT    NOT NULL DEFAULT '',
            email           TEXT    NOT NULL,
            tel             TEXT    NOT NULL DEFAULT '',
            party_size      INTEGER NOT NULL DEFAULT 1,
            survey_json     TEXT    NOT NULL DEFAULT '{}',
            passcode        TEXT,
            key_id          TEXT,                    -- SwitchBot 側のキーID
            key_status      TEXT    NOT NULL DEFAULT 'pending', -- pending/issued/failed/revoked
            key_error       TEXT,
            cancel_token    TEXT    NOT NULL,
            mail_sent_at    TEXT,
            created_at      TEXT    NOT NULL,
            updated_at      TEXT    NOT NULL,
            ip              TEXT    NOT NULL DEFAULT '',
            ua              TEXT    NOT NULL DEFAULT ''
        );
        SQL);

        // 同一枠の二重予約をDBレベルで禁止（キャンセル済みは対象外）
        $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_res_slot_active
                    ON reservations(date, start_time) WHERE status = 'confirmed'");
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_res_date ON reservations(date)');

        // 管理者が閉じる枠（臨時休業・メンテナンス等）
        $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS blocks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            date        TEXT NOT NULL,
            start_time  TEXT,            -- NULL なら終日
            end_time    TEXT,
            reason      TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL
        );
        SQL);
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_blocks_date ON blocks(date)');

        $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ts          TEXT NOT NULL,
            level       TEXT NOT NULL,
            event       TEXT NOT NULL,
            ref         TEXT NOT NULL DEFAULT '',
            message     TEXT NOT NULL DEFAULT '',
            context     TEXT NOT NULL DEFAULT '{}',
            synced_at   TEXT
        );
        SQL);
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_logs_sync ON logs(synced_at)');

        // 外部API（スプレッドシート・SwitchBot・メール）の再送キュー
        $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS outbox (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            kind         TEXT NOT NULL,
            payload      TEXT NOT NULL,
            attempts     INTEGER NOT NULL DEFAULT 0,
            next_try_at  TEXT NOT NULL,
            last_error   TEXT,
            created_at   TEXT NOT NULL,
            done_at      TEXT
        );
        SQL);
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(done_at, next_try_at)');
    }

    public static function now(): string
    {
        return (new DateTimeImmutable('now'))->format('Y-m-d H:i:s');
    }
}
