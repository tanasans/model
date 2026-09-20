/**
 * デモ用の擬似サーバー。
 *
 * public/api/*.php と同じ受け答えをブラウザの中だけで再現します。
 * データはブラウザの localStorage に保存されるので、画面を閉じても残り、
 * 二重予約のチェックやキャンセルも本番と同じように試せます。
 *
 * 本番のファイルには一切手を入れていません。demo フォルダだけで完結します。
 */
window.MRDemo = (() => {
  'use strict';

  const KEY = 'modelroom-demo-v1';

  /* ───────── 本番の config.php と同じ設定値 ───────── */
  const CONF = {
    site: {
      name: 'ユニコモデルルーム',
      company: '株式会社フォレストヴィレッジ',
      tel: '000-000-0000',
      address: '〇〇県〇〇市〇〇町1-2-3',
    },
    booking: {
      slot_minutes: 60,
      start_times: ['10:00', '11:00', '13:00', '14:00', '15:00', '16:00'],
      open_days: [0, 1, 2, 3, 4, 5, 6],
      lead_hours: 3,
      horizon_days: 30,
      max_party_size: 6,
      buffer_before: 10,
      buffer_after: 10,
    },
    survey: [
      { key:'purpose', label:'ご検討の内容', type:'select', required:true,
        options:['新築戸建て','建て替え','リフォーム','土地探し','情報収集のみ'] },
      { key:'timing', label:'ご入居のご希望時期', type:'select', required:true,
        options:['3ヶ月以内','半年以内','1年以内','2年以上先','未定'] },
      { key:'budget', label:'ご予算の目安', type:'select', required:false,
        options:['〜2,000万円','2,000〜3,000万円','3,000〜4,000万円','4,000万円〜','未定'] },
      { key:'area', label:'ご希望のエリア', type:'text', required:false },
      { key:'source', label:'当社をお知りになったきっかけ', type:'select', required:false,
        options:['インターネット検索','SNS','チラシ','看板','ご紹介','その他'] },
      { key:'note', label:'ご質問・ご要望', type:'textarea', required:false },
    ],
  };

  // 打ち合わせでその場で変えた設定の置き場所。本番の config.php に相当する。
  const SETTINGS_KEY = 'modelroom-demo-settings';
  const DEFAULTS = JSON.parse(JSON.stringify({ booking: CONF.booking, survey: CONF.survey }));

  /* ───────── 保存領域 ───────── */

  const blank = () => ({ reservations: [], mails: [], keys: [], blocks: [], logs: [] });

  // プライベートウィンドウなどで localStorage が使えないときは、
  // そのページを開いている間だけメモリ上に保存して動かす。
  const canStore = (() => {
    try {
      localStorage.setItem('__mrdemo_test', '1');
      localStorage.removeItem('__mrdemo_test');
      return true;
    } catch (e) { return false; }
  })();
  let memory = null;

  function load() {
    if (!canStore) return memory ? JSON.parse(JSON.stringify(memory)) : blank();
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? Object.assign(blank(), JSON.parse(raw)) : blank();
    } catch (e) {
      return blank();
    }
  }
  function save(db) {
    if (!canStore) { memory = JSON.parse(JSON.stringify(db)); return; }
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { memory = db; }
  }

  /* ───────── 設定（打ち合わせ用のつまみ） ───────── */

  let settingsMemory = null;

  function loadSettings() {
    if (!canStore) return settingsMemory ? JSON.parse(JSON.stringify(settingsMemory)) : null;
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /** 保存されている設定を CONF に反映する。 */
  function applySettings(s) {
    if (!s) return;
    if (s.booking) Object.assign(CONF.booking, s.booking);
    if (Array.isArray(s.survey)) CONF.survey = s.survey;
  }

  function saveSettings(s) {
    settingsMemory = JSON.parse(JSON.stringify(s));
    if (canStore) {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* メモリだけで続ける */ }
    }
    applySettings(s);
  }

  function resetSettings() {
    settingsMemory = null;
    if (canStore) {
      try { localStorage.removeItem(SETTINGS_KEY); } catch (e) { /* 何もしない */ }
    }
    Object.assign(CONF.booking, JSON.parse(JSON.stringify(DEFAULTS.booking)));
    CONF.survey = JSON.parse(JSON.stringify(DEFAULTS.survey));
  }

  function currentSettings() {
    return JSON.parse(JSON.stringify({ booking: CONF.booking, survey: CONF.survey }));
  }

  /**
   * 営業時間と枠の長さから、枠の開始時刻を組み立てる。
   * 昼休みを指定すると、そこにかかる枠は作らない。
   */
  function buildStartTimes(open, close, minutes, lunchStart, lunchEnd) {
    const toMin = (t) => {
      const [h, m] = String(t).split(':').map(Number);
      return h * 60 + m;
    };
    const out = [];
    const end = toMin(close);
    const ls = lunchStart ? toMin(lunchStart) : null;
    const le = lunchEnd ? toMin(lunchEnd) : null;

    for (let t = toMin(open); t + minutes <= end; t += minutes) {
      const slotEnd = t + minutes;
      if (ls !== null && le !== null && t < le && ls < slotEnd) continue;  // 昼休みと重なる枠は作らない
      out.push(`${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
    }
    return out;
  }

  /** いまの設定を config.php に貼れる形の文字列にする。 */
  function exportConfig() {
    const b = CONF.booking;
    const times = b.start_times.map(t => `'${t}'`).join(',');
    const days  = b.open_days.join(',');

    const survey = CONF.survey.map(q => {
      const opts = (q.options && q.options.length)
        ? `,\n         'options'=>[` + q.options.map(o => `'${o}'`).join(',') + `]`
        : '';
      return `        ['key'=>'${q.key}', 'label'=>'${q.label}', 'type'=>'${q.type}', 'required'=>${q.required ? 'true' : 'false'}${opts}],`;
    }).join('\n');

    return `    // ───────── 予約枠 ─────────
    'booking' => [
        'slot_minutes'    => ${b.slot_minutes},
        'start_times'     => [${times}],
        'open_days'       => [${days}], // 0=日 … 6=土
        'lead_hours'      => ${b.lead_hours},
        'horizon_days'    => ${b.horizon_days},
        'max_party_size'  => ${b.max_party_size},
        'buffer_before'   => ${b.buffer_before},
        'buffer_after'    => ${b.buffer_after},
    ],

    // ───────── アンケート項目 ─────────
    'survey' => [
${survey}
    ],`;
  }

  /* ───────── 小道具 ───────── */

  const pad  = (n) => String(n).padStart(2, '0');
  const ymd  = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const at   = (date, time) => new Date(`${date}T${time}:00`);
  const stamp = () => {
    const d = new Date();
    return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const WD = ['日','月','火','水','木','金','土'];
  const dateLabel = (date) => {
    const d = at(date, '00:00');
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`;
  };
  const addMin = (d, m) => new Date(d.getTime() + m * 60000);

  function genCode() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 8; i++) {
      s += c[Math.floor(Math.random() * c.length)];
      if (i === 3) s += '-';
    }
    return s;
  }

  /** キャンセルURLの合言葉。本番の cancel_token と同じ役目。 */
  function genToken() {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  /** 本番の SwitchBot.php と同じ条件で6桁を作る。 */
  function genPasscode(db) {
    const used = db.reservations.filter(r => r.status === 'confirmed').map(r => r.passcode);
    for (let i = 0; i < 500; i++) {
      const p = String(Math.floor(100000 + Math.random() * 900000));
      if (/^(\d)\1{5}$/.test(p)) continue;
      if ('0123456789'.includes(p) || '9876543210'.includes(p)) continue;
      if (used.includes(p)) continue;
      return p;
    }
    return '123457';
  }

  function log(db, level, event, ref, message) {
    db.logs.unshift({ ts: stamp(), level, event, ref, message });
    db.logs = db.logs.slice(0, 300);
  }

  /* ───────── 空き枠の判定（Slots.php と同じ考え方） ───────── */

  function slotsForDate(db, date) {
    const b = CONF.booking;
    const day = at(date, '00:00').getDay();
    const closedDay = !b.open_days.includes(day);
    const allDayBlock = db.blocks.some(x => x.date === date && !x.start_time);
    const taken = db.reservations
      .filter(r => r.date === date && r.status === 'confirmed')
      .map(r => r.start_time);

    const now = new Date();
    const lead = addMin(now, b.lead_hours * 60);
    const horizon = addMin(now, b.horizon_days * 24 * 60);

    return b.start_times.map((st) => {
      const s = at(date, st);
      const e = addMin(s, b.slot_minutes);
      let reason = null;
      if (closedDay || allDayBlock) reason = 'closed';
      else if (taken.includes(st)) reason = 'booked';
      else if (db.blocks.some(x => x.date === date && x.start_time &&
               s < at(date, x.end_time) && at(date, x.start_time) < e)) reason = 'blocked';
      else if (s < lead) reason = 'too_soon';
      else if (s > horizon) reason = 'too_far';

      return {
        date,
        start_time: st,
        end_time: `${pad(e.getHours())}:${pad(e.getMinutes())}`,
        available: reason === null,
        reason,
      };
    });
  }

  function nextAvailable(db, fromDate, limit = 6) {
    const out = [];
    const base = at(fromDate, '00:00');
    for (let i = 0; i <= CONF.booking.horizon_days && out.length < limit; i++) {
      const d = new Date(base); d.setDate(d.getDate() + i);
      for (const s of slotsForDate(db, ymd(d))) {
        if (s.available) { out.push(s); if (out.length >= limit) break; }
      }
    }
    return out;
  }

  // 設定をその場で変えられるので、文面は毎回組み立てる
  function reasonText(reason) {
    switch (reason) {
      case 'booked':   return 'その時間はすでに他のお客様のご予約が入っております。';
      case 'blocked':  return 'その時間は都合により見学を承っておりません。';
      case 'closed':   return 'その日は休業日のため見学を承っておりません。';
      case 'too_soon': return `直前のご予約は承れません。${CONF.booking.lead_hours}時間以上先の時間をお選びください。`;
      case 'too_far':  return `ご予約は${CONF.booking.horizon_days}日先までとなります。`;
      default:         return 'ご指定の時間は見学枠として設けておりません。';
    }
  }

  /* ───────── メール（実際には送らず、管理卓に溜める） ───────── */

  function pushMail(db, to, subject, body) {
    db.mails.unshift({ id: Date.now() + Math.random(), ts: stamp(), to, subject, body });
    db.mails = db.mails.slice(0, 100);
  }

  function mailConfirmed(db, r) {
    const b = CONF.booking;
    const from = addMin(at(r.date, r.start_time), -b.buffer_before);
    const to   = addMin(at(r.date, r.end_time), b.buffer_after);
    const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    pushMail(db, r.email,
      `【${CONF.site.name}】ご見学の予約を承りました（${dateLabel(r.date)} ${r.start_time}〜）`,
`${r.name} 様

この度は ${CONF.site.name} のご見学をお申し込みいただき、誠にありがとうございます。
下記の内容でご予約を承りました。

──────────────────────────────
 ご予約番号 : ${r.code}
 ご見学日時 : ${dateLabel(r.date)} ${r.start_time} 〜 ${r.end_time}
 ご来場人数 : ${r.party_size} 名様
 所在地     : ${CONF.site.address}
──────────────────────────────

■ 入室用パスコード（${r.passcode}）

  玄関のキーパッドに次の番号を入力し、最後に丸ボタンを押してください。

        【 ${r.passcode} 】

  ・このパスコードは ${dateLabel(r.date)} ${hhmm(from)} 〜 ${hhmm(to)} の間だけ有効です。
  ・この時間以外は番号を入力しても解錠できません。

■ ご予約の変更・キャンセル
  こちらから承っております。
  cancel.html?code=${encodeURIComponent(r.code)}&t=${r.cancel_token}

${CONF.site.company}
${CONF.site.name}
TEL: ${CONF.site.tel}`);
  }

  function mailAdmin(db, r) {
    const lines = CONF.survey
      .map(q => (r.survey[q.key] ? `  ${q.label}: ${r.survey[q.key]}` : ''))
      .filter(Boolean).join('\n') || '  （回答なし）';

    pushMail(db, '管理者',
      `[予約] ${r.date} ${r.start_time} ${r.name} 様`,
`新しい見学予約が入りました。

 予約番号   : ${r.code}
 日時       : ${r.date} ${r.start_time} 〜 ${r.end_time}
 お名前     : ${r.name}（${r.kana}）
 人数       : ${r.party_size} 名
 メール     : ${r.email}
 電話       : ${r.tel}
 パスコード : ${r.passcode} / 状態: 発行済み

アンケート:
${lines}`);
  }

  /* ───────── 擬似 SwitchBot ───────── */

  function issueKey(db, r) {
    const b = CONF.booking;
    const from = addMin(at(r.date, r.start_time), -b.buffer_before);
    const to   = addMin(at(r.date, r.end_time), b.buffer_after);
    db.keys.unshift({
      id: 'demo-' + Math.floor(Math.random() * 1e8),
      code: r.code,
      passcode: r.passcode,
      from: from.toISOString(),
      to: to.toISOString(),
      status: 'issued',
    });
    log(db, 'info', 'switchbot.issued', r.code, 'パスコードを登録しました');
  }

  /** 玄関のキーパッドに番号を打ったときの判定。 */
  function tryUnlock(passcode, when) {
    const db = load();
    const t = when ? new Date(when) : new Date();
    const key = db.keys.find(k => k.passcode === passcode);

    if (!key) {
      log(db, 'warn', 'lock.denied', passcode, '未登録の番号');
      save(db);
      return { ok: false, message: 'この番号は登録されていません。' };
    }
    if (key.status !== 'issued') {
      log(db, 'warn', 'lock.denied', passcode, '無効化済みの番号');
      save(db);
      return { ok: false, message: 'この番号は無効になっています（キャンセル済み、または見学終了後）。' };
    }
    const from = new Date(key.from), to = new Date(key.to);
    if (t < from) {
      log(db, 'warn', 'lock.denied', key.code, '有効時間より前');
      save(db);
      return { ok: false, message: `まだ有効時間になっていません（${from.toLocaleString('ja-JP')} から有効）。` };
    }
    if (t > to) {
      log(db, 'warn', 'lock.denied', key.code, '有効時間を過ぎている');
      save(db);
      return { ok: false, message: `有効時間を過ぎています（${to.toLocaleString('ja-JP')} まで）。` };
    }
    log(db, 'info', 'lock.opened', key.code, '解錠しました');
    save(db);
    return { ok: true, message: '解錠しました。', reservation: db.reservations.find(r => r.code === key.code) };
  }

  /* ───────── 管理卓から呼ぶ操作 ───────── */

  /**
   * お客様がメールのリンクから行うキャンセル（cancel.php と同じ判定）。
   * 予約番号と合言葉（cancel_token）の両方が合っていないと受け付けない。
   */
  function cancelByToken(code, token) {
    const r = load().reservations.find(x => x.code === code);
    if (!r || r.cancel_token !== token) {
      return { ok: false, error: 'ご予約が確認できませんでした。お手数ですがお電話にてご連絡ください。' };
    }
    if (r.status === 'cancelled') return { ok: true, already: true, reservation: r };
    if (at(r.date, r.start_time) < new Date()) {
      return { ok: false, error: '開始時刻を過ぎたご予約はこちらからキャンセルできません。お電話にてご連絡ください。', reservation: r };
    }
    const res = cancel(code, 'customer');
    return Object.assign(res, { reservation: load().reservations.find(x => x.code === code) });
  }

  function findByCode(code) {
    return load().reservations.find(x => x.code === code) || null;
  }

  function cancel(code, by = 'デモ管理卓') {
    const db = load();
    const r = db.reservations.find(x => x.code === code);
    if (!r) return { ok: false, error: '見つかりません。' };
    if (r.status === 'cancelled') return { ok: true, already: true };

    r.status = 'cancelled';
    db.keys.filter(k => k.code === code).forEach(k => { k.status = 'revoked'; });
    log(db, 'info', 'reservation.cancelled', code, `キャンセル（${by}）`);
    pushMail(db, r.email, `【${CONF.site.name}】ご予約をキャンセルいたしました`,
`${r.name} 様

下記のご予約をキャンセルいたしました。
発行済みのパスコードは無効になっております。

 ご予約番号 : ${r.code}
 ご見学日時 : ${dateLabel(r.date)} ${r.start_time} 〜 ${r.end_time}`);
    save(db);
    return { ok: true };
  }

  function reset() {
    memory = null;
    try { localStorage.removeItem(KEY); } catch (e) { /* 何もしない */ }
  }

  /** 動作確認しやすいように、明日の予約を1件だけ入れておく。 */
  function seed() {
    const db = load();
    if (db.reservations.length) return;
    const d = new Date(); d.setDate(d.getDate() + 1);
    const date = ymd(d);
    const slot = slotsForDate(db, date).find(s => s.available);
    if (!slot) return;

    const r = {
      code: genCode(), status: 'confirmed',
      date, start_time: slot.start_time, end_time: slot.end_time,
      name: '見本 花子', kana: 'ミホン ハナコ',
      email: 'sample@example.com', tel: '090-0000-0000', party_size: 2,
      survey: { purpose: '新築戸建て', timing: '半年以内', area: '〇〇市南区' },
      passcode: genPasscode(db), cancel_token: genToken(), created_at: stamp(),
    };
    db.reservations.push(r);
    issueKey(db, r);
    mailConfirmed(db, r);
    save(db);
  }

  /* ───────── fetch を横取りして擬似サーバーにする ───────── */

  const realFetch = window.fetch.bind(window);

  window.fetch = async (url, opts) => {
    const u = String(url);
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

    // デモ以外のリクエストは素通し
    if (!u.includes('api/')) return realFetch(url, opts);

    await new Promise(res => setTimeout(res, 250));   // 通信の間をそれらしく

    if (u.includes('api/form.php')) {
      return reply({ ok: true, site: CONF.site, booking: CONF.booking, survey: CONF.survey });
    }

    if (u.includes('api/slots.php')) {
      const q = new URLSearchParams(u.split('?')[1] || '');
      const db = load();
      const from = q.get('from') || ymd(new Date());
      const days = Math.max(1, Math.min(62, Number(q.get('days') || 7)));
      const out = [];
      for (let i = 0; i < days; i++) {
        const d = at(from, '00:00'); d.setDate(d.getDate() + i);
        const date = ymd(d);
        const slots = slotsForDate(db, date);
        out.push({ date, weekday: WD[d.getDay()], slots,
                   open_count: slots.filter(s => s.available).length });
      }
      return reply({ ok: true, today: ymd(new Date()), days: out });
    }

    if (u.includes('api/reserve.php')) {
      const p = JSON.parse(opts.body);
      const db = load();

      // 自動投稿よけ
      if ((p.website || '').trim() !== '') {
        return reply({ ok: true, reservation: { code: 'RECEIVED', date: p.date,
          start_time: p.start_time, end_time: p.start_time, name: p.name,
          party_size: p.party_size, passcode_issued: false, email: p.email } });
      }

      const slot = slotsForDate(db, p.date).find(s => s.start_time === p.start_time);
      if (!slot || !slot.available) {
        log(db, 'warn', 'reservation.rejected', `${p.date} ${p.start_time}`,
            slot ? slot.reason : 'invalid');
        save(db);
        return reply({
          ok: false,
          reason: slot ? slot.reason : 'invalid',
          error: reasonText(slot ? slot.reason : "invalid"),
          alternatives: nextAvailable(db, p.date),
        }, 409);
      }

      const r = {
        code: genCode(), status: 'confirmed',
        date: slot.date, start_time: slot.start_time, end_time: slot.end_time,
        name: p.name, kana: p.kana, email: p.email, tel: p.tel,
        party_size: p.party_size, survey: p.survey || {},
        passcode: genPasscode(db), cancel_token: genToken(), created_at: stamp(),
      };
      db.reservations.push(r);
      log(db, 'info', 'reservation.created', r.code, `${r.date} ${r.start_time} ${r.name} 様`);
      issueKey(db, r);
      mailConfirmed(db, r);
      mailAdmin(db, r);
      save(db);

      return reply({ ok: true, reservation: {
        code: r.code, date: r.date, start_time: r.start_time, end_time: r.end_time,
        name: r.name, party_size: r.party_size, passcode_issued: true, email: r.email,
      }});
    }

    return reply({ ok: false, error: 'デモでは未対応です。' }, 404);
  };

  applySettings(loadSettings());   // 保存された設定があれば先に反映してから
  seed();

  return {
    load, save, reset, cancel, cancelByToken, findByCode, tryUnlock, slotsForDate,
    CONF, dateLabel, ymd, reasonText,
    // 打ち合わせ用の設定まわり
    loadSettings, saveSettings, resetSettings, currentSettings, buildStartTimes, exportConfig, DEFAULTS,
  };
})();
