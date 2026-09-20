<?php
/** フォームの初期化情報（設問・予約ルール）を返す。 */
require __DIR__ . '/../../app/bootstrap.php';

json_out([
    'ok' => true,
    'site' => [
        'name'    => config('site.name'),
        'company' => config('site.company'),
        'tel'     => config('site.tel'),
        'address' => config('site.address'),
    ],
    'booking' => [
        'slot_minutes'   => (int)config('booking.slot_minutes', 60),
        'max_party_size' => (int)config('booking.max_party_size', 6),
        'lead_hours'     => (int)config('booking.lead_hours', 3),
        'horizon_days'   => (int)config('booking.horizon_days', 30),
    ],
    'survey' => array_map(fn($q) => [
        'key'      => $q['key'],
        'label'    => $q['label'],
        'type'     => $q['type'],
        'required' => (bool)($q['required'] ?? false),
        'options'  => $q['options'] ?? [],
    ], (array)config('survey', [])),
]);
