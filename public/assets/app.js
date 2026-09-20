/* モデルルーム見学予約フォーム */
(() => {
  'use strict';

  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const state = {
    conf: null,
    rangeFrom: todayStr(),
    days: 7,
    slot: null,     // {date, start_time, end_time}
    payload: null,
  };

  const WD = ['日','月','火','水','木','金','土'];

  function todayStr(d = new Date()) {
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }
  function shift(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return todayStr(d);
  }
  function label(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`;
  }

  async function api(path, options) {
    const res  = await fetch(path, options);
    const data = await res.json().catch(() => ({ ok: false, error: '応答を読み取れませんでした。' }));
    return { status: res.status, data };
  }

  /* ───────── 初期化 ───────── */

  async function init() {
    const { data } = await api('api/form.php');
    if (!data.ok) { $('#calendar').innerHTML = '<p class="notice warn">読み込みに失敗しました。</p>'; return; }
    state.conf = data;

    $('#siteName').textContent = data.site.name + ' 見学予約';
    $('#foot').textContent = `${data.site.company}　${data.site.address}　TEL: ${data.site.tel}`;

    const sel = $('#party_size');
    for (let i = 1; i <= data.booking.max_party_size; i++) {
      sel.insertAdjacentHTML('beforeend', `<option value="${i}">${i} 名</option>`);
    }

    buildSurvey(data.survey);
    bindEnterNavigation();
    await loadSlots();
  }

  function buildSurvey(survey) {
    const box = $('#surveyFields');
    box.innerHTML = survey.map((q) => {
      const id  = 'sv_' + q.key;
      const req = q.required ? ' <span class="req">必須</span>' : '';
      let input;
      if (q.type === 'select') {
        const opts = ['<option value="">選択してください</option>']
          .concat(q.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`)).join('');
        input = `<select id="${id}" data-key="${esc(q.key)}" class="survey">${opts}</select>`;
      } else if (q.type === 'textarea') {
        input = `<textarea id="${id}" data-key="${esc(q.key)}" class="survey" rows="4" maxlength="1000"></textarea>`;
      } else {
        input = `<input type="text" id="${id}" data-key="${esc(q.key)}" class="survey" maxlength="200">`;
      }
      return `<div class="field"><label for="${id}">${esc(q.label)}${req}</label>${input}</div>`;
    }).join('');
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  /* ───────── ステップ1: 空き枠 ───────── */

  async function loadSlots() {
    $('#calendar').innerHTML = '<p class="hint">空き状況を読み込んでいます…</p>';
    const { data } = await api(`api/slots.php?from=${state.rangeFrom}&days=${state.days}`);
    if (!data.ok) { $('#calendar').innerHTML = '<p class="notice warn">空き状況を取得できませんでした。</p>'; return; }
    renderCalendar(data.days);
  }

  function renderCalendar(days) {
    $('#rangeLabel').textContent = `${label(days[0].date)} 〜 ${label(days[days.length - 1].date)}`;
    $('#prevWeek').disabled = state.rangeFrom <= todayStr();

    $('#calendar').innerHTML = days.map((d) => {
      const cls = d.date === todayStr() ? ' today' : '';
      const slots = d.slots.length
        ? d.slots.map((s) => {
            if (s.available) {
              return `<button type="button" class="slot free" data-date="${s.date}" data-start="${s.start_time}" data-end="${s.end_time}">${s.start_time}</button>`;
            }
            const kind = s.reason === 'booked' ? 'busy' : 'na';
            const mark = s.reason === 'booked' ? '×' : '−';
            return `<span class="slot ${kind}" title="${esc(reasonText(s.reason))}">${s.start_time} ${mark}</span>`;
          }).join('')
        : '<span class="slot na">−</span>';
      return `<div class="day${cls}">
        <div class="dayhead"><span class="date">${label(d.date)}</span>
        <span class="count">${d.open_count ? `空き ${d.open_count}` : '空きなし'}</span></div>
        <div class="slots">${slots}</div></div>`;
    }).join('');

    $$('#calendar .slot.free').forEach((b) => b.addEventListener('click', () => {
      state.slot = { date: b.dataset.date, start_time: b.dataset.start, end_time: b.dataset.end };
      $('#chosenSlot').textContent = `ご希望日時： ${label(state.slot.date)} ${state.slot.start_time} 〜 ${state.slot.end_time}`;
      go(2);
    }));
  }

  function reasonText(reason) {
    return ({
      booked:   'すでにご予約が入っています',
      blocked:  'この時間は受付しておりません',
      closed:   '休業日です',
      too_soon: '直前のご予約は承れません',
      too_far:  '受付期間外です',
    })[reason] || 'ご予約いただけません';
  }

  /* ───────── 画面遷移 ───────── */

  function go(step) {
    [1, 2, 3, 4].forEach((n) => $('#step' + n).classList.toggle('hidden', n !== step));
    $$('#steps li').forEach((li) => li.classList.toggle('on', Number(li.dataset.step) <= step));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* Enterキーで次の項目へ進む（表示だけの欄は飛ばす） */
  function bindEnterNavigation() {
    $('#form').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      const fields = $$('#form input, #form select, #form textarea')
        .filter((el) => !el.disabled && !el.readOnly && el.type !== 'hidden' && el.offsetParent !== null && el.tabIndex !== -1);
      const i = fields.indexOf(e.target);
      if (i >= 0 && i < fields.length - 1) fields[i + 1].focus();
      else $('#form').requestSubmit();
    });
  }

  /* ───────── ステップ2 → 3 ───────── */

  function collect() {
    const survey = {};
    $$('.survey').forEach((el) => { survey[el.dataset.key] = el.value.trim(); });
    return {
      name:       $('#name').value.trim(),
      kana:       $('#kana').value.trim(),
      email:      $('#email').value.trim(),
      tel:        $('#tel').value.trim(),
      party_size: Number($('#party_size').value),
      date:       state.slot.date,
      start_time: state.slot.start_time,
      agree:      $('#agree').checked,
      website:    $('#website').value,
      survey,
    };
  }

  function validateLocal(p) {
    const errs = [];
    if (!p.name)  errs.push('お名前をご入力ください。');
    if (!p.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) errs.push('メールアドレスをご確認ください。');
    if (!p.agree) errs.push('個人情報の取り扱いについてご同意ください。');
    state.conf.survey.forEach((q) => {
      if (q.required && !p.survey[q.key]) errs.push(`${q.label}をご入力ください。`);
    });
    return errs;
  }

  function renderConfirm(p) {
    const rows = [
      ['ご見学日時', `${label(p.date)} ${state.slot.start_time} 〜 ${state.slot.end_time}`],
      ['お名前', p.name],
      ['フリガナ', p.kana],
      ['メールアドレス', p.email],
      ['お電話番号', p.tel],
      ['ご来場人数', p.party_size + ' 名'],
    ];
    state.conf.survey.forEach((q) => rows.push([q.label, p.survey[q.key]]));
    $('#confirmList').innerHTML = rows
      .filter(([, v]) => String(v || '') !== '')
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v).replace(/\n/g, '<br>')}</dd>`).join('');
  }

  /* ───────── 送信 ───────── */

  async function submit() {
    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = '送信しています…';
    $('#submitError').hidden = true;

    const { status, data } = await api('api/reserve.php', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(state.payload),
    });

    btn.disabled = false;
    btn.textContent = 'この内容で予約する';

    if (data.ok) { renderDone(data.reservation); go(4); return; }

    // 枠が埋まっていた場合は代替候補を出す
    let msg = data.error || 'ご予約を受け付けられませんでした。';
    if (status === 409 && Array.isArray(data.alternatives) && data.alternatives.length) {
      msg += '\n空いているお時間：' +
        data.alternatives.slice(0, 6).map((s) => `${label(s.date)} ${s.start_time}`).join(' / ');
      await loadSlots();
    }
    if (data.fields) msg = Object.values(data.fields).join('\n');

    const box = $('#submitError');
    box.textContent = msg;
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderDone(r) {
    $('#doneList').innerHTML = [
      ['ご予約番号', r.code],
      ['ご見学日時', `${label(r.date)} ${r.start_time} 〜 ${r.end_time}`],
      ['お名前', r.name + ' 様'],
      ['ご来場人数', r.party_size + ' 名'],
    ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

    $('#doneNote').textContent = r.passcode_issued
      ? `入室用のパスコードを ${r.email} 宛にお送りしました。当日は玄関のキーパッドにその番号をご入力ください。`
      : `ご予約を承りました。入室用パスコードは追って ${r.email} 宛にお送りいたします。`;
  }

  /* ───────── イベント ───────── */

  $('#prevWeek').addEventListener('click', () => {
    const p = shift(state.rangeFrom, -state.days);
    state.rangeFrom = p < todayStr() ? todayStr() : p;
    loadSlots();
  });
  $('#nextWeek').addEventListener('click', () => {
    state.rangeFrom = shift(state.rangeFrom, state.days);
    loadSlots();
  });
  $('#backTo1').addEventListener('click', () => go(1));
  $('#backTo2').addEventListener('click', () => go(2));

  $('#form').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = collect();
    const errs = validateLocal(p);
    if (errs.length) { alert(errs.join('\n')); return; }
    state.payload = p;
    renderConfirm(p);
    go(3);
  });

  $('#submitBtn').addEventListener('click', submit);

  init();
})();
