/* 建設案件タスク管理 試作：画面 */
'use strict';

const KEY = 'ctask-proto-v3';
let S = load() || buildSeed();
function load() { try { const j = localStorage.getItem(KEY); if (!j) return null; const s = JSON.parse(j); return s && s.v === 3 && s.seedDay === TODAY ? s : null; } catch (e) { return null; } }
function save() { S.seedDay = S.seedDay || TODAY; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* 保存できない環境でも動かす */ } }
S.seedDay = S.seedDay || TODAY;

const ui = { view: 'login', params: {}, stack: [], tf: 'today', tfUser: '', tfDept: '', tfProj: '', q: '', pq: '', pk: 'all', ptab: 'tasks', rtab: 'recv', calM: TODAY.slice(0, 8) + '01', calScope: 'me', calSel: TODAY, gp: null, allAp: false };
try { const m = localStorage.getItem(KEY + '-me'); if (m && S.users.some(u => u.id === m)) { S.me = m; ui.view = 'home'; } } catch (e) { }

/* ---------- helpers ---------- */
const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const U = id => S.users.find(u => u.id === id) || { id, name: '（未設定）', dept: '', role: 'member' };
const uname = id => id ? U(id).name : '未設定';
const sname = id => id ? U(id).name.split(' ')[0] : '未設定';
const P = id => S.projects.find(p => p.id === id);
const TK = id => S.tasks.find(t => t.id === id);
const deptName = id => (S.depts.find(d => d.id === id) || { name: '—' }).name;
const me = () => U(S.me);
const optLabel = id => { const neg = id[0] === '!'; const o = S.options.find(x => x.id === (neg ? id.slice(1) : id)); if (!o) return id; const g = S.groups.find(g => g.id === o.group); const base = (['土地あり', '土地なし', '住宅', '施設', '公共工事', '小口工事', '新築', '改修', '修繕', '住宅ローン', '現金', 'セルコホーム案件', 'CLT案件', '土地購入', '借地', '仲介'].includes(o.label)) ? o.label : g.name + '：' + o.label; return neg ? base + ' 以外' : base; };
const isOpen = t => t.status !== '完了' && t.status !== '取消';
const byDue = (a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0;
const mine = t => t.owner === S.me || t.collaborators.includes(S.me);
const initials = id => (U(id).name || '?')[0];
const yen = n => n == null ? '—' : '¥' + n.toLocaleString('ja-JP');

/* ---------- 権限 ---------- */
const pv = (key, u) => ((S.perms[(u || me()).role] || {})[key]) || 'none';
const isPM = p => p && p.pm === S.me;
const isDeptMgr = dept => me().role === 'manager' && me().dept === dept;
const inProject = p => [p.sales, p.design, p.construction, p.pm].includes(S.me) || S.tasks.some(t => t.pid === p.id && mine(t));
function canUpdate(t) { const v = pv('task_update_own'); if (v === 'all') return true; if (v === 'none') return false; return mine(t) || isPM(P(t.pid)); }
function canEdit(t) { const v = pv('assign_change'); if (v === 'all') return true; if (v === 'none') return false; return isPM(P(t.pid)) || isDeptMgr(t.dept); }
function dueMode(t) { const v = pv('due_change'); if (v === 'all') return 'direct'; if (v === 'none') return 'none'; if (v === 'rel') return (isPM(P(t.pid)) || isDeptMgr(t.dept)) ? 'direct' : 'apply'; return 'apply'; }
const canApprove = approver => approver === S.me || pv('approve') === 'all';
function canCreateProject() { const v = pv('project_create'); return v === 'all' || (v === 'rel' && me().dept === 'sales'); }
function canSeeConf(p) { const v = pv('view_confidential'); if (v === 'all') return true; if (v === 'none') return false; return isPM(p) || (me().role === 'manager' && [p.sales, p.design, p.construction].some(id => id && U(id).dept === me().dept)); }
function addMode(p, ownerId) {
  if (ownerId === S.me) { const v = pv('task_add_self'); return v === 'all' || (v === 'rel' && inProject(p)) ? 'direct' : 'none'; }
  const v = pv('task_add_others');
  if (v === 'all') return 'direct';
  if (v === 'rel') return (isPM(p) || (me().role === 'manager' && U(ownerId).dept === me().dept)) ? 'direct' : 'request';
  return v === 'apply' ? 'request' : 'none';
}
const canMasterAll = () => pv('master_edit') === 'all';
const canMasterTpl = t => pv('master_edit') === 'all' || (pv('master_edit') === 'rel' && t.dept === me().dept);
const deptManager = dept => (S.users.find(u => u.dept === dept && u.role === 'manager' && u.active) || {}).id;

/* ---------- 記録・通知 ---------- */
function log(o) { act(S, { uid: S.me, ...o }); }
function notify(uids, level, text, link) {
  const set = new Set(uids.filter(Boolean)); set.delete(S.me);
  for (const uid of set) S.notifications.push({ id: nid(S, 'n'), uid, level, text, link, at: Date.now(), read: false });
  return set.size;
}
const people = t => [t.owner, ...t.collaborators, ...t.watchers];

/* ---------- 警告判定（状態とは別に自動判定） ---------- */
function alertOf(t) {
  if (!isOpen(t)) return null;
  if (!t.due) return { c: 'al-tbd', l: '日付未確定' };
  const d = diffDays(t.due, TODAY);
  if (d < 0) return { c: 'al-over', l: '期限超過 ' + (-d) + '日' };
  if (t.preds.some(pid => { const p = TK(pid); return p && isOpen(p) && p.due && p.due < TODAY; })) return { c: 'al-late', l: '前工程遅延' };
  if (t.start && t.start < TODAY && t.status === '未着手') return { c: 'al-late', l: '着手遅れ' };
  if (d <= 3) return { c: 'al-soon', l: d === 0 ? '今日締切' : 'あと' + d + '日' };
  return null;
}
const stChip = s => `<span class="chip st-${esc(s)}">${esc(s)}</span>`;
const alChip = t => { const a = alertOf(t); return a ? `<span class="chip ${a.c}">${a.l}</span>` : ''; };

/* ---------- アイコン ---------- */
const IC = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  proj: '<path d="M3 21V9l6-4 6 4v12"/><path d="M15 21V12h6v9"/><path d="M7 12h4M7 16h4M2 21h20"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  gantt: '<path d="M4 5h8M8 10h9M6 15h7M11 20h9"/>',
  req: '<path d="M4 12l16-8-6 16-3-7z"/>',
  appr: '<path d="M5 12l4 4 10-10"/><path d="M3 20h18"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  dec: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12l2 2 4-4"/>',
  load: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2.4.6 4 2.8 4 6"/>',
  log: '<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="9"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  menu: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  tpl: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  cond: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'
};
const ico = (n, cls) => `<svg class="${cls || 'ico'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;

/* ---------- 件数 ---------- */
function pendingForMe() {
  const reqs = S.requests.filter(r => ['sent', 'review', 'escalated'].includes(r.status) && r.receiver === S.me);
  const chg = S.changes.filter(c => c.status === 'pending' && c.approver === S.me);
  const aps = S.approvals.filter(a => a.status === 'pending' && a.approver === S.me);
  return { reqs, chg, aps, n: reqs.length + chg.length + aps.length };
}
const unread = () => S.notifications.filter(n => n.uid === S.me && !n.read).length;

/* ---------- ナビゲーション ---------- */
const NAV = [
  ['', 'home', 'ホーム', 'home'], ['', 'tasks', 'タスク', 'tasks'], ['', 'projects', '案件', 'proj'],
  ['', 'calendar', 'カレンダー', 'cal'], ['', 'gantt', '工程表', 'gantt'], ['', 'requests', '依頼', 'req'],
  ['', 'approvals', '承認待ち', 'appr'], ['', 'notices', '通知', 'bell'], ['', 'decisions', '決定事項', 'dec'],
  ['責任者', 'load', '部署別の負荷', 'load'],
  ['管理', 'admin-cond', '案件条件', 'cond'], ['管理', 'admin-tpl', 'タスクテンプレート', 'tpl'],
  ['管理', 'admin-perm', '権限設定', 'shield'], ['管理', 'admin-users', 'ユーザー・部署', 'users'], ['管理', 'admin-log', '操作ログ', 'log'],
  ['', 'settings', '個人設定', 'gear']
];
const showNav = v => {
  if (v === 'load') return ['manager', 'exec', 'admin'].includes(me().role);
  if (v.startsWith('admin-')) return ['manager', 'exec', 'admin'].includes(me().role);
  return true;
};
const TITLES = { home: 'ホーム', tasks: 'タスク一覧', projects: '案件一覧', wizard: '案件登録', project: '案件詳細', task: 'タスク詳細', calendar: 'カレンダー', gantt: '工程表', requests: '依頼一覧', 'request-new': '依頼を作成', request: '依頼の詳細', approvals: '承認待ち', notices: '通知', decisions: '決定事項', load: '部署別の負荷', settings: '個人設定', 'change-new': '工程変更・期限変更', change: '工程変更の確認', 'admin-cond': '案件条件マスタ', 'admin-tpl': 'タスクテンプレート・生成ルール', 'admin-perm': '権限設定', 'admin-users': 'ユーザー・部署', 'admin-log': '操作ログ', menu: 'メニュー' };

function go(view, params, noPush) {
  if (!noPush && ui.view !== 'login') ui.stack.push({ view: ui.view, params: ui.params });
  if (ui.stack.length > 30) ui.stack.shift();
  ui.view = view; ui.params = params || {};
  closeSheet(); render(); window.scrollTo(0, 0);
}
function back() { const s = ui.stack.pop(); if (s) { ui.view = s.view; ui.params = s.params; render(); } else go('home', {}, true); }

/* ---------- 描画 ---------- */
function render() {
  save();
  if (ui.view === 'login' || !S.me) { $app.innerHTML = vLogin(); return; }
  const V = VIEWS[ui.view] || VIEWS.home;
  const pend = pendingForMe().n, un = unread();
  const cnt = { approvals: pend, notices: un, requests: S.requests.filter(r => r.receiver === S.me && ['sent', 'review', 'escalated'].includes(r.status)).length };
  let side = '', lastSec = null;
  for (const [sec, v, label, ic] of NAV) {
    if (!showNav(v)) continue;
    if (sec !== lastSec && sec) side += `<div class="nav-sec">${sec}</div>`;
    lastSec = sec;
    const on = ui.view === v || (v === 'projects' && ['project', 'wizard'].includes(ui.view)) || (v === 'tasks' && ui.view === 'task') || (v === 'requests' && ['request', 'request-new'].includes(ui.view)) || (v === 'approvals' && ['change', 'change-new'].includes(ui.view));
    side += `<button class="nav-item${on ? ' on' : ''}" data-a="nav" data-v="${v}">${ico(ic)}<span>${label}</span>${cnt[v] ? `<span class="chip lv-important cnt num">${cnt[v]}</span>` : ''}</button>`;
  }
  const u = me();
  const body = V();
  const tab = (v, label, ic, n) => `<button class="tab${(ui.view === v || (v === 'approvals' && ['requests', 'request', 'change', 'change-new', 'request-new'].includes(ui.view)) || (v === 'tasks' && ui.view === 'task') || (v === 'menu' && !['home', 'tasks', 'task', 'approvals', 'requests', 'request', 'change', 'change-new', 'request-new', 'notices'].includes(ui.view))) ? ' on' : ''}" data-a="nav" data-v="${v}">${ico(ic)}<span>${label}</span>${n ? `<span class="dot-badge">${n}</span>` : ''}</button>`;
  $app.innerHTML = `
  <div class="shell">
    <aside class="side">
      <div class="brand"><div class="brand-mark">工</div><div><div class="brand-name">案件タスク管理</div><div class="brand-sub">試作版 PROTOTYPE</div></div></div>
      ${side}
      <div class="side-foot">
        <div class="me-card"><div class="avatar">${esc(initials(u.id))}</div><div><div style="font-weight:700">${esc(u.name)}</div><div class="small muted">${esc(deptName(u.dept))}・${esc(ROLES[u.role])}</div></div></div>
        <label class="f"><span>試作用：ログインユーザー切替</span><select class="inp" id="sw-user" data-c="switchUser">${S.users.filter(x => x.active).map(x => `<option value="${x.id}"${x.id === u.id ? ' selected' : ''}>${esc(x.name)}（${esc(deptName(x.dept))}・${esc(ROLES[x.role])}）</option>`).join('')}</select></label>
        <button class="btn sm ghost" data-a="logout">ログアウト</button>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn back-btn" data-a="back" aria-label="戻る">${ui.view === 'home' ? '<span class="brand-mark" style="width:28px;height:28px;font-size:13px">工</span>' : ico('back')}</button>
        <h1>${esc(V.title ? V.title() : TITLES[ui.view] || '')}</h1>
        <button class="icon-btn" data-a="nav" data-v="notices" aria-label="通知">${ico('bell')}${un ? `<span class="dot-badge">${un}</span>` : ''}</button>
      </header>
      <main class="content">${body}</main>
    </div>
    <nav class="tabbar">
      ${tab('home', 'ホーム', 'home')}${tab('tasks', 'タスク', 'tasks')}${tab('approvals', '依頼・承認', 'appr', pend)}${tab('notices', '通知', 'bell', un)}${tab('menu', 'メニュー', 'menu')}
    </nav>
  </div>`;
  if (V.after) V.after();
}

/* ---------- sheet / toast ---------- */
function openSheet(title, body, foot, wide) {
  $sheet.innerHTML = `<div class="scrim" data-a="scrim"><div class="sheet${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sheet-h"><h2>${esc(title)}</h2><button class="icon-btn" data-a="closeSheet" aria-label="閉じる">${ico('x')}</button></div><div class="sheet-b">${body}</div>${foot ? `<div class="sheet-f">${foot}</div>` : ''}</div></div>`;
  const f = $sheet.querySelector('input:not([type=checkbox]),textarea,select'); if (f && window.innerWidth > 860) f.focus();
}
function closeSheet() { $sheet.innerHTML = ''; }
let toastT;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 3200);
}
function pushBanner(title, body) {
  const el = document.createElement('div'); el.className = 'push';
  el.innerHTML = `<div class="brand-mark">工</div><div><div class="ph"><span>案件タスク管理</span><span>今</span></div><div class="pt">${esc(title)}</div><div class="pb">${esc(body)}</div></div>`;
  document.body.appendChild(el); setTimeout(() => el.remove(), 4500);
}
const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
const userOpts = (sel, filter, blank) => (blank ? `<option value="">${blank}</option>` : '') + S.users.filter(u => u.active && u.role !== 'viewer' && (!filter || filter(u))).map(u => `<option value="${u.id}"${u.id === sel ? ' selected' : ''}>${esc(u.name)}（${esc(deptName(u.dept))}）</option>`).join('');
const deptOpts = sel => S.depts.map(d => `<option value="${d.id}"${d.id === sel ? ' selected' : ''}>${esc(d.name)}</option>`).join('');

/* ---------- 共通部品：タスク行 ---------- */
function trow(t, opt) {
  opt = opt || {};
  const p = P(t.pid); const over = t.due && t.due < TODAY && isOpen(t);
  return `<button class="trow" data-a="task" data-id="${t.id}">
    <span class="p">${opt.noProj ? esc(deptName(t.dept)) : esc(p.name)}</span>
    <span class="n">${esc(t.name)}</span>
    <span class="w">${esc(uname(t.owner))}<span class="d-m${over ? ' bad' : ''}">${fmtD(t.due)}</span></span>
    <span class="d${over ? ' bad' : ''}">${fmtD(t.due)}</span>
    <span class="s">${stChip(t.status)}</span>
    <span class="a">${alChip(t)}</span>
  </button>`;
}
const thead = noProj => `<div class="trow thead" aria-hidden="true"><span>${noProj ? '担当部署' : '案件'}</span><span>タスク</span><span>担当者</span><span>締切日</span><span>状態</span><span>警告</span></div>`;
function tlist(tasks, opt) { return tasks.length ? `<div class="tlist">${thead(opt && opt.noProj)}${tasks.map(t => trow(t, opt)).join('')}</div>` : `<div class="empty">${(opt && opt.empty) || '該当するタスクはありません'}</div>`; }

/* ==========================================================
 * 画面
 * ========================================================== */
const VIEWS = {};

/* 1. ログイン */
function vLogin() {
  return `<div class="login"><div class="login-card">
    <div class="brand" style="padding:0"><div class="brand-mark">工</div><div><div class="brand-name">案件タスク管理</div><div class="brand-sub">試作版 PROTOTYPE</div></div></div>
    <form class="stack" data-f="login">
      <label class="f"><span>社内ID（メールアドレス）</span><input class="inp" id="lg-id" autocomplete="username" value="k.sato@example.co.jp"></label>
      <label class="f"><span>パスワード</span><input class="inp" id="lg-pw" type="password" autocomplete="current-password" value="demo-password"></label>
      <button class="btn primary block" type="submit">ログイン</button>
    </form>
    <div class="hint info">試作用：下の一覧から、どの立場で操作するかを選べます。立場によってボタンや承認の可否が変わります。</div>
    <div class="ulist">${S.users.filter(u => u.active).map(u => `<button data-a="loginAs" data-id="${u.id}"><span class="avatar sm">${esc(initials(u.id))}</span><span>${esc(u.name)}<br><span class="small muted">${esc(deptName(u.dept))}</span></span><span class="chip lv-normal r">${esc(ROLES[u.role])}</span></button>`).join('')}</div>
  </div></div>`;
}

/* 2. ホーム */
VIEWS.home = function () {
  const u = me();
  const my = S.tasks.filter(t => mine(t) && isOpen(t));
  const today = my.filter(t => t.due && t.due <= TODAY).sort(byDue);
  const week = my.filter(t => t.due && t.due > TODAY && t.due <= T(7)).sort(byDue);
  const over = my.filter(t => t.due && t.due < TODAY);
  const pend = pendingForMe();
  const reqIn = S.requests.filter(r => r.receiver === S.me && ['sent', 'review', 'escalated'].includes(r.status));
  const drafts = S.tasks.filter(t => t.status === '下書き' && (t.owner === S.me || isPM(P(t.pid))));
  const notes = S.notifications.filter(n => n.uid === S.me && !n.read && n.level !== 'normal').sort((a, b) => b.at - a.at).slice(0, 4);
  const hour = new Date().getHours();
  const greet = hour < 11 ? 'おはようございます' : hour < 18 ? 'お疲れさまです' : 'お疲れさまです';
  let out = `<div class="stack" style="gap:4px"><h2>${greet}、${esc(sname(u.id))}さん</h2><div class="muted small">${fmtD(TODAY, true)}　${esc(deptName(u.dept))}・${esc(ROLES[u.role])}</div></div>`;
  if (u.role === 'viewer') out += `<div class="hint">閲覧専用アカウントです。案件とタスクの閲覧のみできます。</div>`;
  out += `<div class="stats">
    <button class="stat${today.length ? ' warn' : ''}" data-a="taskFilter" data-f="today"><span class="v">${today.length}</span><span class="l">今日やること</span></button>
    <button class="stat" data-a="taskFilter" data-f="week"><span class="v">${week.length}</span><span class="l">今週の締切</span></button>
    <button class="stat${over.length ? ' bad' : ''}" data-a="taskFilter" data-f="overdueMine"><span class="v">${over.length}</span><span class="l">自分の期限超過</span></button>
    <button class="stat${pend.n ? ' warn' : ''}" data-a="nav" data-v="approvals"><span class="v">${pend.chg.length + pend.aps.length}</span><span class="l">承認待ち</span></button>
    <button class="stat${reqIn.length ? ' warn' : ''}" data-a="nav" data-v="requests"><span class="v">${reqIn.length}</span><span class="l">届いた依頼</span></button>
  </div>`;
  if (notes.length) out += `<section class="panel"><div class="panel-h"><h2>重要なお知らせ</h2><button class="btn sm ghost" data-a="nav" data-v="notices">すべて見る</button></div>${notes.map(nItem).join('')}</section>`;
  out += `<div class="grid2">
    <section class="panel"><div class="panel-h"><h2>今日やること</h2><span class="muted small">締切が今日以前</span></div>${tlist(today, { empty: '今日締切のタスクはありません' })}</section>
    <section class="panel"><div class="panel-h"><h2>今週の締切</h2><span class="muted small">${fmtD(T(1))}〜${fmtD(T(7))}</span></div>${tlist(week, { empty: '今週締切のタスクはありません' })}</section>
  </div>`;
  if (drafts.length) out += `<section class="panel"><div class="panel-h"><h2>日付未確定・下書きのタスク</h2><span class="chip al-tbd">${drafts.length}件</span></div><div class="hint warn">基準日（契約日・着工日など）が決まると締切日が自動計算されます。締切と担当者を確認して「正式タスクにする」を押すと運用開始になります。</div>${tlist(drafts.slice(0, 6))}${drafts.length > 6 ? `<button class="btn sm ghost" data-a="taskFilter" data-f="draft">残り${drafts.length - 6}件を見る</button>` : ''}</section>`;
  if (['manager', 'exec', 'admin'].includes(u.role)) out += `<section class="panel"><div class="panel-h"><h2>部署別の状況</h2><button class="btn sm ghost" data-a="nav" data-v="load">詳しく見る</button></div>${loadBars()}</section>`;
  return out;
};

function loadBars() {
  const rows = S.depts.filter(d => ['sales', 'design', 'const'].includes(d.id)).map(d => {
    const ts = S.tasks.filter(t => t.dept === d.id && isOpen(t) && t.status !== '下書き');
    const over = ts.filter(t => t.due < TODAY).length;
    const soon = ts.filter(t => t.due >= TODAY && t.due <= T(14)).length;
    return { d, n: ts.length, over, soon };
  });
  const max = Math.max(1, ...rows.map(r => r.n));
  return `<div>${rows.map(r => `<div class="load"><span>${esc(r.d.name)}</span><span class="lb" title="期限超過 ${r.over}／2週間以内 ${r.soon}／その他 ${r.n - r.over - r.soon}"><i class="b" style="width:${r.over / max * 100}%"></i><i class="a" style="width:${r.soon / max * 100}%"></i><i class="c" style="width:${(r.n - r.over - r.soon) / max * 100}%"></i></span><span class="num">${r.n}</span></div>`).join('')}
  <div class="legend" style="margin-top:6px"><span><i style="background:var(--bad)"></i>期限超過</span><span><i style="background:var(--accent)"></i>2週間以内に締切</span><span><i style="background:color-mix(in srgb,var(--accent) 35%,var(--surface))"></i>それ以降</span></div></div>`;
}

/* 6. タスク一覧 */
const TF = [['today', '今日'], ['week', '今週'], ['mine', '自分の担当'], ['overdue', '締切超過'], ['approval', '承認待ち'], ['waiting', '依頼中・回答待ち'], ['draft', '日付未確定'], ['byUser', '担当者別'], ['byDept', '部署別'], ['byProject', '案件別'], ['all', 'すべて']];
const TFN = {
  today: t => mine(t) && isOpen(t) && t.due && t.due <= TODAY,
  week: t => mine(t) && isOpen(t) && t.due && t.due <= T(7),
  overdueMine: t => mine(t) && isOpen(t) && t.due && t.due < TODAY,
  mine: t => mine(t) && isOpen(t),
  overdue: t => isOpen(t) && t.due && t.due < TODAY,
  approval: t => t.status === '承認待ち',
  waiting: t => t.status === '回答待ち' || t.status === '確認待ち',
  draft: t => t.status === '下書き',
  byUser: t => isOpen(t) && (!ui.tfUser || t.owner === ui.tfUser),
  byDept: t => isOpen(t) && (!ui.tfDept || t.dept === ui.tfDept),
  byProject: t => (!ui.tfProj || t.pid === ui.tfProj),
  all: () => true
};
VIEWS.tasks = function () {
  const all = S.tasks.filter(t => t.status !== '取消');
  const q = ui.q;
  const f = TFN[ui.tf] || (() => true);
  let list = all.filter(f).filter(t => !q || (t.name + P(t.pid).name + uname(t.owner)).includes(q)).sort(byDue);
  const showCnt = { today: 1, week: 1, overdue: 1, approval: 1, waiting: 1, draft: 1 };
  let out = `<div class="seg" role="tablist">${TF.map(([k, l]) => `<button class="${ui.tf === k || (k === 'overdue' && ui.tf === 'overdueMine') ? 'on' : ''}" data-a="taskFilter" data-f="${k}">${l}${showCnt[k] ? `<span class="cnt">${all.filter(TFN[k]).length || ''}</span>` : ''}</button>`).join('')}</div>`;
  out += `<div class="row"><input class="inp" id="tq" style="max-width:320px" placeholder="タスク名・案件名・担当者で検索" value="${esc(q)}" data-i="tq">`;
  if (ui.tf === 'byUser') out += `<select class="inp" id="tf-user" style="max-width:240px" data-c="tfUser">${userOpts(ui.tfUser, null, '全員（担当者ごとに表示）')}</select>`;
  if (ui.tf === 'byDept') out += `<select class="inp" id="tf-dept" style="max-width:200px" data-c="tfDept"><option value="">全部署（部署ごとに表示）</option>${deptOpts(ui.tfDept)}</select>`;
  if (ui.tf === 'byProject') out += `<select class="inp" id="tf-proj" style="max-width:280px" data-c="tfProj"><option value="">全案件（案件ごとに表示）</option>${S.projects.map(p => `<option value="${p.id}"${p.id === ui.tfProj ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
  out += `</div>`;
  if (ui.tf === 'overdue' || ui.tf === 'overdueMine') out += `<div class="seg"><button class="${ui.tf === 'overdueMine' ? 'on' : ''}" data-a="taskFilter" data-f="overdueMine">自分</button><button class="${ui.tf === 'overdue' ? 'on' : ''}" data-a="taskFilter" data-f="overdue">全社</button></div>`;
  if (ui.tf === 'waiting') out += `<div class="hint">他部署への依頼そのものは <button class="btn sm" data-a="nav" data-v="requests">依頼一覧</button> で確認できます。</div>`;
  const group = { byUser: t => uname(t.owner), byDept: t => deptName(t.dept), byProject: t => P(t.pid).name }[ui.tf];
  if (group && !(ui.tf === 'byUser' && ui.tfUser) && !(ui.tf === 'byDept' && ui.tfDept) && !(ui.tf === 'byProject' && ui.tfProj)) {
    const g = new Map(); for (const t of list) { const k = group(t); if (!g.has(k)) g.set(k, []); g.get(k).push(t); }
    out += `<section class="panel">${[...g.entries()].map(([k, ts]) => `<div class="grp-h">${esc(k)}<span class="chip lv-normal num">${ts.length}</span>${ts.some(t => t.due && t.due < TODAY && isOpen(t)) ? `<span class="chip al-over">超過 ${ts.filter(t => t.due && t.due < TODAY && isOpen(t)).length}</span>` : ''}</div>${tlist(ts, { noProj: ui.tf === 'byProject' })}`).join('') || '<div class="empty">該当するタスクはありません</div>'}</section>`;
  } else out += `<section class="panel">${tlist(list)}</section>`;
  return out;
};

/* 3. 案件一覧 */
VIEWS.projects = function () {
  const kinds = [['all', 'すべて'], ['k_house', '住宅'], ['k_facility', '施設'], ['k_public', '公共工事'], ['k_small', '小口工事'], ['late', '遅延あり']];
  const list = S.projects.filter(p => (ui.pk === 'all' || (ui.pk === 'late' ? S.tasks.some(t => t.pid === p.id && t.due && t.due < TODAY && isOpen(t)) : p.conditions.includes(ui.pk))) && (!ui.pq || (p.name + p.customer + p.no).includes(ui.pq)));
  let out = `<div class="row" style="justify-content:space-between"><div class="seg">${kinds.map(([k, l]) => `<button class="${ui.pk === k ? 'on' : ''}" data-a="pk" data-k="${k}">${l}</button>`).join('')}</div>
    ${canCreateProject() ? `<button class="btn primary" data-a="wizStart">${ico('plus')}案件を登録</button>` : ''}</div>
    <input class="inp" id="pq" style="max-width:360px" placeholder="案件名・顧客名・案件番号で検索" value="${esc(ui.pq)}" data-i="pq">`;
  out += `<div class="plist">${list.map(pcard).join('') || '<div class="empty">該当する案件はありません</div>'}</div>`;
  return out;
};
function pcard(p) {
  const ts = S.tasks.filter(t => t.pid === p.id && t.status !== '取消');
  const done = ts.filter(t => t.status === '完了').length;
  const over = ts.filter(t => t.due && t.due < TODAY && isOpen(t)).length;
  const tbd = ts.filter(t => t.status === '下書き').length;
  const kind = p.conditions.map(optLabel).filter(l => ['住宅', '施設', '公共工事', '小口工事'].includes(l))[0] || '';
  const work = p.conditions.map(optLabel).filter(l => ['新築', '改修', '修繕'].includes(l))[0] || '';
  const next = ts.filter(isOpen).filter(t => t.due).sort(byDue)[0];
  return `<button class="pcard" data-a="project" data-id="${p.id}">
    <div class="row" style="justify-content:space-between"><span class="pno">No.${esc(p.no)}</span><span class="row" style="gap:4px"><span class="tag">${esc(kind)}</span><span class="tag">${esc(work)}</span></span></div>
    <div class="pname">${esc(p.name)}</div>
    <div class="small muted">${esc(p.customer)}　案件責任者：${esc(uname(p.pm))}</div>
    <div class="bar" title="完了 ${done}/${ts.length}"><i style="width:${ts.length ? done / ts.length * 100 : 0}%"></i></div>
    <div class="row small" style="justify-content:space-between"><span class="num">${done}/${ts.length} 完了</span><span class="row" style="gap:4px">${over ? `<span class="chip al-over">超過 ${over}</span>` : ''}${tbd ? `<span class="chip al-tbd">日付未確定 ${tbd}</span>` : ''}</span></div>
    <div class="small">${next ? `次の締切：<b>${esc(next.name)}</b> <span class="num">${fmtD(next.due)}</span>` : '<span class="muted">締切の決まったタスクはありません</span>'}</div>
  </button>`;
}

/* 4. 案件登録ウィザード */
function wizInit() {
  ui.wiz = {
    step: 1, excluded: {}, owners: {},
    p: { no: '2026-' + String(136 + S.projects.length - 4).padStart(4, '0'), name: '（例）山口様邸 新築工事', customer: '山口 浩二', address: '市内 桜台2丁目', sales: me().dept === 'sales' ? S.me : 'u1', design: 'u3', construction: 'u5', pm: deptManager('sales') || 'u2', contractPlanned: T(30), contractDate: null, startPlanned: T(75), completionPlanned: '', handoverPlanned: '', visibility: '全社', note: '', createdOn: TODAY,
      conditions: ['land_no', 'acq_buy', 'k_house', 'w_new', 'soil_yes', 'imp_tbd', 'f_loan', 'permit_yes'] }
  };
}
VIEWS.wizard = function () {
  const w = ui.wiz; if (!w) { wizInit(); return VIEWS.wizard(); }
  const steps = ['基本情報', '案件条件', '生成タスクの確認', '登録'];
  let out = `<div class="steps">${steps.map((s, i) => `<span class="step${w.step === i + 1 ? ' on' : w.step > i + 1 ? ' done' : ''}"><i>${w.step > i + 1 ? '✓' : i + 1}</i>${s}</span>`).join('')}</div>`;
  const p = w.p;
  if (w.step === 1) {
    const dateF = (id, label, v) => `<label class="f"><span>${label}</span><input class="inp" type="date" id="${id}" value="${esc(v || '')}"></label>`;
    out += `<form class="panel stack" data-f="wiz1">
      <div class="form-grid">
        <label class="f req wide"><span>案件名</span><input class="inp" id="w-name" required value="${esc(p.name)}"></label>
        <label class="f req"><span>顧客名または法人名</span><input class="inp" id="w-customer" required value="${esc(p.customer)}"></label>
        <label class="f"><span>案件番号（自動採番・変更可）</span><input class="inp mono" id="w-no" value="${esc(p.no)}"></label>
        <label class="f"><span>所在地</span><input class="inp" id="w-address" value="${esc(p.address)}"></label>
        <label class="f"><span>営業担当</span><select class="inp" id="w-sales">${userOpts(p.sales, u => u.dept === 'sales', '未定')}</select></label>
        <label class="f"><span>設計担当</span><select class="inp" id="w-design">${userOpts(p.design, u => u.dept === 'design', '未定')}</select></label>
        <label class="f"><span>工務担当</span><select class="inp" id="w-construction">${userOpts(p.construction, u => u.dept === 'const', '未定')}</select></label>
        <label class="f req"><span>案件責任者</span><select class="inp" id="w-pm">${userOpts(p.pm)}</select></label>
        ${dateF('w-contractPlanned', '契約予定日', p.contractPlanned)}${dateF('w-contractDate', '契約日（実績）', p.contractDate)}
        ${dateF('w-startPlanned', '着工予定日', p.startPlanned)}${dateF('w-completionPlanned', '完成予定日', p.completionPlanned)}${dateF('w-handoverPlanned', '引渡予定日', p.handoverPlanned)}
        <label class="f"><span>案件の公開範囲</span><select class="inp" id="w-visibility">${['全社', '関係部署のみ', '関係者のみ'].map(v => `<option${v === p.visibility ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="f wide"><span>備考</span><textarea class="inp" id="w-note">${esc(p.note)}</textarea></label>
      </div>
      <div class="hint">未定の日付は空欄のままで登録できます。その日付を基準にするタスクは「日付未確定」の下書きとして作られ、日付が決まると自動計算されます。</div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-a="nav" data-v="projects">キャンセル</button><button class="btn primary" type="submit">次へ：案件条件</button></div>
    </form>`;
  } else if (w.step === 2) {
    const sel = new Set(p.conditions);
    const groups = S.groups.filter(g => g.active).sort((a, b) => a.order - b.order);
    const visible = groups.filter(g => !g.parent || sel.has(g.parent));
    const unset = visible.filter(g => !S.options.some(o => o.group === g.id && sel.has(o.id)));
    out += `<section class="panel"><div class="panel-h"><h2>案件の条件を選んでください</h2><span class="muted small">選んだ条件に合う標準タスクが自動で作られます</span></div>
      ${visible.map(g => `<div class="cond-g"><div class="gn">${esc(g.name)}${g.parent ? `<small>「${esc(optLabel(g.parent))}」のとき</small>` : ''}</div><div class="opts">${S.options.filter(o => o.group === g.id && o.active).map(o => `<button type="button" class="opt${sel.has(o.id) ? ' on' : ''}" data-a="wizOpt" data-o="${o.id}" aria-pressed="${sel.has(o.id)}">${esc(o.label)}</button>`).join('')}</div></div>`).join('')}
      ${unset.length ? `<div class="hint warn" style="margin-top:10px">未選択の条件が${unset.length}件あります（${unset.map(g => esc(g.name)).join('、')}）。未選択のままでも進めますが、その条件に関係するタスクは作られません。</div>` : ''}
    </section>
    <div class="row" style="justify-content:space-between"><button class="btn" data-a="wizStep" data-s="1">戻る</button><button class="btn primary" data-a="wizStep" data-s="3">次へ：生成されるタスクを確認</button></div>`;
  } else if (w.step === 3) {
    const plan = planTasks(S, p);
    plan.forEach(x => { x.include = !w.excluded[x.code]; if (w.owners[x.code] !== undefined) x.owner = w.owners[x.code]; });
    const inc = plan.filter(x => x.include);
    const tbd = inc.filter(x => !x.due).length;
    const noOwner = inc.filter(x => !x.owner).length;
    const byDept = {}; for (const x of plan) (byDept[x.dept] = byDept[x.dept] || []).push(x);
    out += `<section class="panel"><div class="panel-h"><h2>自動生成されるタスク</h2><span class="chip st-進行中 num">${inc.length}件</span>${plan.length - inc.length ? `<span class="chip lv-normal">除外 ${plan.length - inc.length}件</span>` : ''}${tbd ? `<span class="chip al-tbd">日付未確定 ${tbd}件</span>` : ''}</div>
      <div class="hint info">複数の条件に当てはまるタスクも1件にまとめています。不要なタスクはチェックを外すと作られません。担当者はここで変更できます（登録後も変更可能）。</div>
      ${noOwner ? `<div class="hint warn" style="margin-top:8px">担当者が決まっていないタスクが${noOwner}件あります。</div>` : ''}
      ${Object.entries(byDept).map(([d, xs]) => `<div class="grp-h">${esc(deptName(d))}<span class="chip lv-normal num">${xs.filter(x => x.include).length}</span></div>
        ${xs.sort(byDue).map(x => `<div class="plan-row${x.include ? '' : ' ex'}">
          <input type="checkbox" id="inc-${x.code}" ${x.include ? 'checked' : ''} data-c="wizInc" data-code="${x.code}" aria-label="${esc(x.name)}を生成する">
          <div><div class="pn">${esc(x.name)}</div><div class="why">${x.rule ? '条件：' + x.rule.map(optLabel).map(esc).join(' ＋ ') : '全案件共通'}</div></div>
          <span class="tag">${esc(deptName(x.dept))}</span>
          <select class="inp" id="own-${x.code}" data-c="wizOwner" data-code="${x.code}" style="padding:4px 6px;font-size:.84rem">${userOpts(x.owner, null, '担当未設定')}</select>
          <span>${x.due ? `<span class="num">${fmtD(x.due)}</span>` : '<span class="chip al-tbd">日付未確定</span>'}</span>
          <span class="basis">${esc(basisText(x.tpl))}${x.tpl.needApproval ? '・完了承認あり' : ''}</span>
        </div>`).join('')}`).join('')}
    </section>
    <div class="row" style="justify-content:space-between"><button class="btn" data-a="wizStep" data-s="2">戻る</button><button class="btn primary" data-a="wizStep" data-s="4">次へ：内容を確認</button></div>`;
  } else {
    const plan = planTasks(S, p).filter(x => !w.excluded[x.code]);
    out += `<section class="panel stack"><h2>${esc(p.name)}</h2>
      <dl class="kv"><dt>案件番号</dt><dd class="mono">${esc(p.no)}</dd><dt>顧客</dt><dd>${esc(p.customer)}</dd><dt>案件責任者</dt><dd>${esc(uname(p.pm))}</dd><dt>担当</dt><dd>営業 ${esc(uname(p.sales))}／設計 ${esc(uname(p.design))}／工務 ${esc(uname(p.construction))}</dd>
      <dt>日程</dt><dd>契約 ${fmtD(p.contractDate || p.contractPlanned)}／着工 ${fmtD(p.startPlanned)}／完成 ${fmtD(p.completionPlanned)}／引渡 ${fmtD(p.handoverPlanned)}</dd>
      <dt>条件</dt><dd>${p.conditions.map(o => `<span class="tag">${esc(optLabel(o))}</span>`).join(' ')}</dd>
      <dt>タスク</dt><dd><b class="num">${plan.length}</b>件を作成（うち日付未確定 ${plan.filter(x => !x.due).length}件は下書き）／除外 ${Object.values(w.excluded).filter(Boolean).length}件</dd></dl>
      <label class="f"><span>除外した理由（任意・履歴に残ります）</span><input class="inp" id="w-exreason" placeholder="例：土地は施主が手配済みのため"></label>
      <div class="hint">登録すると、各担当者へ「タスクが割り当てられました」と通知されます。</div>
    </section>
    <div class="row" style="justify-content:space-between"><button class="btn" data-a="wizStep" data-s="3">戻る</button><button class="btn primary" data-a="wizSubmit">この内容で登録する</button></div>`;
  }
  return out;
};

/* 5. 案件詳細 */
VIEWS.project = function () {
  const p = P(ui.params.id); if (!p) return '<div class="empty">案件が見つかりません</div>';
  const ts = S.tasks.filter(t => t.pid === p.id);
  const done = ts.filter(t => t.status === '完了').length;
  const drafts = ts.filter(t => t.status === '下書き');
  const decs = S.decisions.filter(d => d.pid === p.id);
  const canDates = isPM(p) || pv('assign_change') === 'all';
  const ms = (l, v, a) => `<div class="ms"><div class="l">${l}${a ? '（実績）' : ''}</div><div class="v${v ? '' : ' tbd'}">${v ? fmtD(v, true) : '未定'}</div></div>`;
  let out = `<section class="panel stack">
    <div class="row" style="justify-content:space-between"><span class="pno">No.${esc(p.no)}</span><span class="row" style="gap:6px"><span class="chip st-進行中">${esc(p.status)}</span><span class="tag">公開範囲：${esc(p.visibility)}</span></span></div>
    <h2 style="font-size:1.3rem">${esc(p.name)}</h2>
    <div class="small muted">${esc(p.customer)}　${esc(p.address)}</div>
    <div class="row" style="gap:4px">${p.conditions.map(o => `<span class="tag">${esc(optLabel(o))}</span>`).join('')}</div>
    <div class="milestones">${ms('契約', p.contractDate || p.contractPlanned, !!p.contractDate)}${ms('着工予定', p.startPlanned)}${ms('完成予定', p.completionPlanned)}${ms('引渡予定', p.handoverPlanned)}</div>
    <dl class="kv"><dt>案件責任者</dt><dd>${esc(uname(p.pm))}</dd><dt>営業</dt><dd>${esc(uname(p.sales))}</dd><dt>設計</dt><dd>${esc(uname(p.design))}</dd><dt>工務</dt><dd>${esc(uname(p.construction))}</dd></dl>
    <div class="bar"><i style="width:${ts.length ? done / ts.length * 100 : 0}%"></i></div><div class="small num">${done}/${ts.length} 完了</div>
    <div class="row">
      ${canDates ? `<button class="btn sm" data-a="editDates" data-id="${p.id}">日程を編集</button>` : ''}
      ${pv('task_add_self') !== 'none' ? `<button class="btn sm" data-a="addTask" data-id="${p.id}">${ico('plus')}タスクを追加</button>` : ''}
      ${pv('request_send') !== 'none' ? `<button class="btn sm" data-a="newRequest" data-pid="${p.id}">他部署へ依頼</button>` : ''}
      <button class="btn sm" data-a="decisionNew" data-pid="${p.id}">決定事項を登録</button>
    </div>
  </section>`;
  const tabs = [['tasks', `タスク（${ts.filter(t => t.status !== '取消').length}）`], ['gantt', '工程表'], ['log', '活動履歴'], ['dec', `決定事項（${decs.length}）`], ['conf', '機密情報']];
  out += `<div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="${ui.ptab === k ? 'on' : ''}" data-a="ptab" data-k="${k}">${k === 'conf' ? ico('lock', 'ico') + ' ' : ''}${l}</button>`).join('')}</div>`;
  if (ui.ptab === 'tasks') {
    if (drafts.length) out += `<div class="hint warn">日付未確定または下書きのタスクが${drafts.length}件あります。${drafts.some(t => t.due) ? `締切が計算済みの下書きは確認後に正式タスクにしてください。 ${canDates ? `<button class="btn sm" data-a="promoteAll" data-id="${p.id}">締切・担当が揃った下書きを正式タスクにする</button>` : ''}` : '日程を入力すると締切日が自動計算されます。'}</div>`;
    const g = {}; for (const t of ts.filter(t => t.status !== '取消').sort(byDue)) (g[t.dept] = g[t.dept] || []).push(t);
    out += `<section class="panel">${Object.entries(g).map(([d, xs]) => `<div class="grp-h">${esc(deptName(d))}<span class="chip lv-normal num">${xs.length}</span></div>${tlist(xs, { noProj: true })}`).join('')}</section>`;
  } else if (ui.ptab === 'gantt') {
    out += gantt(p);
  } else if (ui.ptab === 'log') {
    out += `<section class="panel">${timeline(S.activities.filter(a => a.pid === p.id))}</section>`;
  } else if (ui.ptab === 'dec') {
    out += `<section class="stack">${decs.map(decCard).join('') || '<div class="empty">決定事項はまだありません</div>'}</section>`;
  } else {
    if (!canSeeConf(p)) out += `<section class="panel stack" style="align-items:center;text-align:center">${ico('lock', 'ico')}<h3>閲覧が制限されています</h3><div class="muted small">原価・利益率・融資情報は、経営者・案件責任者・関係部署の所属長など、許可された人だけが見られます。</div></section>`;
    else if (!p.confidential) out += `<div class="empty">機密情報はまだ登録されていません</div>`;
    else { const c = p.confidential; const gp = c.price - c.cost; out += `<section class="panel stack"><div class="hint">この情報は閲覧制限の対象です。閲覧の記録が操作ログに残ります。</div><dl class="kv"><dt>請負金額</dt><dd class="num">${yen(c.price)}</dd><dt>原価（見込み）</dt><dd class="num">${yen(c.cost)}</dd><dt>粗利</dt><dd class="num">${yen(gp)}</dd><dt>粗利率</dt><dd class="num">${(gp / c.price * 100).toFixed(1)}%</dd><dt>資金・融資</dt><dd>${esc(c.loan)}</dd><dt>メモ</dt><dd>${esc(c.note || '—')}</dd></dl></section>`; }
  }
  return out;
};
VIEWS.project.title = () => (P(ui.params.id) || {}).name || '案件詳細';

function decCard(d) {
  return `<div class="decision"><div class="dh"><span class="stamp">決定</span><span>${fmtD(d.on, true)}</span><span>決定者：${esc(uname(d.by))}</span>${ui.view !== 'project' ? `<button class="crumb" data-a="project" data-id="${d.pid}">${esc(P(d.pid).name)}</button>` : ''}</div>
    <div>${esc(d.content)}</div>
    ${d.tasks.length ? `<div class="row small" style="gap:4px"><span class="muted">影響するタスク：</span>${d.tasks.map(id => TK(id)).filter(Boolean).map(t => `<button class="btn sm ghost" data-a="task" data-id="${t.id}">${esc(t.name)}</button>`).join('')}</div>` : ''}</div>`;
}

/* 活動履歴 */
const KIND = t => t.startsWith('report.issue') ? ['issue', '!'] : t.startsWith('report.slip') || t.startsWith('change') || t.startsWith('due') || t.startsWith('assign') ? ['change', '変'] : t.startsWith('report.done') || t === 'task.done' ? ['done', '完'] : t.startsWith('report') ? ['report', '報'] : t.startsWith('decision') ? ['decision', '決'] : t.startsWith('request') || t.startsWith('approval') ? ['request', '依'] : t.startsWith('comment') ? ['', '言'] : t.startsWith('file') ? ['', '添'] : ['', '記'];
function timeline(acts) {
  acts = acts.slice().sort((a, b) => b.at - a.at);
  if (!acts.length) return '<div class="empty">履歴はまだありません</div>';
  return `<div class="tl">${acts.map(a => { const [k, l] = KIND(a.type); const t = a.tid && TK(a.tid); return `<div class="tl-i"><div class="tl-ico k-${k}">${l}</div><div class="tl-b">
    <div class="tl-t"><b>${esc(uname(a.uid))}</b>　${esc(a.text)}${t && ui.view !== 'task' ? ` <button class="crumb" style="display:inline" data-a="task" data-id="${t.id}">「${esc(t.name)}」</button>` : ''}</div>
    ${a.diff ? `<div class="tl-diff">${a.diff.map(d => `${esc(d.f)}：${esc(d.o)} → <b>${esc(d.n)}</b>`).join('<br>')}</div>` : ''}
    ${a.comment ? `<div class="tl-c">${esc(a.comment)}</div>` : ''}
    <div class="tl-m">${fmtDT(a.at)}</div></div></div>`; }).join('')}</div>`;
}

/* 7. タスク詳細 */
VIEWS.task = function () {
  const t = TK(ui.params.id); if (!t) return '<div class="empty">タスクが見つかりません</div>';
  const p = P(t.pid);
  const upd = canUpdate(t), edit = canEdit(t);
  const tpl = S.templates.find(x => x.code === t.code);
  const preds = t.preds.map(TK).filter(Boolean), succ = successors(S, t.id);
  const needAp = tpl && tpl.needApproval && t.approver;
  let out = `<section class="panel t-head">
    <button class="crumb" data-a="project" data-id="${p.id}">No.${esc(p.no)}　${esc(p.name)}</button>
    <h2 style="font-size:1.25rem">${esc(t.name)}</h2>
    <div class="row" style="gap:6px">${stChip(t.status)}${alChip(t)}<span class="tag">${t.origin === 'auto' ? '自動生成' : t.origin === 'request' ? '依頼から作成' : '手動追加'}</span>${t.priority !== '中' ? `<span class="chip ${t.priority === '高' ? 'lv-important' : 'lv-normal'}">優先度 ${esc(t.priority)}</span>` : ''}</div>
  </section>
  <div class="fields">
    <div><div class="l">担当部署</div><div class="v">${esc(deptName(t.dept))}</div></div>
    <div><div class="l">主担当</div><div class="v">${esc(uname(t.owner))}</div></div>
    <div><div class="l">協力者</div><div class="v">${t.collaborators.map(uname).map(esc).join('、') || '—'}</div></div>
    <div><div class="l">承認者</div><div class="v">${esc(t.approver ? uname(t.approver) : '—')}</div></div>
    <div><div class="l">開始予定日</div><div class="v num">${t.start ? fmtD(t.start, true) : '—'}</div></div>
    <div><div class="l">締切日</div><div class="v"><span class="num">${fmtD(t.due, true)}</span><div class="small muted">${t.origin === 'auto' && tpl ? esc(basisText(tpl)) : t.origin === 'request' ? '依頼の承認時に確定' : '手動で設定'}</div></div></div>
    <div><div class="l">完了日</div><div class="v num">${t.completedAt ? fmtD(t.completedAt, true) : '—'}</div></div>
    <div><div class="l">通知対象者</div><div class="v">${t.watchers.map(uname).map(esc).join('、') || '—'}</div></div>
  </div>`;
  if (t.status === '下書き') {
    out += `<div class="hint warn">このタスクは下書きです。${!t.due ? '締切日の基準となる日程が未定のため「日付未確定」です。案件の日程を入力すると自動計算されます。' : '締切日と担当者を確認し、正式タスクにしてください。'}</div>`;
    if ((edit || isPM(p)) && t.due && t.owner) out += `<button class="btn primary" data-a="promote" data-id="${t.id}">正式タスクにする（未着手へ）</button>`;
  }
  if (t.status !== '下書き' && isOpen(t)) {
    if (upd) {
      out += `<section class="panel"><div class="panel-h"><h2>進捗を報告</h2><span class="muted small">押すと活動履歴に残り、関係者へ通知されます</span></div><div class="qa">${QUICK.map(q => {
        let dis = false, hint = '';
        if (q.code === 'done' && needAp) { dis = true; hint = '承認が必要なタスクです'; }
        if (q.code === 'start' && t.status !== '未着手') dis = true;
        if (q.special === 'due' && dueMode(t) === 'none') dis = true;
        return `<button class="${q.cls || ''}" data-a="quick" data-q="${q.code}" data-id="${t.id}" ${dis ? 'disabled' : ''} title="${hint}">${esc(q.label)}</button>`; }).join('')}</div>
        ${needAp ? `<div class="small muted" style="margin-top:8px">このタスクは完了に承認が必要です（承認者：${esc(uname(t.approver))}）。「完了を申請」を使ってください。</div>` : ''}</section>`;
    } else {
      out += `<div class="hint">${me().role === 'viewer' ? '閲覧専用アカウントのため変更できません。' : 'あなたはこのタスクの担当者・協力者ではないため、閲覧のみできます。お願いしたいことがあれば依頼を送ってください。'}</div>
        ${me().role !== 'viewer' ? `<div class="row"><button class="btn" data-a="newRequest" data-pid="${p.id}" data-tid="${t.id}">この件で依頼する</button><button class="btn" data-a="watch" data-id="${t.id}">${t.watchers.includes(S.me) ? '通知を受け取らない' : '通知を受け取る'}</button></div>` : ''}`;
    }
  }
  if (edit) out += `<div class="row"><button class="btn" data-a="editTask" data-id="${t.id}">担当者・期限・承認者を変更</button>${isOpen(t) ? `<button class="btn danger" data-a="cancelTask" data-id="${t.id}">タスクを取消</button>` : ''}</div>`;
  out += `<div class="grid2">
    <section class="panel stack"><h2>内容</h2><div style="white-space:pre-wrap">${esc(t.desc) || '<span class="muted">説明はありません</span>'}</div>
      <h3>チェックリスト <span class="muted small num">${t.checklist.filter(c => c.done).length}/${t.checklist.length}</span></h3>
      <div>${t.checklist.map((c, i) => `<label class="check${c.done ? ' done' : ''}"><input type="checkbox" id="ck-${t.id}-${i}" ${c.done ? 'checked' : ''} ${upd ? '' : 'disabled'} data-c="check" data-id="${t.id}" data-i="${i}"><span>${esc(c.t)}</span></label>`).join('') || '<div class="muted small">項目なし</div>'}</div>
      ${upd ? `<form class="row" data-f="checkAdd" data-id="${t.id}"><input class="inp" id="ck-new" placeholder="項目を追加" style="flex:1"><button class="btn sm">追加</button></form>` : ''}
      <h3>前工程・後工程</h3>
      <div class="stack" style="gap:4px">${preds.map(x => `<button class="btn sm ghost" style="justify-content:flex-start" data-a="task" data-id="${x.id}">← 前：${esc(x.name)}　${stChip(x.status)}</button>`).join('')}${succ.map(x => `<button class="btn sm ghost" style="justify-content:flex-start" data-a="task" data-id="${x.id}">→ 後：${esc(x.name)}　${stChip(x.status)}</button>`).join('')}${!preds.length && !succ.length ? '<span class="muted small">設定なし</span>' : ''}</div>
      <h3>添付ファイル</h3>
      <div class="stack" style="gap:4px">${t.attachments.map(a => `<div class="row small"><span class="tag">${esc(a.name.split('.').pop().toUpperCase())}</span>${esc(a.name)}<span class="muted">${esc(uname(a.by))}・${fmtDT(a.at)}</span></div>`).join('') || '<span class="muted small">なし</span>'}</div>
      ${upd ? `<label class="btn sm" style="align-self:flex-start">ファイルを追加<input type="file" id="att-${t.id}" hidden data-c="attach" data-id="${t.id}"></label>` : ''}
    </section>
    <section class="panel stack"><h2>コメント・活動履歴</h2>
      ${me().role !== 'viewer' ? `<form class="stack" data-f="comment" data-id="${t.id}"><textarea class="inp" id="cm-text" placeholder="短いコメントを残す（関係者へ通知されます）"></textarea>
        <div class="row" style="justify-content:space-between"><label class="switch small"><input type="checkbox" id="cm-dec">決定事項として登録する</label><button class="btn primary sm">送信</button></div></form>` : ''}
      ${timeline(S.activities.filter(a => a.tid === t.id))}
    </section>
  </div>
  <div class="small muted">作成：${esc(uname(t.createdBy))} ${fmtDT(t.createdAt)}${t.updatedAt ? `　更新：${esc(uname(t.updatedBy))} ${fmtDT(t.updatedAt)}` : ''}　公開範囲：${esc(t.visibility)}</div>`;
  return out;
};
VIEWS.task.title = () => (TK(ui.params.id) || {}).name || 'タスク詳細';

/* 8. カレンダー */
VIEWS.calendar = function () {
  const m = parse(ui.calM); const y = m.getFullYear(), mo = m.getMonth();
  const first = new Date(y, mo, 1); const start = new Date(first); start.setDate(1 - first.getDay());
  const scope = { me: t => mine(t), dept: t => t.dept === me().dept, all: () => true }[ui.calScope];
  const ts = S.tasks.filter(t => t.due && t.status !== '取消' && scope(t));
  const byDay = {}; for (const t of ts) (byDay[t.due] = byDay[t.due] || []).push(t);
  let cells = '';
  const rowsN = Math.ceil((first.getDay() + new Date(y, mo + 1, 0).getDate()) / 7);
  for (let i = 0; i < rowsN * 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i); const k = iso(d); const list = byDay[k] || [];
    cells += `<button class="day${d.getMonth() !== mo ? ' out' : ''}${k === TODAY ? ' today' : ''}${k === ui.calSel ? ' sel' : ''}${(d.getDay() === 0 || HOLIDAYS.has(k)) ? ' hol' : ''}" data-a="calDay" data-d="${k}" aria-label="${fmtD(k)} ${list.length}件">
      <span class="dn">${d.getDate()}</span>
      ${list.slice(0, 3).map(t => `<span class="ev${!isOpen(t) ? ' done' : t.due < TODAY ? ' over' : ''}">${esc(t.name)}</span>`).join('')}${list.length > 3 ? `<span class="more">他${list.length - 3}件</span>` : ''}
      <span class="dots">${list.slice(0, 4).map(t => `<i class="${isOpen(t) && t.due < TODAY ? 'over' : ''}"></i>`).join('')}</span></button>`;
  }
  const sel = (byDay[ui.calSel] || []).sort((a, b) => a.pid < b.pid ? -1 : 1);
  return `<div class="row" style="justify-content:space-between">
    <div class="row"><button class="btn sm" data-a="calMove" data-n="-1">‹ 前月</button><h2 class="num">${y}年${mo + 1}月</h2><button class="btn sm" data-a="calMove" data-n="1">次月 ›</button><button class="btn sm ghost" data-a="calMove" data-n="0">今月</button></div>
    <div class="seg"><button class="${ui.calScope === 'me' ? 'on' : ''}" data-a="calScope" data-k="me">自分</button><button class="${ui.calScope === 'dept' ? 'on' : ''}" data-a="calScope" data-k="dept">${esc(deptName(me().dept))}</button><button class="${ui.calScope === 'all' ? 'on' : ''}" data-a="calScope" data-k="all">全社</button></div></div>
  <div class="cal">${[...DOW].map(d => `<div class="dow">${d}</div>`).join('')}${cells}</div>
  <section class="panel"><div class="panel-h"><h2>${fmtD(ui.calSel, true)} 締切のタスク</h2></div>${tlist(sel, { empty: 'この日が締切のタスクはありません' })}</section>`;
};

/* 9. 工程表 */
VIEWS.gantt = function () {
  if (!ui.gp || !P(ui.gp)) ui.gp = S.projects[0].id;
  return `<div class="row"><label class="f" style="flex:1;max-width:420px"><span>案件</span><select class="inp" id="g-proj" data-c="gp">${S.projects.map(p => `<option value="${p.id}"${p.id === ui.gp ? ' selected' : ''}>${esc(p.no)}　${esc(p.name)}</option>`).join('')}</select></label><button class="btn sm" style="align-self:flex-end" data-a="project" data-id="${ui.gp}">案件詳細へ</button></div>${gantt(P(ui.gp))}`;
};
function gantt(p) {
  const ts = S.tasks.filter(t => t.pid === p.id && t.status !== '取消').sort((a, b) => ((a.start || a.due || '9999') < (b.start || b.due || '9999') ? -1 : 1));
  const dates = [TODAY, p.contractDate || p.contractPlanned, p.startPlanned, p.completionPlanned, p.handoverPlanned, ...ts.flatMap(t => [t.start, t.due])].filter(Boolean).sort();
  const min = addDays(dates[0], -5), max = addDays(dates[dates.length - 1], 7);
  const dw = window.innerWidth < 860 ? 9 : 13;
  const days = diffDays(max, min) + 1, W = days * dw;
  const lw = window.innerWidth < 860 ? 130 : 230;
  const x = d => diffDays(d, min) * dw;
  let wk = ''; for (let i = 0; i < days; i++) { const d = addDays(min, i); if (parse(d).getDay() === 1) wk += `<span class="g-wk" style="left:${i * dw}px">${parse(d).getMonth() + 1}/${parse(d).getDate()}</span>`; }
  const lines = [[TODAY, '今日', 'today'], [p.contractDate || p.contractPlanned, '契約'], [p.startPlanned, '着工'], [p.completionPlanned, '完成'], [p.handoverPlanned, '引渡']].filter(l => l[0]).map(([d, l, c]) => `<span class="g-line ${c || ''}" style="left:${lw + x(d) + dw / 2}px"><span>${l}</span></span>`).join('');
  const rows = ts.map(t => {
    const cls = t.status === '完了' ? 'done' : t.status === '下書き' ? 'draft' : (t.due && t.due < TODAY) ? 'over' : ['承認待ち', '確認待ち', '回答待ち'].includes(t.status) ? 'wait' : '';
    const s = t.start || t.due;
    return `<div class="g-row"><button class="g-lab" data-a="task" data-id="${t.id}" title="${esc(t.name)}">${esc(t.name)}<small>${esc(sname(t.owner))}</small></button><div class="g-track" style="width:${W}px">${t.due ? `<span class="g-bar ${cls}" style="left:${x(s)}px;width:${(diffDays(t.due, s) + 1) * dw}px" title="${esc(t.name)} ${fmtD(s)}〜${fmtD(t.due)}"></span>` : '<span class="g-tbd">日付未確定</span>'}</div></div>`;
  }).join('');
  return `<div class="legend"><span><i style="background:var(--accent)"></i>予定・進行中</span><span><i style="background:var(--info)"></i>確認・承認待ち</span><span><i style="background:var(--ok)"></i>完了</span><span><i style="background:var(--bad)"></i>期限超過</span><span><i style="border:1.5px dashed var(--line-strong)"></i>下書き</span></div>
  <div class="gantt" style="--gl:${lw}px"><div class="g-inner" style="width:${lw + W}px">
    <div class="g-row g-head"><div class="g-lab">タスク</div><div class="g-track" style="width:${W}px;height:24px">${wk}</div></div>
    ${rows}${lines}
  </div></div>
  <div class="small muted">試作では閲覧のみ。日付の変更はタスク詳細の「工程がずれました」「期限変更を申請」から行います（ドラッグ編集は拡張案）。</div>`;
}

/* 10. 依頼一覧・依頼登録 */
const RQ_ST = { sent: '送信済', review: '確認中', approved: '承認', returned: '差戻し', rejected: '却下', escalated: '責任者判断中', withdrawn: '取下げ' };
VIEWS.requests = function () {
  const tabs = [['recv', '届いた依頼'], ['sent', '送った依頼'], ['all', 'すべて']];
  const list = S.requests.filter(r => ui.rtab === 'recv' ? (r.receiver === S.me || (r.toDept === me().dept && me().role === 'manager')) : ui.rtab === 'sent' ? r.from === S.me : true).sort((a, b) => b.createdAt - a.createdAt);
  return `<div class="row" style="justify-content:space-between"><div class="seg">${tabs.map(([k, l]) => `<button class="${ui.rtab === k ? 'on' : ''}" data-a="rtab" data-k="${k}">${l}</button>`).join('')}</div>${pv('request_send') !== 'none' ? `<button class="btn primary" data-a="newRequest">${ico('plus')}依頼を作成</button>` : ''}</div>
  <div class="stack">${list.map(rcard).join('') || '<div class="empty">依頼はありません</div>'}</div>`;
};
function rcard(r) {
  return `<button class="rcard" data-a="request" data-id="${r.id}">
    <div class="row" style="gap:6px"><span class="chip rq-${r.status}">${RQ_ST[r.status]}</span><span class="chip urg-${esc(r.urgency)}">${esc(r.urgency)}</span><span class="small muted">${esc(P(r.pid).name)}</span></div>
    <div class="rt">${esc(r.title)}</div>
    <div class="small muted">${esc(uname(r.from))} → ${esc(deptName(r.toDept))}${r.toUser ? '・' + esc(uname(r.toUser)) : ''}（受付：${esc(uname(r.receiver))}）　希望期限 <span class="num">${fmtD(r.desired)}</span></div>
  </button>`;
}
VIEWS['request-new'] = function () {
  const pr = ui.params; const t = pr.tid && TK(pr.tid);
  const draft = ui.rqDraft || {};
  return `<form class="panel stack" data-f="request">
    <div class="form-grid">
      <label class="f req"><span>対象案件</span><select class="inp" id="rq-pid">${S.projects.map(p => `<option value="${p.id}"${p.id === (pr.pid || draft.pid) ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label class="f req"><span>依頼先の部署</span><select class="inp" id="rq-dept" data-c="rqDept">${deptOpts(draft.toDept || (t ? t.dept : 'design'))}</select></label>
      <label class="f"><span>依頼先の担当者（任意）</span><select class="inp" id="rq-user">${userOpts(draft.toUser || (t ? t.owner : ''), u => u.dept === (draft.toDept || (t ? t.dept : 'design')), '指定しない（所属長が受付）')}</select></label>
      <label class="f req wide"><span>依頼内容（件名）</span><input class="inp" id="rq-title" required value="${esc(draft.title || (t ? '「' + t.name + '」について' : ''))}" placeholder="例：基礎伏図の最新版を共有してください"></label>
      <label class="f wide"><span>詳細</span><textarea class="inp" id="rq-content" placeholder="何を、どこまでしてほしいかを具体的に">${esc(draft.content || '')}</textarea></label>
      <label class="f req wide"><span>依頼理由</span><input class="inp" id="rq-reason" required value="${esc(draft.reason || '')}" placeholder="例：基礎業者への見積依頼に使うため"></label>
      <label class="f req"><span>希望期限</span><input class="inp" type="date" id="rq-desired" required value="${esc(draft.desired || T(5))}"></label>
      <label class="f"><span>緊急度</span><select class="inp" id="rq-urg">${['通常', '急ぎ', '至急'].map(u => `<option${u === (draft.urgency || '通常') ? ' selected' : ''}>${u}</option>`).join('')}</select></label>
      <label class="f"><span>添付資料</span><input class="inp" type="file" id="rq-file"></label>
    </div>
    <div class="hint">担当者を指定しない場合は、依頼先部署の所属長が受け付けます。承認されると正式なタスクになり、結果はあなたに通知されます。</div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-a="back">キャンセル</button><button class="btn primary">依頼を送信</button></div>
  </form>`;
};
VIEWS.request = function () {
  const r = S.requests.find(x => x.id === ui.params.id); if (!r) return '<div class="empty">依頼が見つかりません</div>';
  if (r.receiver === S.me && r.status === 'sent') { r.status = 'review'; r.history.push({ uid: S.me, act: '内容を確認中', at: Date.now() }); save(); }
  const isRecv = (r.receiver === S.me || pv('approve') === 'all') && ['sent', 'review', 'escalated'].includes(r.status);
  const isFrom = r.from === S.me;
  const task = r.taskId && TK(r.taskId);
  let out = `<section class="panel stack">
    <div class="row" style="gap:6px"><span class="chip rq-${r.status}">${RQ_ST[r.status]}</span><span class="chip urg-${esc(r.urgency)}">${esc(r.urgency)}</span><button class="crumb" data-a="project" data-id="${r.pid}">${esc(P(r.pid).name)}</button></div>
    <h2>${esc(r.title)}</h2>
    <dl class="kv"><dt>依頼者</dt><dd>${esc(uname(r.from))}（${esc(deptName(U(r.from).dept))}）</dd><dt>依頼先</dt><dd>${esc(deptName(r.toDept))}${r.toUser ? '・' + esc(uname(r.toUser)) : ''}</dd><dt>受付</dt><dd>${esc(uname(r.receiver))}</dd><dt>希望期限</dt><dd class="num">${fmtD(r.desired, true)}</dd>${r.decidedDue ? `<dt>承認後の期限</dt><dd class="num"><b>${fmtD(r.decidedDue, true)}</b></dd>` : ''}</dl>
    <div style="white-space:pre-wrap">${esc(r.content)}</div>
    <div class="small"><span class="muted">依頼理由：</span>${esc(r.reason)}</div>
    ${task ? `<button class="btn" data-a="task" data-id="${task.id}">作成された正式タスクを開く：${esc(task.name)}</button>` : ''}
  </section>`;
  if (isRecv) {
    const a = ui.ract;
    out += `<section class="panel stack"><h2>対応を選んでください</h2><div class="actions-grid">
      <button class="btn primary" data-a="ract" data-k="ok">承認する</button>
      <button class="btn" data-a="ract" data-k="due">期限を変更して承認</button>
      <button class="btn" data-a="ract" data-k="owner">担当者を変更して承認</button>
      <button class="btn" data-a="ract" data-k="return">情報不足で差し戻す</button>
      <button class="btn danger" data-a="ract" data-k="reject">理由を添えて却下</button>
      ${r.status !== 'escalated' ? `<button class="btn" data-a="ract" data-k="esc">責任者へ判断を依頼</button>` : ''}
    </div>
    ${a ? `<form class="stack" data-f="rdecide" data-id="${r.id}" data-k="${a}" style="border-top:1px solid var(--line);padding-top:12px">
      <div class="form-grid">
        ${a === 'ok' || a === 'owner' || a === 'due' ? `<label class="f"><span>正式タスクの担当者</span><select class="inp" id="rd-owner">${userOpts(r.toUser || r.receiver, a === 'owner' ? u => u.dept === r.toDept : null)}</select></label>
        <label class="f"><span>締切日</span><input class="inp" type="date" id="rd-due" value="${esc(r.desired)}" ${a === 'due' ? '' : 'readonly'}></label>` : ''}
        ${a === 'esc' ? `<label class="f"><span>判断を依頼する責任者</span><select class="inp" id="rd-esc">${userOpts(P(r.pid).pm, u => ['manager', 'exec'].includes(u.role))}</select></label>` : ''}
        <label class="f wide ${['return', 'reject', 'due'].includes(a) ? 'req' : ''}"><span>${{ ok: 'コメント（任意）', due: '期限を変更する理由', owner: 'コメント（任意）', return: '不足している情報', reject: '対応できない理由', esc: '判断してほしい点' }[a]}</span><textarea class="inp" id="rd-comment" ${['return', 'reject', 'due'].includes(a) ? 'required' : ''}></textarea></label>
      </div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-a="ract" data-k="">やめる</button><button class="btn primary">${{ ok: '承認して正式タスクにする', due: '期限を変更して承認', owner: '担当者を変更して承認', return: '差し戻す', reject: '却下する', esc: '責任者へ送る' }[a]}</button></div>
    </form>` : ''}</section>`;
  }
  if (isFrom && r.status === 'returned') out += `<section class="panel stack"><h2>差し戻されました</h2><div class="hint warn">${esc((r.history.filter(h => h.comment).slice(-1)[0] || {}).comment || '')}</div><div class="row"><button class="btn primary" data-a="resend" data-id="${r.id}">内容を修正して再送</button><button class="btn" data-a="withdraw" data-id="${r.id}">依頼を取り下げる</button></div></section>`;
  out += `<section class="panel"><h2 style="margin-bottom:8px">経過</h2><div class="tl">${r.history.slice().reverse().map(h => `<div class="tl-i"><div class="tl-ico k-request">依</div><div class="tl-b"><div class="tl-t"><b>${esc(uname(h.uid))}</b>　${esc(h.act)}</div>${h.comment ? `<div class="tl-c">${esc(h.comment)}</div>` : ''}<div class="tl-m">${fmtDT(h.at)}</div></div></div>`).join('')}</div></section>`;
  return out;
};

/* 11. 承認待ち */
VIEWS.approvals = function () {
  const all = ui.allAp && pv('approve') === 'all';
  const reqs = S.requests.filter(r => ['sent', 'review', 'escalated'].includes(r.status) && (all || r.receiver === S.me));
  const chg = S.changes.filter(c => c.status === 'pending' && (all || c.approver === S.me));
  const aps = S.approvals.filter(a => a.status === 'pending' && (all || a.approver === S.me));
  const myReq = [...S.changes.filter(c => c.by === S.me && c.status === 'pending'), ...S.approvals.filter(a => a.by === S.me && a.status === 'pending')];
  let out = `<div class="row" style="justify-content:space-between"><div class="seg"><button class="on" data-a="nav" data-v="approvals">承認待ち</button><button data-a="nav" data-v="requests">依頼一覧</button></div>${pv('approve') === 'all' ? `<label class="switch small"><input type="checkbox" id="all-ap" data-c="allAp" ${ui.allAp ? 'checked' : ''}>全社の承認待ちを表示</label>` : ''}</div>`;
  out += `<section class="panel"><div class="panel-h"><h2>依頼</h2><span class="chip lv-normal num">${reqs.length}</span></div><div class="stack">${reqs.map(rcard).join('') || '<div class="empty">あなた宛ての未処理の依頼はありません</div>'}</div></section>`;
  out += `<section class="panel"><div class="panel-h"><h2>期限変更・工程変更</h2><span class="chip lv-normal num">${chg.length}</span></div><div class="stack">${chg.map(ccard).join('') || '<div class="empty">承認待ちの変更申請はありません</div>'}</div></section>`;
  out += `<section class="panel"><div class="panel-h"><h2>完了申請</h2><span class="chip lv-normal num">${aps.length}</span></div><div class="stack">${aps.map(a => { const t = TK(a.tid); return `<div class="rcard"><div class="row" style="gap:6px"><span class="chip rq-pending">完了申請</span><span class="small muted">${esc(P(a.pid).name)}</span></div><button class="crumb rt" data-a="task" data-id="${t.id}" style="font-size:1rem;color:var(--ink)">${esc(t.name)}</button><div class="small muted">申請者：${esc(uname(a.by))}　${fmtDT(a.at)}</div>${a.comment ? `<div class="tl-c">${esc(a.comment)}</div>` : ''}<div class="row"><button class="btn primary sm" data-a="apDone" data-id="${a.id}" data-k="ok">承認して完了にする</button><button class="btn sm" data-a="apDone" data-id="${a.id}" data-k="return">差し戻す</button></div></div>`; }).join('') || '<div class="empty">承認待ちの完了申請はありません</div>'}</div></section>`;
  if (myReq.length) out += `<section class="panel"><div class="panel-h"><h2>自分が申請中</h2></div><div class="stack">${myReq.map(x => x.items ? ccard(x) : `<div class="rcard"><span class="chip rq-pending">完了申請</span><div class="rt">${esc(TK(x.tid).name)}</div><div class="small muted">承認者：${esc(uname(x.approver))}</div></div>`).join('')}</div></section>`;
  return out;
};
function ccard(c) {
  const t = TK(c.tid); const n = c.items.filter(i => !i.origin).length;
  return `<button class="rcard" data-a="change" data-id="${c.id}"><div class="row" style="gap:6px"><span class="chip rq-${c.status === 'pending' ? 'pending' : c.status === 'applied' ? 'approved' : c.status}">${{ pending: '承認待ち', applied: '反映済み', rejected: '却下', returned: '差戻し' }[c.status]}</span><span class="tag">${c.kind === 'due' ? '期限変更' : '工程変更'}</span><span class="small muted">${esc(P(c.pid).name)}</span></div>
    <div class="rt">${esc(t.name)}：<span class="num">${fmtD(c.oldDate)} → ${fmtD(c.newDate)}</span></div>
    <div class="small muted">申請：${esc(uname(c.by))}　承認者：${esc(uname(c.approver))}　後続タスクへの影響 ${n}件</div><div class="small">${esc(c.reason)}</div></button>`;
}

/* 工程変更・期限変更の申請 */
VIEWS['change-new'] = function () {
  const t = TK(ui.params.tid); const p = P(t.pid);
  const cn = ui.cn && ui.cn.tid === t.id ? ui.cn : (ui.cn = { tid: t.id, kind: ui.params.kind || 'slip', reasonType: '', reason: '', newDate: t.due ? addDays(t.due, 5) : T(5), impact: '', comment: '', items: null, excluded: {} });
  const approver = cn.kind === 'due' ? (deptManager(t.dept) || p.pm) : p.pm;
  const selfOk = canApprove(approver);
  let out = `<section class="panel stack">
    <button class="crumb" data-a="task" data-id="${t.id}">${esc(p.name)} ／ ${esc(t.name)}</button>
    <div class="seg"><button type="button" class="${cn.kind === 'slip' ? 'on' : ''}" data-a="cnKind" data-k="slip">工程がずれました</button><button type="button" class="${cn.kind === 'due' ? 'on' : ''}" data-a="cnKind" data-k="due">期限変更を申請</button></div>
    <div class="form-grid">
      <label class="f req"><span>変更理由</span><select class="inp" id="cn-rtype" data-c="cnField" data-k="reasonType"><option value="">選択してください</option>${['天候', '資材・部材の納期', '施主の都合・要望変更', '設計変更', '申請・審査の遅れ', '人員・協力業者の都合', 'その他'].map(r => `<option${r === cn.reasonType ? ' selected' : ''}>${r}</option>`).join('')}</select></label>
      <label class="f"><span>現在の予定日（締切）</span><input class="inp mono" id="cn-old" value="${fmtD(t.due, true)}" readonly></label>
      <label class="f req"><span>変更後の予定日</span><input class="inp" type="date" id="cn-new" value="${esc(cn.newDate)}" data-c="cnDate"></label>
      <label class="f"><span>または 遅延見込み日数</span><input class="inp" type="number" id="cn-days" value="${t.due ? diffDays(cn.newDate, t.due) : ''}" data-c="cnDays"></label>
      <label class="f wide"><span>理由の詳細</span><input class="inp" id="cn-reason" value="${esc(cn.reason)}" data-c="cnField" data-k="reason" placeholder="例：メーカーより6日遅れの連絡あり"></label>
      <label class="f"><span>影響範囲</span><input class="inp" id="cn-impact" value="${esc(cn.impact)}" data-c="cnField" data-k="impact" placeholder="例：内装工事以降"></label>
      <label class="f"><span>コメント</span><input class="inp" id="cn-comment" value="${esc(cn.comment)}" data-c="cnField" data-k="comment"></label>
    </div>
    <div class="hint">承認者：<b>${esc(uname(approver))}</b>（${cn.kind === 'due' ? '担当部署の所属長' : '案件責任者'}）。承認されるまで、どのタスクの日付も変わりません。</div>
    <div class="row"><button class="btn" data-a="cnCalc">後続タスクへの影響を確認</button></div>
  </section>`;
  if (cn.items) out += impactTable(cn.items, cn.excluded, true, p) + `<div class="row" style="justify-content:flex-end"><button class="btn" data-a="back">やめる</button>${selfOk ? `<button class="btn" data-a="cnSubmit" data-self="1">自分で承認して反映</button>` : ''}<button class="btn primary" data-a="cnSubmit">承認を申請する</button></div>`;
  return out;
};
function impactTable(items, excluded, editable, p) {
  const over = items.filter(i => !excluded[i.tid] && p.completionPlanned && i.newDue > p.completionPlanned);
  return `<section class="panel stack"><div class="panel-h"><h2>変更対象のタスク</h2><span class="chip lv-normal num">${items.length}件</span></div>
    <div class="small muted">前後関係から自動で抽出し、必要な分だけ後ろにずらしています。チェックを外したタスクは変更しません（その先のタスクも再計算されます）。</div>
    ${over.length ? `<div class="hint warn">完成予定日（${fmtD(p.completionPlanned)}）を超えるタスクがあります：${over.map(i => esc(TK(i.tid).name)).join('、')}</div>` : ''}
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>変更</th><th>タスク</th><th>担当</th><th>開始</th><th></th><th>締切</th><th>ずれ</th></tr></thead><tbody>
    ${items.map(i => { const t = TK(i.tid); const ex = !!excluded[i.tid]; return `<tr class="${ex ? 'ex' : ''}"><td>${i.origin ? '<span class="tag">起点</span>' : `<input type="checkbox" id="ex-${i.tid}" ${ex ? '' : 'checked'} ${editable ? '' : 'disabled'} data-c="impactEx" data-id="${i.tid}" aria-label="${esc(t.name)}を変更する">`}</td>
      <td class="wrap">${esc(t.name)}</td><td>${esc(sname(t.owner))}</td><td class="old">${i.oldStart ? fmtD(i.oldStart) : '—'}</td><td class="arrow">→</td>
      <td><span class="old">${fmtD(i.oldDue)}</span> <span class="arrow">→</span> <span class="new">${ex ? fmtD(i.oldDue) : fmtD(i.newDue)}</span></td><td class="num">${ex ? '0' : '+' + diffDays(i.newDue, i.oldDue)}日</td></tr>`; }).join('')}
    </tbody></table></div></section>`;
}
VIEWS.change = function () {
  const c = S.changes.find(x => x.id === ui.params.id); if (!c) return '<div class="empty">申請が見つかりません</div>';
  const t = TK(c.tid), p = P(c.pid);
  const can = c.status === 'pending' && canApprove(c.approver);
  const ex = {}; c.items.forEach(i => { if (i.excluded) ex[i.tid] = true; });
  let out = `<section class="panel stack">
    <div class="row" style="gap:6px"><span class="chip rq-${c.status === 'pending' ? 'pending' : c.status === 'applied' ? 'approved' : c.status}">${{ pending: '承認待ち', applied: '反映済み', rejected: '却下', returned: '差戻し' }[c.status]}</span><span class="tag">${c.kind === 'due' ? '期限変更' : '工程変更'}</span><button class="crumb" data-a="project" data-id="${p.id}">${esc(p.name)}</button></div>
    <h2>${esc(t.name)}：<span class="num">${fmtD(c.oldDate)} → ${fmtD(c.newDate)}</span>（${diffDays(c.newDate, c.oldDate) > 0 ? '+' : ''}${diffDays(c.newDate, c.oldDate)}日）</h2>
    <dl class="kv"><dt>申請者</dt><dd>${esc(uname(c.by))}　${fmtDT(c.at)}</dd><dt>承認者</dt><dd>${esc(uname(c.approver))}</dd><dt>変更理由</dt><dd>${esc(c.reason)}</dd><dt>影響範囲</dt><dd>${esc(c.impact || '—')}</dd><dt>コメント</dt><dd>${esc(c.comment || '—')}</dd>${c.decisionComment ? `<dt>承認者コメント</dt><dd>${esc(c.decisionComment)}</dd>` : ''}</dl>
  </section>`;
  out += impactTable(c.items, ex, can, p);
  if (can) out += `<section class="panel stack"><label class="f"><span>コメント（差し戻し・却下の場合は必須）</span><textarea class="inp" id="ch-comment"></textarea></label>
    <div class="row" style="justify-content:flex-end"><button class="btn danger" data-a="chDecide" data-id="${c.id}" data-k="rejected">却下</button><button class="btn" data-a="chDecide" data-id="${c.id}" data-k="returned">差し戻す</button><button class="btn primary" data-a="chDecide" data-id="${c.id}" data-k="applied">承認して一括反映</button></div></section>`;
  else if (c.status === 'pending') out += `<div class="hint">承認者（${esc(uname(c.approver))}）の承認を待っています。</div>`;
  return out;
};

/* 通知 */
function nItem(n) {
  return `<button class="nitem${n.read ? '' : ' unread'}" data-a="notice" data-id="${n.id}"><span class="udot${n.read ? ' read' : ''}"></span><span><span class="nt">${esc(n.text)}</span><br><span class="nm">${fmtDT(n.at)}</span></span><span class="chip lv-${n.level}">${{ urgent: '緊急', important: '重要', normal: '通常' }[n.level]}</span></button>`;
}
function deadlineAlerts() {
  const out = [];
  const my = S.tasks.filter(t => t.owner === S.me && isOpen(t) && t.due && t.status !== '下書き');
  for (const t of my) {
    const d = diffDays(t.due, TODAY);
    if (d < 0 && S.settings.overdue) out.push({ t, level: 'urgent', l: '締切超過（' + (-d) + '日）' });
    else if (S.settings.alertDays.includes(d)) out.push({ t, level: d <= 1 ? 'important' : 'normal', l: d === 0 ? '今日が締切' : d === 1 ? '明日が締切' : '締切' + d + '日前' });
  }
  if (['manager', 'exec', 'admin'].includes(me().role) || S.projects.some(isPM)) {
    for (const t of S.tasks.filter(t => t.owner !== S.me && isOpen(t) && t.due && t.due < TODAY && (isPM(P(t.pid)) || isDeptMgr(t.dept)))) out.push({ t, level: 'urgent', l: '担当 ' + sname(t.owner) + ' の締切超過（' + diffDays(TODAY, t.due) + '日）' });
  }
  return out.sort((a, b) => (a.level === 'urgent' ? 0 : 1) - (b.level === 'urgent' ? 0 : 1));
}
VIEWS.notices = function () {
  const mineN = S.notifications.filter(n => n.uid === S.me).sort((a, b) => b.at - a.at);
  const imp = mineN.filter(n => n.level !== 'normal'), nor = mineN.filter(n => n.level === 'normal');
  const al = deadlineAlerts();
  const g = new Map(); for (const n of nor) { const k = n.link && n.link.v === 'task' && TK(n.link.id) ? P(TK(n.link.id).pid).name : n.link && n.link.v === 'project' ? P(n.link.id).name : 'その他'; if (!g.has(k)) g.set(k, []); g.get(k).push(n); }
  return `<div class="row" style="justify-content:space-between"><span class="muted small">緊急・期限超過・承認待ちは上に目立たせ、通常の通知は案件ごとにまとめています。</span><button class="btn sm" data-a="readAll">すべて既読にする</button></div>
  <section class="panel"><div class="panel-h"><h2>締切アラート</h2><span class="muted small">毎朝自動で判定（通知タイミングは個人設定で変更）</span></div>${al.map(a => `<button class="nitem" data-a="task" data-id="${a.t.id}"><span class="udot"></span><span><span class="nt"><b>${esc(a.l)}</b>　${esc(a.t.name)}</span><br><span class="nm">${esc(P(a.t.pid).name)}・締切 ${fmtD(a.t.due)}</span></span><span class="chip lv-${a.level}">${{ urgent: '緊急', important: '警告', normal: '通知' }[a.level]}</span></button>`).join('') || '<div class="empty">締切アラートはありません</div>'}</section>
  <section class="panel"><div class="panel-h"><h2>重要</h2></div>${imp.map(nItem).join('') || '<div class="empty">重要な通知はありません</div>'}</section>
  <section class="panel"><div class="panel-h"><h2>通常</h2></div>${[...g.entries()].map(([k, ns]) => `<div class="grp-h">${esc(k)}<span class="chip lv-normal num">${ns.length}</span></div>${ns.map(nItem).join('')}`).join('') || '<div class="empty">通常の通知はありません</div>'}</section>`;
};

/* 決定事項 */
VIEWS.decisions = function () {
  const list = S.decisions.slice().sort((a, b) => a.on < b.on ? 1 : -1);
  return `<div class="hint">通常のコメントと分けて、正式に決まったことだけを記録します。タスク詳細のコメント欄、または案件詳細の「決定事項を登録」から追加できます。</div><div class="stack">${list.map(decCard).join('') || '<div class="empty">決定事項はありません</div>'}</div>`;
};

/* 部署別の負荷 */
VIEWS.load = function () {
  const users = S.users.filter(u => u.active && u.role !== 'viewer');
  const rows = users.map(u => { const ts = S.tasks.filter(t => t.owner === u.id && isOpen(t) && t.status !== '下書き'); return { u, n: ts.length, over: ts.filter(t => t.due < TODAY).length, soon: ts.filter(t => t.due >= TODAY && t.due <= T(14)).length, wait: ts.filter(t => ['承認待ち', '確認待ち', '回答待ち'].includes(t.status)).length }; }).filter(r => r.n);
  const max = Math.max(1, ...rows.map(r => r.n));
  return `<section class="panel"><div class="panel-h"><h2>部署別</h2></div>${loadBars()}</section>
  <section class="panel"><div class="panel-h"><h2>担当者別</h2><span class="muted small">未完了の正式タスク</span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>担当者</th><th>部署</th><th>件数</th><th>期限超過</th><th>2週間以内</th><th>待ち</th><th style="width:40%">量</th></tr></thead><tbody>
    ${rows.sort((a, b) => b.n - a.n).map(r => `<tr><td>${esc(r.u.name)}</td><td>${esc(deptName(r.u.dept))}</td><td class="num">${r.n}</td><td class="num" style="${r.over ? 'color:var(--bad);font-weight:700' : ''}">${r.over}</td><td class="num">${r.soon}</td><td class="num">${r.wait}</td><td><div class="load" style="grid-template-columns:1fr;padding:0"><span class="lb"><i class="b" style="width:${r.over / max * 100}%"></i><i class="a" style="width:${r.soon / max * 100}%"></i><i class="c" style="width:${(r.n - r.over - r.soon) / max * 100}%"></i></span></div></td></tr>`).join('')}
    </tbody></table></div></section>`;
};

/* 個人設定（プッシュ通知は形だけ） */
VIEWS.settings = function () {
  const s = S.settings;
  return `<section class="panel stack"><h2>締切通知のタイミング</h2>
    <div class="row">${[7, 3, 1, 0].map(d => `<label class="switch"><input type="checkbox" id="al-${d}" data-c="alertDay" data-d="${d}" ${s.alertDays.includes(d) ? 'checked' : ''}>${d === 0 ? '当日' : d === 1 ? '前日' : d + '日前'}</label>`).join('')}<label class="switch"><input type="checkbox" id="al-over" data-c="alertOver" ${s.overdue ? 'checked' : ''}>超過時（責任者にも通知）</label></div>
    <div class="small muted">初期設定：7日前・3日前は通知、前日・当日は警告、超過は担当者と責任者へ通知。</div></section>
  <section class="panel stack"><h2>メール通知</h2>
    <label class="switch"><input type="radio" name="mail" id="ml-d" data-c="mail" value="digest" ${s.mail === 'digest' ? 'checked' : ''}>緊急・重要は即時、それ以外は1日2回（8:00／13:00）まとめて送る</label>
    <label class="switch"><input type="radio" name="mail" id="ml-i" data-c="mail" value="instant" ${s.mail === 'instant' ? 'checked' : ''}>すべて即時に送る</label>
    <label class="switch"><input type="radio" name="mail" id="ml-o" data-c="mail" value="off" ${s.mail === 'off' ? 'checked' : ''}>緊急・重要のみ送る</label></section>
  <section class="panel stack"><div class="panel-h"><h2>スマートフォンへのプッシュ通知</h2><span class="chip lv-important">準備中</span></div>
    <div class="hint">第2段階で対応予定です。今は画面と設定の形だけ用意しています。iPhoneの場合は、Safariの共有メニューから「ホーム画面に追加」したうえで通知を許可する必要があります。</div>
    <dl class="kv"><dt>この端末</dt><dd>未登録</dd><dt>対象の通知</dt><dd>緊急・承認依頼・依頼の受信・締切超過</dd></dl>
    <label class="switch"><input type="checkbox" id="push-on" data-c="push" ${s.push ? 'checked' : ''}>この端末でプッシュ通知を受け取る（準備中）</label>
    <div class="row"><button class="btn" data-a="pushTest">通知の見え方を試す</button></div></section>
  <section class="panel stack"><h2>試作データ</h2><div class="small muted">操作した内容はこのブラウザにだけ保存されます。サンプルの日付を今日に合わせるため、日付が変わると初期状態に戻ります。</div><div><button class="btn danger" data-a="resetAsk">試作データを初期状態に戻す</button></div></section>`;
};

/* メニュー（スマホ） */
VIEWS.menu = function () {
  const u = me();
  return `<section class="panel stack"><div class="me-card" style="padding:0"><div class="avatar">${esc(initials(u.id))}</div><div><div style="font-weight:700">${esc(u.name)}</div><div class="small muted">${esc(deptName(u.dept))}・${esc(ROLES[u.role])}</div></div></div>
    <label class="f"><span>試作用：ログインユーザー切替</span><select class="inp" id="sw-user-m" data-c="switchUser">${S.users.filter(x => x.active).map(x => `<option value="${x.id}"${x.id === u.id ? ' selected' : ''}>${esc(x.name)}（${esc(deptName(x.dept))}・${esc(ROLES[x.role])}）</option>`).join('')}</select></label></section>
  <section class="panel" style="padding:6px">${NAV.filter(n => showNav(n[1]) && !['home', 'tasks', 'notices'].includes(n[1])).map(([sec, v, l, ic]) => `<button class="nav-item" data-a="nav" data-v="${v}">${ico(ic)}<span>${l}</span>${sec ? `<span class="tag cnt">${sec}</span>` : ''}</button>`).join('')}</section>
  <button class="btn" data-a="logout">ログアウト</button>`;
};

/* ---------- 管理：案件条件 ---------- */
VIEWS['admin-cond'] = function () {
  const can = canMasterAll();
  return `${can ? '' : '<div class="hint">閲覧のみ（編集はシステム管理者・権限を付与された役員のみ）</div>'}
  <div class="hint info">ここで追加・無効化した条件は、案件登録ウィザードの選択肢にすぐ反映されます。無効化しても過去の案件のデータは残ります。</div>
  <section class="panel">${S.groups.slice().sort((a, b) => a.order - b.order).map(g => `<div class="cond-g"><div class="gn">${esc(g.name)}${g.parent ? `<small>表示条件：「${esc(optLabel(g.parent))}」</small>` : ''}${can ? `<br><button class="btn sm ghost" data-a="grpToggle" data-id="${g.id}">${g.active ? 'グループを無効化' : 'グループを有効化'}</button>` : ''}</div>
    <div class="stack" style="gap:6px"><div class="opts">${S.options.filter(o => o.group === g.id).map(o => `<button class="opt${o.active ? '' : ' off'}" ${can ? `data-a="optToggle" data-id="${o.id}" title="クリックで${o.active ? '無効化' : '有効化'}"` : 'disabled'}>${esc(o.label)}</button>`).join('')}</div>
    ${can ? `<form class="row" data-f="optAdd" data-g="${g.id}"><input class="inp" id="oa-${g.id}" placeholder="選択肢を追加" style="max-width:220px"><button class="btn sm">追加</button></form>` : ''}</div></div>`).join('')}</section>
  ${can ? `<form class="panel row" data-f="grpAdd"><input class="inp" id="ga-name" placeholder="新しい条件グループ名（例：外構工事）" style="max-width:280px"><input class="inp" id="ga-opts" placeholder="選択肢をカンマ区切り（例：あり,なし）" style="max-width:280px"><button class="btn primary">条件グループを追加</button></form>` : ''}`;
};

/* ---------- 管理：テンプレート ---------- */
VIEWS['admin-tpl'] = function () {
  const sel = new Set(ui.testSel || ['k_house', 'w_new', 'permit_yes']);
  const test = planTasks(S, { conditions: [...sel], createdOn: TODAY, contractPlanned: T(30), startPlanned: T(90), completionPlanned: T(210), handoverPlanned: T(220), sales: 'u1', design: 'u3', construction: 'u5', pm: 'u2' });
  return `<div class="hint info">タスクごとに、担当部署・基準日・日数・前後関係・完了承認の有無・生成条件を設定します。変更は新しく登録する案件から反映され、既存の案件のタスクは変わりません。</div>
  <section class="panel"><div class="panel-h"><h2>標準タスク</h2><span class="chip lv-normal num">${S.templates.length}</span>${canMasterAll() ? `<button class="btn sm primary" data-a="tplNew">${ico('plus')}テンプレートを追加</button>` : ''}</div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>コード</th><th>タスク名</th><th>部署</th><th>締切の計算</th><th>所要</th><th>生成条件（いずれか）</th><th>完了承認</th><th>状態</th></tr></thead><tbody>
  ${S.templates.map(t => `<tr style="cursor:pointer" data-a="tplEdit" data-code="${t.code}"><td class="mono">${t.code}</td><td class="wrap"><b>${esc(t.name)}</b></td><td>${esc(deptName(t.dept))}</td><td>${esc(basisText(t))}</td><td class="num">${t.duration}日</td><td class="wrap">${t.rules.length ? t.rules.map(r => r.map(optLabel).map(esc).join(' ＋ ')).join('<br>または ') : '<span class="muted">全案件</span>'}</td><td>${t.needApproval ? 'あり' : '—'}</td><td>${t.active ? '有効' : '<span class="muted">無効</span>'}</td></tr>`).join('')}
  </tbody></table></div></section>
  <section class="panel stack"><div class="panel-h"><h2>テスト生成</h2><span class="muted small">条件を選ぶと、生成されるタスクをその場で確認できます</span></div>
    ${S.groups.filter(g => g.active && (!g.parent || sel.has(g.parent))).map(g => `<div class="cond-g"><div class="gn">${esc(g.name)}</div><div class="opts">${S.options.filter(o => o.group === g.id && o.active).map(o => `<button class="opt${sel.has(o.id) ? ' on' : ''}" data-a="testOpt" data-o="${o.id}">${esc(o.label)}</button>`).join('')}</div></div>`).join('')}
    <div class="hint">生成されるタスク：<b class="num">${test.length}</b>件（契約30日後・着工90日後などの仮の日付で計算）</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>タスク</th><th>部署</th><th>締切</th><th>該当した条件</th></tr></thead><tbody>${test.sort(byDue).map(x => `<tr><td>${esc(x.name)}</td><td>${esc(deptName(x.dept))}</td><td class="num">${fmtD(x.due)}</td><td class="wrap small">${x.rule ? x.rule.map(optLabel).map(esc).join(' ＋ ') : '全案件'}</td></tr>`).join('')}</tbody></table></div>
  </section>`;
};
function tplSheet() {
  const t = ui.tplEdit; const can = canMasterTpl(t);
  const optSel = (ri) => `<select class="inp" id="ra-${ri}" data-c="ruleAdd" data-r="${ri}" style="max-width:240px;padding:4px 6px"><option value="">＋ 条件を追加</option>${S.groups.map(g => `<optgroup label="${esc(g.name)}">${S.options.filter(o => o.group === g.id).map(o => `<option value="${o.id}">${esc(g.name)}：${esc(o.label)}</option><option value="!${o.id}">${esc(g.name)}：${esc(o.label)} 以外</option>`).join('')}</optgroup>`).join('')}</select>`;
  const body = `${can ? '' : '<div class="hint">閲覧のみ（このテンプレートを編集する権限がありません）</div>'}
  <div class="form-grid">
    <label class="f req wide"><span>タスク名</span><input class="inp" id="te-name" value="${esc(t.name)}" data-c="teField" data-k="name"></label>
    <label class="f"><span>標準担当部署</span><select class="inp" id="te-dept" data-c="teField" data-k="dept">${deptOpts(t.dept)}</select></label>
    <label class="f"><span>基準日</span><select class="inp" id="te-base" data-c="teField" data-k="base">${Object.entries(BASE_LABEL).map(([k, l]) => `<option value="${k}"${k === t.base ? ' selected' : ''}>${l}${k === 'pred' ? '（前工程の1つ目の締切）' : ''}</option>`).join('')}</select></label>
    <label class="f"><span>基準日からの日数（前はマイナス）</span><input class="inp" type="number" id="te-offset" value="${t.offset}" data-c="teField" data-k="offset"></label>
    <label class="f"><span>日数の数え方</span><select class="inp" id="te-day" data-c="teField" data-k="dayType"><option value="cal"${t.dayType === 'cal' ? ' selected' : ''}>暦日</option><option value="biz"${t.dayType === 'biz' ? ' selected' : ''}>営業日（土日祝・会社休日を除く）</option></select></label>
    <label class="f"><span>標準所要日数</span><input class="inp" type="number" id="te-dur" value="${t.duration}" data-c="teField" data-k="duration"></label>
    <label class="switch"><input type="checkbox" id="te-ap" data-c="teField" data-k="needApproval" ${t.needApproval ? 'checked' : ''}>完了に承認が必要（承認者＝案件責任者）</label>
    <label class="switch"><input type="checkbox" id="te-act" data-c="teField" data-k="active" ${t.active ? 'checked' : ''}>有効</label>
  </div>
  <div class="hint info">締切の計算：<b>${esc(basisText(t))}</b></div>
  <h3>前工程</h3>
  <div class="opts">${S.templates.filter(x => x.code !== t.code).map(x => `<button class="opt${t.preds.includes(x.code) ? ' on' : ''}" data-a="tePred" data-code="${x.code}">${esc(x.name)}</button>`).join('')}</div>
  <h3>生成条件</h3>
  <div class="small muted">ルールのどれか1つに当てはまれば生成します。1つのルールの中の条件は「すべて」満たす必要があります。ルールが無い場合は全案件で生成します。</div>
  ${t.rules.map((r, ri) => `<div class="row" style="border:1px solid var(--line);border-radius:8px;padding:8px"><b class="small">ルール${ri + 1}</b>${r.map((o, oi) => `<span class="chip lv-normal">${esc(optLabel(o))}<button class="btn sm ghost" style="padding:0 4px" data-a="ruleDel" data-r="${ri}" data-o="${oi}" aria-label="削除">×</button></span>`).join(' ＋ ')}${optSel(ri)}<button class="btn sm ghost" data-a="ruleRm" data-r="${ri}">ルールを削除</button></div>`).join('<div class="small muted">または</div>')}
  <div><button class="btn sm" data-a="ruleNew">＋ ルールを追加</button></div>
  <h3>チェックリスト（改行区切り）</h3>
  <textarea class="inp" id="te-check" data-c="teField" data-k="checklist">${esc(t.checklist.join('\n'))}</textarea>`;
  openSheet((t.isNew ? '新規テンプレート' : t.code + '：' + t.name), body, can ? `<button class="btn" data-a="closeSheet">キャンセル</button><button class="btn primary" data-a="tplSave">保存</button>` : '', true);
}

/* ---------- 管理：権限 ---------- */
VIEWS['admin-perm'] = function () {
  const can = pv('user_admin') === 'all';
  const roles = Object.keys(ROLES);
  return `${can ? '<div class="hint info">セルを押すと ◎ → ○ → △ → × の順に切り替わります。変更はすぐに反映されます（試作ではログインユーザーを切り替えて確認できます）。</div>' : '<div class="hint">閲覧のみ（変更はシステム管理者のみ）</div>'}
  <div class="legend">${Object.entries(PERM_LABEL).map(([k, l]) => `<span><b class="perm-${k}">${l}</b> ${PERM_TEXT[k]}</span>`).join('')}</div>
  <div class="small muted">「関係がある範囲」＝自分が担当・協力者のタスク、自分が案件責任者の案件、所属長は自部署のタスク。</div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>操作</th>${roles.map(r => `<th>${ROLES[r]}</th>`).join('')}</tr></thead><tbody>
  ${PERM_DEFS.map(([k, l]) => `<tr><td>${l}</td>${roles.map(r => { const v = S.perms[r][k]; return `<td><button class="perm-cell perm-${v}" ${can ? `data-a="permCycle" data-r="${r}" data-k="${k}"` : 'disabled'} title="${PERM_TEXT[v]}">${PERM_LABEL[v]}</button></td>`; }).join('')}</tr>`).join('')}
  </tbody></table></div>
  <div class="small muted">※「案件責任者」は役職ではなく案件ごとの役割として扱います（案件登録時に指定）。</div>`;
};

/* ---------- 管理：ユーザー ---------- */
VIEWS['admin-users'] = function () {
  const can = pv('user_admin') === 'all';
  return `${can ? '' : '<div class="hint">閲覧のみ（変更はシステム管理者のみ）</div>'}
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>氏名</th><th>部署</th><th>役割</th><th>利用</th></tr></thead><tbody>
  ${S.users.map(u => `<tr><td>${esc(u.name)}</td><td><select class="inp" id="ud-${u.id}" data-c="userDept" data-id="${u.id}" ${can ? '' : 'disabled'} style="padding:3px 6px">${deptOpts(u.dept)}</select></td><td><select class="inp" id="ur-${u.id}" data-c="userRole" data-id="${u.id}" ${can ? '' : 'disabled'} style="padding:3px 6px">${Object.entries(ROLES).map(([k, l]) => `<option value="${k}"${k === u.role ? ' selected' : ''}>${l}</option>`).join('')}</select></td><td><label class="switch"><input type="checkbox" id="ua-${u.id}" data-c="userActive" data-id="${u.id}" ${u.active ? 'checked' : ''} ${can ? '' : 'disabled'}>${u.active ? '有効' : '無効'}</label></td></tr>`).join('')}
  </tbody></table></div>
  ${can ? `<form class="panel row" data-f="userAdd"><input class="inp" id="ua-name" placeholder="氏名" style="max-width:200px" required><select class="inp" id="ua-dept" style="max-width:160px">${deptOpts('sales')}</select><select class="inp" id="ua-role" style="max-width:180px">${Object.entries(ROLES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select><button class="btn primary">ユーザーを追加</button></form>
  <form class="panel row" data-f="deptAdd"><input class="inp" id="da-name" placeholder="部署名" style="max-width:200px" required><button class="btn">部署を追加</button></form>` : ''}
  <div class="small muted">退職者は削除せず「無効」にします（過去の履歴に名前を残すため）。</div>`;
};

/* ---------- 管理：操作ログ ---------- */
VIEWS['admin-log'] = function () {
  const acts = S.activities.slice().sort((a, b) => b.at - a.at).slice(0, 150);
  return `<div class="small muted">誰が・いつ・何をしたかを記録しています。記録は追記のみで、編集・削除はできません。</div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>日時</th><th>操作者</th><th>案件</th><th>内容</th></tr></thead><tbody>
  ${acts.map(a => `<tr><td class="num">${fmtDT(a.at)}</td><td>${esc(uname(a.uid))}</td><td>${esc((P(a.pid) || {}).name || '—')}</td><td class="wrap">${esc(a.text)}${a.tid && TK(a.tid) ? '「' + esc(TK(a.tid).name) + '」' : ''}${a.diff ? '<br><span class="small mono">' + a.diff.map(d => esc(d.f + '：' + d.o + ' → ' + d.n)).join(' / ') + '</span>' : ''}</td></tr>`).join('')}
  </tbody></table></div>`;
};

/* ==========================================================
 * 操作
 * ========================================================== */
const A = {}, C = {}, F = {}, I = {};

A.nav = el => { if (el.dataset.v === 'wizard') wizInit(); go(el.dataset.v); };
A.back = () => back();
A.scrim = (el, e) => { if (e.target === el) closeSheet(); };
A.closeSheet = () => closeSheet();
A.loginAs = el => { S.me = el.dataset.id; try { localStorage.setItem(KEY + '-me', S.me); } catch (e) { } ui.stack = []; go('home', {}, true); toast(uname(S.me) + 'さんとしてログインしました'); };
F.login = () => { S.me = 'u1'; try { localStorage.setItem(KEY + '-me', S.me); } catch (e) { } go('home', {}, true); };
A.logout = () => { S.me = null; try { localStorage.removeItem(KEY + '-me'); } catch (e) { } ui.view = 'login'; ui.stack = []; render(); };
C.switchUser = el => { S.me = el.value; try { localStorage.setItem(KEY + '-me', S.me); } catch (e) { } ui.cn = null; ui.ract = null; render(); toast(uname(S.me) + 'さん（' + ROLES[me().role] + '）に切り替えました'); };
A.task = el => go('task', { id: el.dataset.id });
A.project = el => { ui.ptab = 'tasks'; go('project', { id: el.dataset.id }); };
A.request = el => { ui.ract = null; go('request', { id: el.dataset.id }); };
A.change = el => go('change', { id: el.dataset.id });
A.taskFilter = el => { ui.tf = el.dataset.f; if (ui.view !== 'tasks') go('tasks'); else render(); };
C.tfUser = el => { ui.tfUser = el.value; render(); };
C.tfDept = el => { ui.tfDept = el.value; render(); };
C.tfProj = el => { ui.tfProj = el.value; render(); };
let qT;
I.tq = el => { ui.q = el.value; clearTimeout(qT); qT = setTimeout(() => { render(); const x = document.getElementById('tq'); if (x) { x.focus(); x.setSelectionRange(x.value.length, x.value.length); } }, 250); };
I.pq = el => { ui.pq = el.value; clearTimeout(qT); qT = setTimeout(() => { render(); const x = document.getElementById('pq'); if (x) { x.focus(); x.setSelectionRange(x.value.length, x.value.length); } }, 250); };
A.pk = el => { ui.pk = el.dataset.k; render(); };
A.ptab = el => { ui.ptab = el.dataset.k; render(); };
A.rtab = el => { ui.rtab = el.dataset.k; render(); };
A.notice = el => { const n = S.notifications.find(x => x.id === el.dataset.id); n.read = true; const l = n.link; if (l && l.id) { if (l.v === 'task') go('task', { id: l.id }); else if (l.v === 'request') { ui.ract = null; go('request', { id: l.id }); } else if (l.v === 'change') go('change', { id: l.id }); else if (l.v === 'project') { ui.ptab = 'tasks'; go('project', { id: l.id }); } } else render(); };
A.readAll = () => { S.notifications.filter(n => n.uid === S.me).forEach(n => n.read = true); render(); toast('すべて既読にしました'); };

/* ウィザード */
A.wizStart = () => { wizInit(); go('wizard'); };
F.wiz1 = () => {
  const p = ui.wiz.p;
  for (const k of ['name', 'customer', 'no', 'address', 'sales', 'design', 'construction', 'pm', 'contractPlanned', 'contractDate', 'startPlanned', 'completionPlanned', 'handoverPlanned', 'visibility', 'note']) p[k] = val('w-' + k) || null;
  ui.wiz.step = 2; render(); window.scrollTo(0, 0);
};
A.wizOpt = el => {
  const p = ui.wiz.p; const o = S.options.find(x => x.id === el.dataset.o);
  const had = p.conditions.includes(o.id);
  p.conditions = p.conditions.filter(id => S.options.find(x => x.id === id).group !== o.group);
  if (!had) p.conditions.push(o.id);
  // 親条件が外れたグループの選択を消す
  const sel = new Set(p.conditions);
  p.conditions = p.conditions.filter(id => { const g = S.groups.find(g => g.id === S.options.find(x => x.id === id).group); return !g.parent || sel.has(g.parent); });
  render();
};
A.wizStep = el => { ui.wiz.step = +el.dataset.s; render(); window.scrollTo(0, 0); };
C.wizInc = el => { ui.wiz.excluded[el.dataset.code] = !el.checked; render(); };
C.wizOwner = el => { ui.wiz.owners[el.dataset.code] = el.value || null; };
A.wizSubmit = () => {
  const w = ui.wiz; const p = { ...w.p, id: nid(S, 'p'), createdOn: TODAY, status: '準備中', confidential: null };
  p.conditions = p.conditions.slice();
  S.projects.unshift(p);
  const plan = planTasks(S, p); plan.forEach(x => { x.include = !w.excluded[x.code]; if (w.owners[x.code] !== undefined) x.owner = w.owners[x.code]; });
  const created = createTasksFromPlan(S, p, plan, S.me);
  const exNames = plan.filter(x => !x.include).map(x => x.name);
  log({ pid: p.id, type: 'project.created', text: '案件を登録し、標準タスクを' + created.length + '件自動生成しました', comment: exNames.length ? '除外：' + exNames.join('、') + (val('w-exreason') ? '（理由：' + val('w-exreason') + '）' : '') : '' });
  const byOwner = {}; for (const t of created) if (t.owner) (byOwner[t.owner] = byOwner[t.owner] || []).push(t);
  for (const [uid, ts] of Object.entries(byOwner)) notify([uid], 'normal', `「${p.name}」でタスクが${ts.length}件割り当てられました`, { v: 'project', id: p.id });
  ui.wiz = null; ui.ptab = 'tasks'; ui.stack = [{ view: 'projects', params: {} }];
  go('project', { id: p.id }, true);
  toast('案件を登録しました（タスク' + created.length + '件）');
};

/* 案件：日程編集 */
A.editDates = el => {
  const p = P(el.dataset.id);
  const f = (id, l, v) => `<label class="f"><span>${l}</span><input class="inp" type="date" id="${id}" value="${esc(v || '')}"></label>`;
  openSheet('日程を編集', `<div class="form-grid">${f('ed-cp', '契約予定日', p.contractPlanned)}${f('ed-cd', '契約日（実績）', p.contractDate)}${f('ed-sp', '着工予定日', p.startPlanned)}${f('ed-comp', '完成予定日', p.completionPlanned)}${f('ed-hp', '引渡予定日', p.handoverPlanned)}</div>
    <div class="hint">「日付未確定」のタスクは、ここで入力した日付から締切が自動計算され、下書きのまま残ります（内容を確認してから正式タスクにします）。すでに締切が確定しているタスクは自動では変わりません。</div>`,
    `<button class="btn" data-a="closeSheet">キャンセル</button><button class="btn primary" data-a="saveDates" data-id="${p.id}">保存</button>`);
};
A.saveDates = el => {
  const p = P(el.dataset.id); const diff = [];
  const map = [['contractPlanned', 'ed-cp', '契約予定日'], ['contractDate', 'ed-cd', '契約日'], ['startPlanned', 'ed-sp', '着工予定日'], ['completionPlanned', 'ed-comp', '完成予定日'], ['handoverPlanned', 'ed-hp', '引渡予定日']];
  for (const [k, id, l] of map) { const v = val(id) || null; if (v !== p[k]) { diff.push({ f: l, o: p[k] ? fmtD(p[k]) : '未定', n: v ? fmtD(v) : '未定' }); p[k] = v; } }
  closeSheet();
  if (!diff.length) return;
  const ch = recalcPending(S, p);
  log({ pid: p.id, type: 'change.dates', text: '案件の日程を変更しました', diff, comment: ch.length ? '日付未確定だったタスク' + ch.length + '件の締切を自動計算しました' : '' });
  const fixed = S.tasks.filter(t => t.pid === p.id && t.dueStatus === 'fixed' && t.origin === 'auto' && isOpen(t) && !ch.includes(t));
  const affected = fixed.filter(t => { const x = planTasks(S, p).find(y => y.code === t.code); return x && x.due && x.due !== t.due; });
  notify([p.sales, p.design, p.construction], 'normal', `「${p.name}」の日程が変更されました`, { v: 'project', id: p.id });
  render();
  toast(ch.length ? `締切を自動計算しました（${ch.length}件）。下書きを確認してください` : '日程を保存しました');
  if (affected.length) setTimeout(() => toast(`締切が確定済みのタスク${affected.length}件は自動では変更していません。必要なら工程変更として申請してください`), 3400);
};
A.promote = el => { const t = TK(el.dataset.id); t.status = '未着手'; t.dueStatus = 'fixed'; touch(t); log({ pid: t.pid, tid: t.id, type: 'task.promote', text: '正式タスクにしました（未着手）' }); notify([t.owner], 'normal', `タスク「${t.name}」が割り当てられました`, { v: 'task', id: t.id }); render(); toast('正式タスクにしました'); };
A.promoteAll = el => { const ts = S.tasks.filter(t => t.pid === el.dataset.id && t.status === '下書き' && t.due && t.owner); ts.forEach(t => { t.status = '未着手'; touch(t); }); log({ pid: el.dataset.id, type: 'task.promote', text: '下書きのタスク' + ts.length + '件を正式タスクにしました' }); const by = {}; ts.forEach(t => (by[t.owner] = (by[t.owner] || 0) + 1)); Object.entries(by).forEach(([u, n]) => notify([u], 'normal', `「${P(el.dataset.id).name}」でタスクが${n}件割り当てられました`, { v: 'project', id: el.dataset.id })); render(); toast(ts.length + '件を正式タスクにしました'); };
function touch(t) { t.updatedAt = Date.now(); t.updatedBy = S.me; }

/* 手動タスク追加 */
A.addTask = el => {
  const p = P(el.dataset.id);
  openSheet('タスクを追加', `<div class="form-grid">
    <label class="f req wide"><span>タスク名</span><input class="inp" id="at-name" placeholder="例：外構プランの作成"></label>
    <label class="f"><span>担当部署</span><select class="inp" id="at-dept">${deptOpts(me().dept)}</select></label>
    <label class="f req"><span>主担当者</span><select class="inp" id="at-owner" data-c="atOwner" data-pid="${p.id}">${userOpts(S.me)}</select></label>
    <label class="f req"><span>締切日</span><input class="inp" type="date" id="at-due" value="${T(7)}"></label>
    <label class="f"><span>優先度</span><select class="inp" id="at-pri"><option>中</option><option>高</option><option>低</option></select></label>
    <label class="f"><span>前工程</span><select class="inp" id="at-pred"><option value="">なし</option>${S.tasks.filter(t => t.pid === p.id && t.status !== '取消').map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
    <label class="f wide"><span>説明</span><textarea class="inp" id="at-desc"></textarea></label></div>
    <div id="at-hint">${addHint(p, S.me)}</div>`,
    `<button class="btn" data-a="closeSheet">キャンセル</button><button class="btn primary" data-a="addTaskSave" data-pid="${p.id}">追加</button>`);
};
function addHint(p, owner) { const m = addMode(p, owner); return m === 'direct' ? '<div class="hint info">正式タスクとしてすぐ追加されます。</div>' : m === 'request' ? '<div class="hint warn">他の人を担当者にするため「依頼」として送信されます。相手（または所属長）が承認すると正式タスクになります。</div>' : '<div class="hint warn">この案件にタスクを追加する権限がありません。</div>'; }
C.atOwner = el => { document.getElementById('at-hint').innerHTML = addHint(P(el.dataset.pid), el.value); };
A.addTaskSave = el => {
  const p = P(el.dataset.pid); const name = val('at-name'), owner = val('at-owner'), due = val('at-due');
  if (!name || !owner || !due) { toast('タスク名・担当者・締切日を入力してください'); return; }
  const m = addMode(p, owner);
  if (m === 'none') { toast('追加する権限がありません'); return; }
  if (m === 'request') {
    const r = { id: nid(S, 'r'), pid: p.id, from: S.me, toDept: U(owner).dept, toUser: owner, receiver: owner, title: name, content: val('at-desc'), reason: 'タスクの追加依頼', desired: due, urgency: val('at-pri') === '高' ? '急ぎ' : '通常', status: 'sent', history: [{ uid: S.me, act: '依頼を送信（タスク追加）', at: Date.now() }], createdAt: Date.now() };
    S.requests.push(r); log({ pid: p.id, type: 'request.sent', text: uname(owner) + 'さんへ依頼を送信「' + name + '」' });
    notify([owner], 'important', `${uname(S.me)}さんから依頼「${name}」が届きました`, { v: 'request', id: r.id });
    closeSheet(); render(); toast('依頼として送信しました'); return;
  }
  const t = { id: nid(S, 't'), pid: p.id, code: null, name, dept: val('at-dept'), owner, collaborators: [], watchers: [], approver: null, start: addDays(due, -3), due, dueStatus: 'manual', completedAt: null, priority: val('at-pri'), status: '未着手', desc: val('at-desc'), checklist: [], preds: val('at-pred') ? [val('at-pred')] : [], origin: 'manual', visibility: '全社', createdBy: S.me, createdAt: Date.now(), attachments: [] };
  S.tasks.push(t); log({ pid: p.id, tid: t.id, type: 'task.created', text: 'タスクを手動で追加しました' });
  notify([owner], 'normal', `タスク「${name}」が割り当てられました`, { v: 'task', id: t.id });
  closeSheet(); go('task', { id: t.id }); toast('タスクを追加しました');
};

/* タスク：定型ボタン */
A.quick = el => {
  const t = TK(el.dataset.id); const q = QUICK.find(x => x.code === el.dataset.q);
  if (q.special === 'schedule' || q.special === 'due') { if (!t.due) { toast('締切日が未確定のタスクです'); return; } ui.cn = null; go('change-new', { tid: t.id, kind: q.special === 'due' ? 'due' : 'slip' }); return; }
  if (q.special === 'reqdone') {
    openSheet('完了を申請', `<label class="f req"><span>承認者</span><select class="inp" id="qd-ap">${userOpts(t.approver || P(t.pid).pm, u => ['manager', 'exec'].includes(u.role) || u.id === P(t.pid).pm)}</select></label><label class="f"><span>コメント</span><textarea class="inp" id="qd-c" placeholder="成果物の場所や確認してほしい点"></textarea></label><label class="f"><span>添付</span><input class="inp" type="file" id="qd-f"></label>`,
      `<button class="btn" data-a="closeSheet">キャンセル</button><button class="btn primary" data-a="reqDone" data-id="${t.id}">申請する</button>`);
    return;
  }
  if (!q.comment && !q.file) { doQuick(t, q, ''); return; }
  openSheet(q.label, `${q.code === 'confirm' ? `<label class="f"><span>確認してほしい人</span><select class="inp" id="qa-to">${userOpts(t.approver || P(t.pid).pm)}</select></label>` : ''}
    <label class="f ${q.required ? 'req' : ''}"><span>${q.code === 'issue' ? '何が起きたか' : 'コメント'}${q.required ? '' : '（任意）'}</span><textarea class="inp" id="qa-c"></textarea></label>
    ${q.file || q.code === 'issue' ? '<label class="f"><span>添付ファイル（任意）</span><input class="inp" type="file" id="qa-f"></label>' : ''}
    ${q.code === 'issue' ? '<div class="hint warn">案件責任者と担当部署の所属長にも緊急として通知されます。</div>' : ''}`,
    `<button class="btn" data-a="closeSheet">キャンセル</button><button class="btn primary" data-a="quickSave" data-id="${t.id}" data-q="${q.code}">報告する</button>`);
};
A.quickSave = el => {
  const t = TK(el.dataset.id); const q = QUICK.find(x => x.code === el.dataset.q);
  const c = val('qa-c'); if (q.required && !c) { toast('内容を入力してください'); return; }
  const f = document.getElementById('qa-f'); if (f && f.files[0]) t.attachments.push({ name: f.files[0].name, by: S.me, at: Date.now() });
  const extra = q.code === 'confirm' ? [val('qa-to')] : q.code === 'issue' ? [P(t.pid).pm, deptManager(t.dept)] : [];
  closeSheet(); doQuick(t, q, c, extra);
};
function doQuick(t, q, comment, extra) {
  const old = t.status;
  if (q.next) t.status = q.next;
  if (q.code === 'done') t.completedAt = TODAY;
  touch(t);
  log({ pid: t.pid, tid: t.id, type: 'report.' + q.code, text: q.label + (q.next && old !== q.next ? `（状態：${old} → ${q.next}）` : ''), comment });
  const lvl = q.code === 'issue' ? 'urgent' : q.code === 'confirm' ? 'important' : 'normal';
  const n = notify([...people(t), ...(extra || []), q.code === 'done' ? P(t.pid).pm : null], lvl, `${uname(S.me)}：${q.label}「${t.name}」`, { v: 'task', id: t.id });
  if (q.code === 'done') { for (const s of successors(S, t.id)) if (s.preds.every(pid => { const x = TK(pid); return !x || x.status === '完了'; })) notify([s.owner], 'normal', `前工程「${t.name}」が完了しました。「${s.name}」を開始できます`, { v: 'task', id: s.id }); }
  render(); toast(q.label + '（' + n + '人に通知）');
}
A.reqDone = el => {
  const t = TK(el.dataset.id); const ap = val('qd-ap');
  S.approvals.push({ id: nid(S, 'a'), kind: 'complete', pid: t.pid, tid: t.id, by: S.me, approver: ap, status: 'pending', comment: val('qd-c'), at: Date.now(), prev: t.status });
  t.approver = ap; t.status = '承認待ち'; touch(t);
  log({ pid: t.pid, tid: t.id, type: 'approval.complete', text: '完了を申請しました（承認者：' + uname(ap) + '）', comment: val('qd-c') });
  notify([ap], 'important', `${uname(S.me)}さんから完了申請が届きました「${t.name}」`, { v: 'task', id: t.id });
  closeSheet(); render(); toast('完了を申請しました');
};
A.apDone = el => {
  const a = S.approvals.find(x => x.id === el.dataset.id); const t = TK(a.tid);
  if (el.dataset.k === 'ok') { a.status = 'approved'; t.status = '完了'; t.completedAt = TODAY; log({ pid: t.pid, tid: t.id, type: 'task.done', text: '完了申請を承認しました（完了）' }); notify([a.by, ...people(t)], 'normal', `完了申請が承認されました「${t.name}」`, { v: 'task', id: t.id }); }
  else { a.status = 'returned'; t.status = '進行中'; log({ pid: t.pid, tid: t.id, type: 'approval.returned', text: '完了申請を差し戻しました' }); notify([a.by], 'important', `完了申請が差し戻されました「${t.name}」`, { v: 'task', id: t.id }); }
  touch(t); render(); toast(el.dataset.k === 'ok' ? '承認しました' : '差し戻しました');
};

/* タスク：チェックリスト・コメント・添付 */
C.check = el => { const t = TK(el.dataset.id); const c = t.checklist[+el.dataset.i]; c.done = el.checked; touch(t); log({ pid: t.pid, tid: t.id, type: 'check', text: 'チェックリスト「' + c.t + '」を' + (c.done ? '完了' : '未完了') + 'にしました' }); render(); };
F.checkAdd = form => { const t = TK(form.dataset.id); const v = val('ck-new'); if (!v) return; t.checklist.push({ t: v, done: false }); touch(t); render(); };
F.comment = form => {
  const t = TK(form.dataset.id); const c = val('cm-text'); if (!c) return;
  const isDec = document.getElementById('cm-dec').checked;
  if (isDec) { S.decisions.push({ id: nid(S, 'd'), pid: t.pid, content: c, by: S.me, on: TODAY, tasks: [t.id], createdBy: S.me }); log({ pid: t.pid, tid: t.id, type: 'decision', text: '決定事項を登録しました', comment: c }); }
  else log({ pid: t.pid, tid: t.id, type: 'comment', text: 'コメントしました', comment: c });
  const n = notify([...people(t), isDec ? P(t.pid).pm : null], isDec ? 'important' : 'normal', `${uname(S.me)}さんが${isDec ? '決定事項を登録' : 'コメント'}しました「${t.name}」`, { v: 'task', id: t.id });
  render(); toast((isDec ? '決定事項を登録しました' : 'コメントしました') + '（' + n + '人に通知）');
};
C.attach = el => { const t = TK(el.dataset.id); const f = el.files[0]; if (!f) return; t.attachments.push({ name: f.name, by: S.me, at: Date.now() }); touch(t); log({ pid: t.pid, tid: t.id, type: 'file', text: 'ファイルを添付しました：' + f.name }); render(); toast('添付しました（試作ではファイル名のみ保存）'); };
A.watch = el => { const t = TK(el.dataset.id); t.watchers = t.watchers.includes(S.me) ? t.watchers.filter(x => x !== S.me) : [...t.watchers, S.me]; render(); };

/* タスク：担当・期限の変更（権限者） */
A.editTask = el => {
  const t = TK(el.dataset.id);
  openSheet('担当者・期限・承認者を変更', `<div class="form-grid">
    <label class="f"><span>主担当者</span><select class="inp" id="et-owner">${userOpts(t.owner)}</select></label>
    <label class="f"><span>承認者</span><select class="inp" id="et-ap">${userOpts(t.approver, null, 'なし')}</select></label>
    <label class="f"><span>開始予定日</span><input class="inp" type="date" id="et-start" value="${esc(t.start || '')}"></label>
    <label class="f"><span>締切日</span><input class="inp" type="date" id="et-due" value="${esc(t.due || '')}"></label>
    <label class="f"><span>優先度</span><select class="inp" id="et-pri">${['高', '中', '低'].map(x => `<option${x === t.priority ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
    <label class="f"><span>状態</span><select class="inp" id="et-st">${STATUSES.map(x => `<option${x === t.status ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
    <fieldset class="wide" style="border:1px solid var(--line);border-radius:8px"><legend class="small muted">協力者</legend><div class="row">${S.users.filter(u => u.active && u.role !== 'viewer' && u.id !== t.owner).map(u => `<label class="switch small"><input type="checkbox" id="co-${u.id}" class="co" value="${u.id}" ${t.collaborators.includes(u.id) ? 'checked' : ''}>${esc(u.name)}</label>`).join('')}</div></fieldset>
    <label class="f wide req"><span>変更理由（履歴に残ります）</span><input class="inp" id="et-reason"></label></div>
    <div class="hint">締切を変えると後続タスクに影響がある場合は、工程変更の確認画面に切り替わります。</div>`,
    `<button class="btn" data-a="closeSheet">キャンセル</button><button class="btn primary" data-a="editTaskSave" data-id="${t.id}">保存</button>`, true);
};
A.editTaskSave = el => {
  const t = TK(el.dataset.id); const reason = val('et-reason');
  if (!reason) { toast('変更理由を入力してください'); return; }
  const nd = val('et-due') || null;
  if (nd && t.due && nd !== t.due) {
    const items = computeImpact(S, t.id, nd);
    if (items.length > 1) { closeSheet(); ui.cn = { tid: t.id, kind: 'due', reasonType: 'その他', reason, newDate: nd, impact: '', comment: '', items, excluded: {} }; go('change-new', { tid: t.id, kind: 'due' }); toast('後続タスクに影響があります。内容を確認してください'); return; }
  }
  const diff = []; const set = (f, k, v, fmt) => { if ((t[k] || null) !== (v || null)) { diff.push({ f, o: fmt(t[k]), n: fmt(v) }); t[k] = v; } };
  const oldOwner = t.owner;
  set('主担当', 'owner', val('et-owner'), uname); set('承認者', 'approver', val('et-ap') || null, x => x ? uname(x) : 'なし');
  set('開始予定日', 'start', val('et-start') || null, x => fmtD(x)); set('締切日', 'due', nd, x => fmtD(x));
  set('優先度', 'priority', val('et-pri'), x => x); set('状態', 'status', val('et-st'), x => x);
  const co = [...document.querySelectorAll('.co:checked')].map(x => x.value);
  if (co.join() !== t.collaborators.join()) { diff.push({ f: '協力者', o: t.collaborators.map(sname).join('・') || 'なし', n: co.map(sname).join('・') || 'なし' }); t.collaborators = co; }
  if (t.due) t.dueStatus = t.dueStatus === 'pending' ? 'fixed' : t.dueStatus;
  closeSheet();
  if (!diff.length) return;
  touch(t);
  log({ pid: t.pid, tid: t.id, type: 'assign.change', text: '担当・期限などを変更しました', diff, comment: '理由：' + reason });
  notify([...people(t), oldOwner], 'important', `「${t.name}」の${diff.map(d => d.f).join('・')}が変更されました`, { v: 'task', id: t.id });
  render(); toast('変更しました（関係者へ通知）');
};
A.cancelTask = el => {
  const t = TK(el.dataset.id);
  openSheet('タスクを取消', `<div class="hint warn">「${esc(t.name)}」を取消にします。削除ではないため履歴は残ります。</div><label class="f req"><span>取消の理由</span><input class="inp" id="ct-r"></label>`, `<button class="btn" data-a="closeSheet">やめる</button><button class="btn danger" data-a="cancelTaskDo" data-id="${t.id}">取消にする</button>`);
};
A.cancelTaskDo = el => { const t = TK(el.dataset.id); const r = val('ct-r'); if (!r) { toast('理由を入力してください'); return; } t.status = '取消'; touch(t); log({ pid: t.pid, tid: t.id, type: 'task.cancel', text: 'タスクを取消にしました', comment: r }); notify(people(t), 'normal', `「${t.name}」が取消になりました`, { v: 'task', id: t.id }); closeSheet(); render(); };

/* 工程変更 */
A.cnKind = el => { ui.cn.kind = el.dataset.k; render(); };
C.cnField = el => { ui.cn[el.dataset.k] = el.value; };
C.cnDate = el => { ui.cn.newDate = el.value; ui.cn.items = null; render(); };
C.cnDays = el => { const t = TK(ui.cn.tid); ui.cn.newDate = addDays(t.due, +el.value || 0); ui.cn.items = null; render(); };
A.cnCalc = () => {
  const cn = ui.cn; const t = TK(cn.tid);
  if (!cn.reasonType) { toast('変更理由を選んでください'); return; }
  if (!cn.newDate || cn.newDate === t.due) { toast('変更後の予定日を入力してください'); return; }
  cn.excluded = {}; cn.items = computeImpact(S, t.id, cn.newDate); render();
};
C.impactEx = el => {
  if (ui.view === 'change-new') { const cn = ui.cn; cn.excluded[el.dataset.id] = !el.checked; cn.items = computeImpact(S, cn.tid, cn.newDate, new Set(Object.keys(cn.excluded).filter(k => cn.excluded[k]))); const ids = new Set(cn.items.map(i => i.tid)); for (const k of Object.keys(cn.excluded)) if (!ids.has(k) && cn.excluded[k]) { const t = TK(k); cn.items.push({ tid: k, oldStart: t.start, oldDue: t.due, newStart: t.start, newDue: t.due }); } }
  else { const c = S.changes.find(x => x.id === ui.params.id); const ex = new Set(c.items.filter(i => i.excluded).map(i => i.tid)); if (el.checked) ex.delete(el.dataset.id); else ex.add(el.dataset.id); const items = computeImpact(S, c.tid, c.newDate, ex); for (const k of ex) if (!items.some(i => i.tid === k)) { const t = TK(k); items.push({ tid: k, oldStart: t.start, oldDue: t.due, newStart: t.start, newDue: t.due }); } c.items = items.map(i => ({ ...i, excluded: ex.has(i.tid) })); }
  render();
};
A.cnSubmit = el => {
  const cn = ui.cn; const t = TK(cn.tid); const p = P(t.pid);
  const approver = cn.kind === 'due' ? (deptManager(t.dept) || p.pm) : p.pm;
  const c = { id: nid(S, 'c'), kind: cn.kind, pid: p.id, tid: t.id, reason: cn.reasonType + (cn.reason ? '：' + cn.reason : ''), oldDate: t.due, newDate: cn.newDate, impact: cn.impact, comment: cn.comment, items: cn.items.map(i => ({ ...i, excluded: !!cn.excluded[i.tid] })), status: 'pending', by: S.me, approver, at: Date.now(), prevStatus: t.status };
  S.changes.push(c);
  log({ pid: p.id, tid: t.id, type: cn.kind === 'due' ? 'due.request' : 'report.slip', text: (cn.kind === 'due' ? '期限変更を申請しました' : '工程がずれました（承認待ち）') + `：${fmtD(t.due)} → ${fmtD(cn.newDate)}`, comment: c.reason + (cn.comment ? '\n' + cn.comment : '') });
  ui.cn = null;
  if (el.dataset.self) { applyChange(c, ''); go('change', { id: c.id }); toast('変更を反映しました（関係者へ通知）'); return; }
  t.status = '承認待ち'; touch(t);
  notify([approver], 'important', `${uname(S.me)}さんから${cn.kind === 'due' ? '期限変更' : '工程変更'}の承認依頼が届きました（${p.name}）`, { v: 'change', id: c.id });
  go('change', { id: c.id }); toast('承認を申請しました');
};
function applyChange(c, comment) {
  const p = P(c.pid);
  const touched = [];
  for (const i of c.items) {
    if (i.excluded) continue;
    const t = TK(i.tid); if (!t) continue;
    const diff = [{ f: '締切日', o: fmtD(t.due), n: fmtD(i.newDue) }];
    if (i.newStart && t.start !== i.newStart) diff.unshift({ f: '開始予定日', o: fmtD(t.start), n: fmtD(i.newStart) });
    t.due = i.newDue; if (i.newStart) t.start = i.newStart; touch(t);
    if (t.id === c.tid && t.status === '承認待ち') t.status = c.prevStatus && c.prevStatus !== '承認待ち' ? c.prevStatus : '進行中';
    log({ pid: c.pid, tid: t.id, type: 'change.applied', text: (c.kind === 'due' ? '期限変更' : '工程変更') + 'を反映しました', diff, comment: t.id === c.tid ? '理由：' + c.reason : '「' + TK(c.tid).name + '」の変更による連動' });
    touched.push(t);
  }
  c.status = 'applied'; c.decidedBy = S.me; c.decisionComment = comment;
  const who = new Set([c.by]); touched.forEach(t => people(t).forEach(u => who.add(u)));
  touched.forEach(t => { const m = deptManager(t.dept); if (m && t.dept !== TK(c.tid).dept) who.add(m); });
  notify([...who], 'important', `${p.name}：${c.kind === 'due' ? '期限変更' : '工程変更'}が承認され、${touched.length}件のタスクの日付が変わりました`, { v: 'change', id: c.id });
}
A.chDecide = el => {
  const c = S.changes.find(x => x.id === el.dataset.id); const k = el.dataset.k; const cm = val('ch-comment');
  if (k !== 'applied' && !cm) { toast('コメントを入力してください'); return; }
  const t = TK(c.tid);
  if (k === 'applied') { applyChange(c, cm); toast('承認し、日付を一括変更しました'); }
  else {
    c.status = k; c.decidedBy = S.me; c.decisionComment = cm;
    if (t.status === '承認待ち') t.status = c.prevStatus && c.prevStatus !== '承認待ち' ? c.prevStatus : '進行中';
    log({ pid: c.pid, tid: c.tid, type: 'change.' + k, text: (c.kind === 'due' ? '期限変更' : '工程変更') + 'を' + (k === 'rejected' ? '却下' : '差し戻し') + 'しました', comment: cm });
    notify([c.by], 'important', `${c.kind === 'due' ? '期限変更' : '工程変更'}が${k === 'rejected' ? '却下' : '差し戻'}されました「${t.name}」`, { v: 'change', id: c.id });
    toast(k === 'rejected' ? '却下しました' : '差し戻しました');
  }
  render();
};

/* 依頼 */
A.newRequest = el => { ui.rqDraft = null; go('request-new', { pid: el.dataset.pid, tid: el.dataset.tid }); };
C.rqDept = el => { const s = document.getElementById('rq-user'); s.innerHTML = userOpts('', u => u.dept === el.value, '指定しない（所属長が受付）'); };
F.request = () => {
  const toDept = val('rq-dept'), toUser = val('rq-user') || null;
  const receiver = toUser || deptManager(toDept);
  if (!receiver) { toast('依頼先の部署に所属長がいません。担当者を指定してください'); return; }
  const r = { id: nid(S, 'r'), pid: val('rq-pid'), from: S.me, toDept, toUser, receiver, title: val('rq-title'), content: val('rq-content'), reason: val('rq-reason'), desired: val('rq-desired'), urgency: val('rq-urg'), status: 'sent', history: [{ uid: S.me, act: '依頼を送信', at: Date.now() }], createdAt: Date.now() };
  if (ui.rqDraft && ui.rqDraft.id) { const old = S.requests.find(x => x.id === ui.rqDraft.id); Object.assign(old, { ...r, id: old.id, history: [...old.history, { uid: S.me, act: '内容を修正して再送', at: Date.now() }], createdAt: old.createdAt }); ui.rqDraft = null; log({ pid: old.pid, type: 'request.resent', text: '依頼を修正して再送「' + old.title + '」' }); notify([old.receiver], 'important', `${uname(S.me)}さんから依頼「${old.title}」が再送されました`, { v: 'request', id: old.id }); ui.stack.pop(); go('request', { id: old.id }, true); toast('再送しました'); return; }
  S.requests.push(r);
  if (document.getElementById('rq-file').files[0]) r.history[0].comment = '添付：' + document.getElementById('rq-file').files[0].name;
  log({ pid: r.pid, type: 'request.sent', text: deptName(toDept) + (toUser ? '・' + uname(toUser) : '') + 'へ依頼を送信「' + r.title + '」' });
  notify([receiver], r.urgency === '至急' ? 'urgent' : 'important', `${uname(S.me)}さんから依頼「${r.title}」が届きました`, { v: 'request', id: r.id });
  ui.rtab = 'sent'; ui.stack.pop(); go('requests', {}, true); toast('依頼を送信しました（' + uname(receiver) + 'さんが受付）');
};
A.ract = el => { ui.ract = el.dataset.k || null; render(); const f = document.querySelector('[data-f=rdecide]'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
F.rdecide = form => {
  const r = S.requests.find(x => x.id === form.dataset.id); const k = form.dataset.k; const cm = val('rd-comment');
  const label = { ok: '承認', due: '期限を変更して承認', owner: '担当者を変更して承認', return: '差し戻し（情報不足）', reject: '却下', esc: '責任者へ判断を依頼' }[k];
  if (['ok', 'due', 'owner'].includes(k)) {
    const owner = val('rd-owner'), due = val('rd-due');
    const t = { id: nid(S, 't'), pid: r.pid, code: null, name: r.title, dept: U(owner).dept, owner, collaborators: [], watchers: [r.from], approver: null, start: addDays(due, -2) < TODAY ? TODAY : addDays(due, -2), due, dueStatus: 'manual', completedAt: null, priority: r.urgency === '通常' ? '中' : '高', status: '未着手', desc: r.content + (r.reason ? '\n\n依頼理由：' + r.reason : ''), checklist: [], preds: [], origin: 'request', visibility: '全社', createdBy: S.me, createdAt: Date.now(), attachments: [], sourceRequest: r.id };
    S.tasks.push(t);
    r.status = 'approved'; r.taskId = t.id; r.decidedDue = due; r.decidedOwner = owner;
    r.history.push({ uid: S.me, act: label + (due !== r.desired ? `（期限 ${fmtD(r.desired)} → ${fmtD(due)}）` : '') + (owner !== (r.toUser || r.receiver) ? `（担当：${uname(owner)}）` : ''), comment: cm, at: Date.now() });
    log({ pid: r.pid, tid: t.id, type: 'request.approved', text: '依頼を' + label + 'し、正式タスクにしました', comment: cm });
    notify([r.from], 'normal', `依頼「${r.title}」が${label}されました${due !== r.desired ? `（期限：${fmtD(r.desired)} → ${fmtD(due)}）` : ''}`, { v: 'request', id: r.id });
    notify([owner], 'normal', `タスク「${t.name}」が割り当てられました`, { v: 'task', id: t.id });
  } else {
    if (['return', 'reject'].includes(k) && !cm) { toast('理由を入力してください'); return; }
    if (k === 'esc') { const to = val('rd-esc'); r.status = 'escalated'; r.receiver = to; notify([to], 'important', `${uname(S.me)}さんから依頼「${r.title}」の判断を求められています`, { v: 'request', id: r.id }); }
    else r.status = k === 'return' ? 'returned' : 'rejected';
    r.history.push({ uid: S.me, act: label, comment: cm, at: Date.now() });
    log({ pid: r.pid, type: 'request.' + k, text: '依頼を' + label + '「' + r.title + '」', comment: cm });
    notify([r.from], 'important', `依頼「${r.title}」が${label}されました`, { v: 'request', id: r.id });
  }
  ui.ract = null; render(); toast(label + 'しました（依頼者へ通知）');
};
A.resend = el => { const r = S.requests.find(x => x.id === el.dataset.id); ui.rqDraft = { ...r }; go('request-new', { pid: r.pid }); };
A.withdraw = el => { const r = S.requests.find(x => x.id === el.dataset.id); r.status = 'withdrawn'; r.history.push({ uid: S.me, act: '依頼を取り下げ', at: Date.now() }); log({ pid: r.pid, type: 'request.withdrawn', text: '依頼を取り下げ「' + r.title + '」' }); render(); };
C.allAp = el => { ui.allAp = el.checked; render(); };

/* 決定事項（案件から） */
A.decisionNew = el => {
  const p = P(el.dataset.pid);
  openSheet('決定事項を登録', `<label class="f req"><span>決定内容</span><textarea class="inp" id="dn-c" placeholder="例：外壁はサイディング（色：ウォームグレー）で確定"></textarea></label>
    <div class="form-grid"><label class="f"><span>決定者</span><select class="inp" id="dn-by">${userOpts(p.pm)}</select></label><label class="f"><span>決定日</span><input class="inp" type="date" id="dn-on" value="${TODAY}"></label></div>
    <fieldset style="border:1px solid var(--line);border-radius:8px"><legend class="small muted">影響するタスク</legend><div class="stack" style="gap:2px;max-height:200px;overflow:auto">${S.tasks.filter(t => t.pid === p.id && isOpen(t)).map(t => `<label class="switch small"><input type="checkbox" class="dn-t" id="dn-${t.id}" value="${t.id}">${esc(t.name)}</label>`).join('')}</div></fieldset>`,
    `<button class="btn" data-a="closeSheet">キャンセル</button><button class="btn primary" data-a="decisionSave" data-pid="${p.id}">登録</button>`);
};
A.decisionSave = el => {
  const c = val('dn-c'); if (!c) { toast('決定内容を入力してください'); return; }
  const ts = [...document.querySelectorAll('.dn-t:checked')].map(x => x.value);
  S.decisions.push({ id: nid(S, 'd'), pid: el.dataset.pid, content: c, by: val('dn-by'), on: val('dn-on'), tasks: ts, createdBy: S.me });
  log({ pid: el.dataset.pid, type: 'decision', text: '決定事項を登録しました', comment: c });
  notify(ts.flatMap(id => people(TK(id))), 'important', `決定事項が登録されました：${c.slice(0, 30)}`, { v: 'project', id: el.dataset.pid });
  closeSheet(); ui.ptab = 'dec'; render(); toast('決定事項を登録しました');
};

/* カレンダー・工程表 */
A.calMove = el => { const n = +el.dataset.n; if (n === 0) { ui.calM = TODAY.slice(0, 8) + '01'; ui.calSel = TODAY; } else { const d = parse(ui.calM); d.setMonth(d.getMonth() + n); ui.calM = iso(d); } render(); };
A.calScope = el => { ui.calScope = el.dataset.k; render(); };
A.calDay = el => { ui.calSel = el.dataset.d; render(); };
C.gp = el => { ui.gp = el.value; render(); };

/* 設定 */
C.alertDay = el => { const d = +el.dataset.d; S.settings.alertDays = el.checked ? [...new Set([...S.settings.alertDays, d])] : S.settings.alertDays.filter(x => x !== d); save(); toast('保存しました'); };
C.alertOver = el => { S.settings.overdue = el.checked; save(); toast('保存しました'); };
C.mail = el => { S.settings.mail = el.value; save(); toast('保存しました'); };
C.push = el => { S.settings.push = el.checked; save(); toast(el.checked ? 'プッシュ通知は準備中です。設定だけ保存しました' : '保存しました'); };
A.pushTest = () => { const t = S.tasks.find(t => t.owner === S.me && isOpen(t) && t.due) || S.tasks[0]; pushBanner('締切前日：' + t.name, P(t.pid).name + '・締切 ' + fmtD(t.due)); };
A.resetAsk = () => openSheet('試作データを初期状態に戻す', '<div class="hint warn">このブラウザで操作した内容（登録した案件・報告・承認など）がすべて消え、最初の状態に戻ります。</div>', '<button class="btn" data-a="closeSheet">やめる</button><button class="btn danger" data-a="resetDo">初期状態に戻す</button>');
A.resetDo = () => { const m = S.me; S = buildSeed(); S.me = m; S.seedDay = TODAY; closeSheet(); ui.stack = []; go('home', {}, true); toast('初期状態に戻しました'); };

/* 管理 */
A.optToggle = el => { const o = S.options.find(x => x.id === el.dataset.id); o.active = !o.active; render(); toast((o.active ? '有効' : '無効') + 'にしました：' + optLabel(o.id)); };
A.grpToggle = el => { const g = S.groups.find(x => x.id === el.dataset.id); g.active = !g.active; render(); };
F.optAdd = form => { const g = form.dataset.g; const v = val('oa-' + g); if (!v) return; S.options.push({ id: nid(S, 'o'), group: g, label: v, active: true }); render(); toast('選択肢を追加しました'); };
F.grpAdd = () => { const n = val('ga-name'); if (!n) return; const id = nid(S, 'g'); S.groups.push({ id, name: n, parent: null, active: true, order: S.groups.length }); (val('ga-opts') || 'あり,なし').split(/[,、]/).map(s => s.trim()).filter(Boolean).forEach(l => S.options.push({ id: nid(S, 'o'), group: id, label: l, active: true })); render(); toast('条件グループを追加しました'); };
A.testOpt = el => { const sel = new Set(ui.testSel || ['k_house', 'w_new', 'permit_yes']); const o = S.options.find(x => x.id === el.dataset.o); const had = sel.has(o.id); for (const x of S.options.filter(x => x.group === o.group)) sel.delete(x.id); if (!had) sel.add(o.id); ui.testSel = [...sel]; render(); };
A.tplEdit = el => { const t = S.templates.find(x => x.code === el.dataset.code); ui.tplEdit = JSON.parse(JSON.stringify(t)); tplSheet(); };
A.tplNew = () => { ui.tplEdit = { code: 'T' + (S.templates.length + 31), name: '', dept: 'sales', base: 'contract', offset: -7, dayType: 'cal', duration: 3, rules: [], preds: [], needApproval: false, checklist: [], active: true, version: 1, isNew: true }; tplSheet(); };
C.teField = el => { const t = ui.tplEdit; const k = el.dataset.k; t[k] = el.type === 'checkbox' ? el.checked : ['offset', 'duration'].includes(k) ? +el.value : k === 'checklist' ? el.value.split('\n').map(s => s.trim()).filter(Boolean) : el.value; if (['base', 'offset', 'dayType'].includes(k)) keepSheet(); };
function keepSheet() { const sc = $sheet.querySelector('.sheet'); const y = sc ? sc.scrollTop : 0; tplSheet(); const s2 = $sheet.querySelector('.sheet'); if (s2) s2.scrollTop = y; }
A.tePred = el => { const t = ui.tplEdit; const c = el.dataset.code; t.preds = t.preds.includes(c) ? t.preds.filter(x => x !== c) : [...t.preds, c]; keepSheet(); };
C.ruleAdd = el => { if (!el.value) return; const r = ui.tplEdit.rules[+el.dataset.r]; if (!r.includes(el.value)) r.push(el.value); keepSheet(); };
A.ruleDel = el => { ui.tplEdit.rules[+el.dataset.r].splice(+el.dataset.o, 1); keepSheet(); };
A.ruleRm = el => { ui.tplEdit.rules.splice(+el.dataset.r, 1); keepSheet(); };
A.ruleNew = () => { ui.tplEdit.rules.push([]); keepSheet(); };
A.tplSave = () => {
  const t = ui.tplEdit; if (!t.name) { toast('タスク名を入力してください'); return; }
  t.rules = t.rules.filter(r => r.length);
  if (t.isNew) { delete t.isNew; S.templates.push(t); } else { t.version++; const i = S.templates.findIndex(x => x.code === t.code); S.templates[i] = t; }
  log({ type: 'master.template', text: 'タスクテンプレート「' + t.name + '」を保存しました（版 ' + t.version + '）' });
  closeSheet(); render(); toast('保存しました。新しく登録する案件から反映されます');
};
A.permCycle = el => { const order = ['all', 'rel', 'apply', 'none']; const r = el.dataset.r, k = el.dataset.k; const v = S.perms[r][k]; S.perms[r][k] = order[(order.indexOf(v) + 1) % 4]; log({ type: 'master.perm', text: `権限を変更：${ROLES[r]}「${PERM_DEFS.find(x => x[0] === k)[1]}」${PERM_LABEL[v]} → ${PERM_LABEL[S.perms[r][k]]}` }); render(); };
C.userDept = el => { U(el.dataset.id).dept = el.value; render(); toast('部署を変更しました'); };
C.userRole = el => { U(el.dataset.id).role = el.value; render(); toast('役割を変更しました'); };
C.userActive = el => { U(el.dataset.id).active = el.checked; render(); };
F.userAdd = () => { const n = val('ua-name'); if (!n) return; S.users.push({ id: nid(S, 'u'), name: n, dept: val('ua-dept'), role: val('ua-role'), active: true }); render(); toast('ユーザーを追加しました'); };
F.deptAdd = () => { const n = val('da-name'); if (!n) return; S.depts.push({ id: nid(S, 'dp'), name: n }); render(); toast('部署を追加しました'); };

/* ---------- イベント配線 ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]'); if (!el || el.disabled) return;
  const fn = A[el.dataset.a]; if (!fn) return;
  if (el.dataset.a === 'scrim') { fn(el, e); return; }
  e.preventDefault(); fn(el, e);
});
document.addEventListener('change', e => { const el = e.target.closest('[data-c]'); if (el && C[el.dataset.c]) C[el.dataset.c](el, e); });
document.addEventListener('input', e => { const el = e.target.closest('[data-i]'); if (el && I[el.dataset.i]) I[el.dataset.i](el, e); });
document.addEventListener('submit', e => { const f = e.target.closest('[data-f]'); if (!f) return; e.preventDefault(); if (F[f.dataset.f]) F[f.dataset.f](f, e); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $sheet.innerHTML) closeSheet(); });
let rT; window.addEventListener('resize', () => { if (!['gantt', 'project'].includes(ui.view)) return; clearTimeout(rT); rT = setTimeout(render, 200); });

render();
