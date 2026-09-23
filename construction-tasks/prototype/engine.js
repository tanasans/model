/* 建設案件タスク管理 試作：マスタ・自動生成エンジン・初期データ
 * 本実装では PHP + MySQL 側に移す処理を、試作用にブラウザ内で再現している。 */
'use strict';

/* ---------- 日付 ---------- */
const DAY = 86400000;
function d0(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
const TODAY_D = d0(new Date());
function iso(d) { if (!d) return null; const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
function parse(s) { if (!s) return null; const [y, m, dd] = s.split('-').map(Number); return new Date(y, m - 1, dd); }
function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
const TODAY = iso(TODAY_D);
const T = n => addDays(TODAY, n);
function diffDays(a, b) { return Math.round((parse(a) - parse(b)) / DAY); }
const DOW = '日月火水木金土';
function fmtD(s, withY) {
  if (!s) return '日付未確定';
  const d = parse(s);
  return (withY ? d.getFullYear() + '/' : '') + (d.getMonth() + 1) + '/' + d.getDate() + '(' + DOW[d.getDay()] + ')';
}
function fmtDT(ts) { const d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

/* 祝日＋会社休日（管理画面「休日カレンダー」で編集する想定） */
const HOLIDAYS = new Set([
  '2026-01-01','2026-01-12','2026-02-11','2026-02-23','2026-03-20','2026-04-29','2026-05-04','2026-05-05','2026-05-06',
  '2026-07-20','2026-08-11','2026-09-21','2026-09-22','2026-09-23','2026-10-12','2026-11-03','2026-11-23',
  '2027-01-01','2027-01-11','2027-02-11','2027-02-23','2027-03-22','2027-04-29','2027-05-03','2027-05-04','2027-05-05',
  '2027-07-19','2027-08-11','2027-09-20','2027-09-23','2027-10-11','2027-11-03','2027-11-23',
  // 会社休日
  '2026-08-13','2026-08-14','2026-12-29','2026-12-30','2026-12-31','2027-01-02','2027-01-03','2027-08-13','2027-08-16','2027-12-29','2027-12-30','2027-12-31'
]);
function isBiz(d) { const w = d.getDay(); return w !== 0 && w !== 6 && !HOLIDAYS.has(iso(d)); }
function addBiz(s, n) {
  const d = parse(s);
  if (n === 0) { while (!isBiz(d)) d.setDate(d.getDate() - 1); return iso(d); }
  const step = n < 0 ? -1 : 1; let k = Math.abs(n);
  while (k > 0) { d.setDate(d.getDate() + step); if (isBiz(d)) k--; }
  return iso(d);
}

/* ---------- 組織 ---------- */
const DEPTS = [
  { id: 'sales', name: '営業' }, { id: 'design', name: '設計' }, { id: 'const', name: '工務' },
  { id: 'est', name: '積算' }, { id: 'admin', name: '総務・経理' }, { id: 'mgmt', name: '経営' }
];
const ROLES = { member: '一般社員', manager: '所属長', exec: '経営者・役員', admin: 'システム管理者', viewer: '閲覧者' };
const SEED_USERS = [
  { id: 'u1', name: '佐藤 健太', dept: 'sales', role: 'member' },
  { id: 'u2', name: '高橋 美咲', dept: 'sales', role: 'manager' },
  { id: 'u3', name: '田中 翔', dept: 'design', role: 'member' },
  { id: 'u4', name: '伊藤 由紀', dept: 'design', role: 'manager' },
  { id: 'u5', name: '渡辺 大輔', dept: 'const', role: 'member' },
  { id: 'u9', name: '加藤 陽介', dept: 'const', role: 'member' },
  { id: 'u6', name: '山本 誠', dept: 'const', role: 'manager' },
  { id: 'u7', name: '中村 修', dept: 'mgmt', role: 'exec' },
  { id: 'u8', name: '小林 あや', dept: 'admin', role: 'admin' },
  { id: 'u10', name: '森 さくら', dept: 'admin', role: 'viewer' }
];

/* ---------- 権限（管理画面で変更可能） ----------
 * all=全案件で可 / rel=関係がある範囲で可 / apply=申請のみ / none=不可 */
const PERM_DEFS = [
  ['view_all', '案件・タスク閲覧'],
  ['view_confidential', '機密情報の閲覧（原価・利益率など）'],
  ['project_create', '案件登録'],
  ['task_update_own', 'タスクの状況更新・報告'],
  ['task_add_self', '手動タスク追加（担当＝自分）'],
  ['task_add_others', '手動タスク追加（担当＝他者）'],
  ['request_send', '他者・他部署への依頼'],
  ['due_change', '期限変更'],
  ['assign_change', '担当者・承認者の変更'],
  ['approve', '承認'],
  ['master_edit', '案件条件・テンプレートの編集'],
  ['user_admin', 'ユーザー・権限設定']
];
const PERM_LABEL = { all: '◎', rel: '○', apply: '△', none: '×' };
const PERM_TEXT = { all: '全案件で可', rel: '関係がある範囲で可', apply: '申請のみ', none: '不可' };
const PERM_DEFAULT = {
  member:  { view_all: 'all', view_confidential: 'none', project_create: 'rel', task_update_own: 'rel', task_add_self: 'rel', task_add_others: 'apply', request_send: 'all', due_change: 'apply', assign_change: 'none', approve: 'rel', master_edit: 'none', user_admin: 'none' },
  manager: { view_all: 'all', view_confidential: 'rel', project_create: 'all', task_update_own: 'rel', task_add_self: 'all', task_add_others: 'rel', request_send: 'all', due_change: 'rel', assign_change: 'rel', approve: 'rel', master_edit: 'rel', user_admin: 'none' },
  exec:    { view_all: 'all', view_confidential: 'all', project_create: 'all', task_update_own: 'rel', task_add_self: 'all', task_add_others: 'all', request_send: 'all', due_change: 'all', assign_change: 'all', approve: 'all', master_edit: 'all', user_admin: 'none' },
  admin:   { view_all: 'all', view_confidential: 'all', project_create: 'all', task_update_own: 'all', task_add_self: 'all', task_add_others: 'all', request_send: 'all', due_change: 'all', assign_change: 'all', approve: 'all', master_edit: 'all', user_admin: 'all' },
  viewer:  { view_all: 'all', view_confidential: 'none', project_create: 'none', task_update_own: 'none', task_add_self: 'none', task_add_others: 'none', request_send: 'none', due_change: 'none', assign_change: 'none', approve: 'none', master_edit: 'none', user_admin: 'none' }
};

/* ---------- 案件条件マスタ（要件 3.2） ---------- */
const SEED_GROUPS = [
  { id: 'land', name: '土地', opts: [['land_yes', '土地あり'], ['land_no', '土地なし']] },
  { id: 'acq', name: '土地の取得方法', parent: 'land_no', opts: [['acq_buy', '土地購入'], ['acq_lease', '借地'], ['acq_broker', '仲介']] },
  { id: 'kind', name: '案件種別', opts: [['k_house', '住宅'], ['k_facility', '施設'], ['k_public', '公共工事'], ['k_small', '小口工事']] },
  { id: 'work', name: '工事区分', opts: [['w_new', '新築'], ['w_reno', '改修'], ['w_repair', '修繕']] },
  { id: 'soil', name: '地盤調査', opts: [['soil_yes', 'あり'], ['soil_no', 'なし']] },
  { id: 'improve', name: '地盤改良', parent: 'soil_yes', opts: [['imp_yes', 'あり'], ['imp_no', 'なし'], ['imp_tbd', '未定']] },
  { id: 'fund', name: '資金', opts: [['f_loan', '住宅ローン'], ['f_cash', '現金'], ['f_other', 'その他']] },
  { id: 'permit', name: '確認申請', opts: [['permit_yes', 'あり'], ['permit_no', 'なし']] },
  { id: 'subsidy', name: '補助金', opts: [['sub_yes', 'あり'], ['sub_no', 'なし']] },
  { id: 'choki', name: '長期優良住宅', opts: [['choki_yes', '対象'], ['choki_no', '対象外']] },
  { id: 'zosei', name: '造成工事', opts: [['zo_yes', 'あり'], ['zo_no', 'なし']] },
  { id: 'kaitai', name: '解体工事', opts: [['kai_yes', 'あり'], ['kai_no', 'なし']] },
  { id: 'brand', name: 'セルコホーム', opts: [['br_selco', 'セルコホーム案件'], ['br_other', 'その他']] },
  { id: 'clt', name: 'CLT', opts: [['clt_yes', 'CLT案件'], ['clt_no', 'その他']] }
];

/* ---------- タスクテンプレート ----------
 * rules: 外側はOR、内側はAND。'!'始まりは「〜以外」。空配列＝全案件で生成
 * base: reg=案件登録日 contract=契約日 start=着工日 completion=完成日 handover=引渡日 pred=前工程の締切日 */
const BASE_LABEL = { reg: '案件登録日', contract: '契約日', start: '着工日', completion: '完成日', handover: '引渡日', pred: '前工程' };
const SEED_TEMPLATES = [
  // code, name, dept, base, offset, dayType, duration, rules, preds, needApproval, checklist
  ['T01', '初回ヒアリング記録', 'sales', 'reg', 3, 'biz', 2, [], [], false, ['要望・予算', '家族構成・人数', '希望時期']],
  ['T02', '土地情報の取得・調査', 'sales', 'reg', 10, 'biz', 7, [['land_yes']], ['T01'], false, ['登記簿', '公図・測量図', '法規制の確認']],
  ['T03', '土地探し・候補提示', 'sales', 'reg', 20, 'biz', 15, [['land_no']], ['T01'], false, ['希望条件の整理', '候補地3件以上']],
  ['T04', '土地売買契約', 'sales', 'contract', -10, 'biz', 5, [['acq_buy']], ['T03'], true, ['重要事項説明', '手付金']],
  ['T05', '借地契約の確認', 'sales', 'contract', -10, 'biz', 5, [['acq_lease']], ['T03'], true, []],
  ['T06', '仲介業者との条件調整', 'sales', 'contract', -10, 'biz', 5, [['acq_broker']], ['T03'], false, []],
  ['T07', '住宅ローン事前審査', 'sales', 'contract', -15, 'biz', 5, [['f_loan']], ['T01'], false, ['必要書類の案内', '金融機関へ提出']],
  ['T08', '補助金の要件確認', 'sales', 'contract', -10, 'biz', 3, [['sub_yes']], ['T01'], false, ['対象制度の特定', '申請期限の確認']],
  ['T30', '入札・公告内容の確認', 'sales', 'reg', 7, 'biz', 5, [['k_public']], [], false, ['仕様書', '参加資格']],
  ['T09', '見積もり確定', 'sales', 'contract', -7, 'cal', 5, [], ['T01'], true, ['積算チェック', '値引き承認']],
  ['T10', '工事請負契約', 'sales', 'contract', 0, 'cal', 1, [['!k_small']], ['T09', 'T04', 'T05'], true, ['契約書', '印紙', '重要事項説明']],
  ['T11', '住宅ローン本申込', 'sales', 'contract', 10, 'biz', 5, [['f_loan']], ['T10'], false, []],
  ['T12', '地盤調査の手配', 'design', 'contract', 5, 'biz', 3, [['soil_yes']], ['T10'], false, ['調査会社へ発注', '立会い日程']],
  ['T13', '地盤改良方法の決定', 'design', 'pred', 5, 'biz', 3, [['soil_yes', 'imp_yes'], ['soil_yes', 'imp_tbd']], ['T12'], true, ['調査結果の確認', '工法・費用の比較']],
  ['T17', 'CLT 構造検討', 'design', 'start', -60, 'cal', 15, [['clt_yes']], ['T10'], false, []],
  ['T14', '実施設計', 'design', 'start', -45, 'cal', 20, [['w_new'], ['w_reno']], ['T10', 'T13', 'T17'], false, ['平面・立面', '構造', '設備']],
  ['T18', 'セルコホーム 仕様確定', 'design', 'start', -40, 'cal', 10, [['br_selco']], ['T14'], false, []],
  ['T15', '長期優良住宅 認定申請', 'design', 'start', -35, 'cal', 5, [['choki_yes']], ['T14'], false, []],
  ['T16', '確認申請', 'design', 'start', -30, 'cal', 5, [['permit_yes']], ['T14'], true, ['申請書類一式', '手数料']],
  ['T19', '解体工事の手配', 'const', 'start', -21, 'cal', 5, [['kai_yes']], ['T10'], false, []],
  ['T20', '造成工事の手配', 'const', 'start', -21, 'cal', 5, [['zo_yes']], ['T10'], false, []],
  ['T21', '着工前打ち合わせ', 'const', 'start', -10, 'cal', 1, [['!k_small']], ['T16', 'T14'], false, ['工程表', '近隣状況', '安全計画']],
  ['T22', '打ち合わせ議事録作成', 'const', 'pred', 3, 'biz', 2, [['!k_small']], ['T21'], false, []],
  ['T23', '近隣挨拶', 'const', 'start', -7, 'cal', 2, [['k_house'], ['k_facility']], ['T21'], false, []],
  ['T24', '中間検査', 'const', 'start', 45, 'cal', 1, [['permit_yes', 'w_new']], ['T21'], false, []],
  ['T25', '社内竣工検査', 'const', 'completion', -5, 'cal', 2, [['!k_small']], ['T24', 'T21'], false, ['是正箇所の記録']],
  ['T26', '完了検査', 'const', 'completion', 0, 'cal', 1, [['permit_yes']], ['T25'], true, []],
  ['T27', '引渡書類準備', 'const', 'handover', -7, 'cal', 5, [['!k_small']], ['T26', 'T25'], false, ['保証書', '取扱説明書', '鍵']],
  ['T28', '補助金 実績報告', 'sales', 'handover', 14, 'biz', 5, [['sub_yes']], ['T27'], false, []],
  ['T29', '小口工事 手配・完了報告', 'const', 'reg', 14, 'biz', 10, [['k_small']], [], false, ['現地確認', '業者手配', '完了写真']]
];

/* 定型ボタン（要件 6.2） */
const QUICK = [
  { code: 'start', label: '着手しました', next: '進行中', cls: 'go' },
  { code: 'meeting', label: '打ち合わせ完了', comment: true },
  { code: 'sent', label: '資料を送付しました', comment: true, file: true },
  { code: 'confirm', label: '確認をお願いします', next: '確認待ち', comment: true },
  { code: 'waiting', label: '回答待ちです', next: '回答待ち', comment: true },
  { code: 'slip', label: '工程がずれました', special: 'schedule', cls: 'alert' },
  { code: 'due', label: '期限変更を申請', special: 'due' },
  { code: 'issue', label: '問題が発生しました', comment: true, required: true, cls: 'alert' },
  { code: 'reqdone', label: '完了を申請', special: 'reqdone' },
  { code: 'done', label: '完了しました', next: '完了', cls: 'go' }
];
const STATUSES = ['下書き', '未着手', '進行中', '確認待ち', '回答待ち', '承認待ち', '保留', '完了', '取消'];

/* ---------- 自動生成エンジン ---------- */
function baseDateOf(p, base) {
  switch (base) {
    case 'reg': return p.createdOn;
    case 'contract': return p.contractDate || p.contractPlanned;
    case 'start': return p.startPlanned;
    case 'completion': return p.completionPlanned;
    case 'handover': return p.handoverPlanned;
  }
  return null;
}
function matchRule(rule, sel) { return rule.every(o => o[0] === '!' ? !sel.has(o.slice(1)) : sel.has(o)); }
function matchTpl(t, sel) { return t.active && (t.rules.length === 0 || t.rules.some(r => matchRule(r, sel))); }
function matchedBy(t, sel) { return t.rules.length === 0 ? null : t.rules.find(r => matchRule(r, sel)); }

/* 生成予定の一覧を作る（DBにはまだ書かない） */
function planTasks(S, p) {
  const sel = new Set(p.conditions);
  const hit = new Map();
  for (const t of S.templates) if (matchTpl(t, sel) && !hit.has(t.code)) hit.set(t.code, t); // コード単位で重複排除
  const memo = {};
  const dueOf = t => {
    if (t.code in memo) return memo[t.code];
    memo[t.code] = null;
    let base = null;
    if (t.base === 'pred') { const pt = hit.get(t.preds[0]); base = pt ? dueOf(pt) : null; }
    else base = baseDateOf(p, t.base);
    const d = base ? (t.dayType === 'biz' ? addBiz(base, t.offset) : addDays(base, t.offset)) : null;
    memo[t.code] = d; return d;
  };
  const out = [];
  for (const t of hit.values()) {
    const due = dueOf(t);
    out.push({ code: t.code, tpl: t, name: t.name, dept: t.dept, owner: defaultOwner(S, p, t.dept), due, start: due ? addDays(due, -t.duration) : null, include: true, rule: matchedBy(t, sel) });
  }
  return out;
}
function defaultOwner(S, p, dept) {
  if (dept === 'sales' && p.sales) return p.sales;
  if (dept === 'design' && p.design) return p.design;
  if (dept === 'const' && p.construction) return p.construction;
  const m = S.users.find(u => u.dept === dept && u.role === 'manager');
  return m ? m.id : p.pm;
}
function basisText(t) {
  if (!t) return '手動';
  const unit = t.dayType === 'biz' ? '営業日' : '日';
  if (t.base === 'pred') return '前工程の締切から' + t.offset + unit + '後';
  if (t.offset === 0) return BASE_LABEL[t.base] + '当日';
  return BASE_LABEL[t.base] + 'の' + Math.abs(t.offset) + unit + (t.offset < 0 ? '前' : '後');
}

/* 予定一覧を正式に登録（除外されたタスクの前後関係はつなぎ直す） */
function createTasksFromPlan(S, p, plan, byUser) {
  const inc = new Map(plan.filter(x => x.include).map(x => [x.code, x]));
  const all = new Map(plan.map(x => [x.code, x]));
  const idOf = {};
  for (const x of inc.values()) idOf[x.code] = nid(S, 't');
  const resolve = (codes, seen = new Set()) => {
    const out = [];
    for (const c of codes) {
      if (seen.has(c)) continue; seen.add(c);
      if (inc.has(c)) out.push(idOf[c]);
      else if (all.has(c)) out.push(...resolve(all.get(c).tpl.preds, seen));
    }
    return [...new Set(out)];
  };
  const created = [];
  for (const x of inc.values()) {
    const t = x.tpl;
    const task = {
      id: idOf[x.code], pid: p.id, code: x.code, name: x.name, dept: x.dept, owner: x.owner,
      collaborators: [], watchers: [], approver: t.needApproval ? p.pm : null,
      start: x.due ? x.start : null, due: x.due, dueStatus: x.due ? 'fixed' : 'pending',
      completedAt: null, priority: '中', status: x.due ? '未着手' : '下書き',
      desc: '', checklist: t.checklist.map(c => ({ t: c, done: false })), preds: resolve(t.preds),
      origin: 'auto', visibility: '全社', createdBy: byUser, createdAt: Date.now(), attachments: []
    };
    S.tasks.push(task); created.push(task);
  }
  return created;
}

/* 基準日が確定した案件で「日付未確定」のタスクを計算する */
function recalcPending(S, p) {
  const plan = planTasks(S, p);
  const byCode = new Map(plan.map(x => [x.code, x]));
  const changed = [];
  for (const t of S.tasks.filter(t => t.pid === p.id && t.dueStatus === 'pending')) {
    const x = byCode.get(t.code);
    if (x && x.due) { t.due = x.due; t.start = x.start; t.dueStatus = 'fixed'; changed.push(t); }
  }
  return changed;
}

/* ---------- 工程変更：後続タスクへの影響（必要な分だけ後ろ倒し） ---------- */
function successors(S, tid) { return S.tasks.filter(t => t.preds.includes(tid)); }
function computeImpact(S, tid, newDue, excluded) {
  excluded = excluded || new Set();
  const base = S.tasks.find(t => t.id === tid);
  const delta = diffDays(newDue, base.due);
  const map = new Map();
  map.set(tid, { tid, oldStart: base.start, oldDue: base.due, newStart: base.start ? addDays(base.start, delta) : null, newDue, origin: true });
  const q = [tid];
  while (q.length) {
    const pid = q.shift();
    const pv = map.get(pid);
    if (excluded.has(pid) && !pv.origin) continue;
    const pDelta = diffDays(pv.newDue, pv.oldDue);
    if (pDelta <= 0) continue;
    for (const s of successors(S, pid)) {
      if (s.status === '完了' || s.status === '取消' || !s.due) continue;
      const cur = map.get(s.id) || { tid: s.id, oldStart: s.start, oldDue: s.due, newStart: s.start, newDue: s.due };
      const need = diffDays(pv.newDue, cur.newStart || cur.newDue) + 1;
      if (need <= 0) continue;
      const shift = Math.min(need, pDelta);
      const already = diffDays(cur.newDue, cur.oldDue);
      if (shift <= already) continue;
      cur.newStart = cur.oldStart ? addDays(cur.oldStart, shift) : null;
      cur.newDue = addDays(cur.oldDue, shift);
      map.set(s.id, cur); q.push(s.id);
    }
  }
  return [...map.values()];
}

/* ---------- 共通 ---------- */
function nid(S, prefix) { S.seq = (S.seq || 100) + 1; return prefix + S.seq; }

/* ---------- 初期データ ---------- */
function buildSeed() {
  const S = {
    v: 3, seq: 100, users: SEED_USERS.map(u => ({ ...u, active: true })), depts: DEPTS.map(d => ({ ...d })),
    perms: JSON.parse(JSON.stringify(PERM_DEFAULT)),
    groups: SEED_GROUPS.map((g, i) => ({ id: g.id, name: g.name, parent: g.parent || null, active: true, order: i })),
    options: SEED_GROUPS.flatMap(g => g.opts.map(([id, label]) => ({ id, group: g.id, label, active: true }))),
    templates: SEED_TEMPLATES.map(r => ({ code: r[0], name: r[1], dept: r[2], base: r[3], offset: r[4], dayType: r[5], duration: r[6], rules: r[7], preds: r[8], needApproval: r[9], checklist: r[10], active: true, version: 1 })),
    projects: [], tasks: [], requests: [], approvals: [], changes: [], activities: [], decisions: [], notifications: [],
    settings: { alertDays: [7, 3, 1, 0], overdue: true, mail: 'digest', push: false },
    me: null
  };
  const P = (o) => { const p = { id: nid(S, 'p'), visibility: '全社', note: '', contractDate: null, status: '進行中', createdOn: T(-40), confidential: null, ...o }; S.projects.push(p); return p; };

  const p1 = P({ no: '2026-0112', name: '青木様邸 新築工事', customer: '青木 隆', address: '市内 緑町3丁目', sales: 'u1', design: 'u3', construction: 'u5', pm: 'u2',
    conditions: ['land_no', 'acq_buy', 'k_house', 'w_new', 'soil_yes', 'imp_tbd', 'f_loan', 'permit_yes', 'sub_yes', 'choki_yes', 'br_other', 'clt_no', 'zo_no', 'kai_no'],
    createdOn: T(-75), contractPlanned: T(-12), contractDate: T(-12), startPlanned: T(38), completionPlanned: T(160), handoverPlanned: T(170),
    confidential: { cost: 28400000, price: 33800000, loan: 'みどり銀行 変動 35年', note: '値引き 50万円 承認済' } });
  const p2 = P({ no: '2026-0098', name: 'みどり保育園 改修工事', customer: '社会福祉法人 みどり会', address: '市内 本町1丁目', sales: 'u2', design: 'u4', construction: 'u9', pm: 'u6',
    conditions: ['land_yes', 'k_facility', 'w_reno', 'soil_no', 'f_other', 'permit_yes', 'sub_yes', 'choki_no', 'br_other', 'clt_yes', 'zo_no', 'kai_yes'],
    createdOn: T(-140), contractPlanned: T(-80), contractDate: T(-80), startPlanned: T(-8), completionPlanned: T(75), handoverPlanned: T(85),
    confidential: { cost: 61200000, price: 70500000, loan: '補助金＋自己資金', note: '' } });
  const p3 = P({ no: '2026-0131', name: '森田様邸 浴室修繕', customer: '森田 和子', address: '市内 西町5丁目', sales: 'u1', design: null, construction: 'u5', pm: 'u6',
    conditions: ['land_yes', 'k_small', 'w_repair', 'soil_no', 'f_cash', 'permit_no', 'sub_no', 'choki_no', 'br_other', 'clt_no', 'zo_no', 'kai_no'],
    createdOn: T(-6), contractPlanned: T(2), startPlanned: T(9), completionPlanned: T(14), handoverPlanned: T(15),
    confidential: { cost: 820000, price: 1080000, loan: '現金', note: '' } });
  const p4 = P({ no: '2026-0135', name: '市営住宅 東団地 外壁改修', customer: '市 建設部', address: '市内 東町', sales: 'u2', design: 'u3', construction: 'u6', pm: 'u7',
    conditions: ['land_yes', 'k_public', 'w_reno', 'soil_no', 'f_other', 'permit_no', 'sub_no', 'choki_no', 'br_other', 'clt_no', 'zo_no', 'kai_no'],
    createdOn: T(-3), contractPlanned: null, startPlanned: null, completionPlanned: null, handoverPlanned: null, status: '準備中',
    confidential: null });

  for (const p of [p1, p2, p3, p4]) {
    const tasks = createTasksFromPlan(S, p, planTasks(S, p), p.pm);
    act(S, { pid: p.id, uid: p.pm, type: 'project.created', text: '案件を登録し、標準タスクを' + tasks.length + '件自動生成しました', at: tsOf(p.createdOn, 10) });
  }

  // 進捗をそれらしく進める
  let k = 0;
  for (const t of S.tasks) {
    k++;
    if (!t.due) continue;
    const late = diffDays(TODAY, t.due);
    if (late > 0) {
      { t.status = '完了'; t.completedAt = addDays(t.due, k % 4 === 0 ? 1 : -1); t.checklist.forEach(c => c.done = true); }
    } else if (t.start && diffDays(TODAY, t.start) >= 0) {
      t.status = k % 3 === 0 ? '未着手' : '進行中';
      if (t.status === '進行中' && t.checklist[0]) t.checklist[0].done = true;
    }
  }
  const find = (p, code) => S.tasks.find(t => t.pid === p.id && t.code === code);
  const reopen = (t, st) => { if (t) { t.status = st; t.completedAt = null; } return t; };

  // 青木様邸：地盤調査は完了、改良方法の決定が進行中
  const aSoil = find(p1, 'T13'); if (aSoil) { aSoil.status = '回答待ち'; aSoil.collaborators = ['u5']; }
  const aDesign = find(p1, 'T14'); if (aDesign) { reopen(aDesign, '進行中'); aDesign.collaborators = ['u4']; aDesign.desc = '外壁・屋根の仕様は決定事項を参照。構造は長期優良住宅の基準で検討する。'; }
  const aLoan = find(p1, 'T11'); reopen(aLoan, '進行中');
  const aSub = find(p1, 'T08');
  const aConf = find(p1, 'T16');
  // 保育園：施工中
  const mMeet = find(p2, 'T21');
  const mMid = find(p2, 'T25');
  const mCheck = find(p2, 'T16'); if (mCheck) { mCheck.status = '完了'; mCheck.completedAt = T(-12); }
  // 小口：手配中
  const sTask = find(p3, 'T29'); if (sTask) { sTask.status = '進行中'; sTask.collaborators = ['u9']; }

  // 活動履歴
  const add = (o) => act(S, o);
  if (aSoil) {
    add({ pid: p1.id, tid: aSoil.id, uid: 'u3', type: 'report.start', text: '着手しました', at: tsOf(T(-4), 9) });
    add({ pid: p1.id, tid: aSoil.id, uid: 'u3', type: 'report.waiting', text: '回答待ちです', comment: '地盤調査会社へ改良要否の所見を依頼中。9/25頃回答予定。', at: tsOf(T(-2), 15) });
  }
  if (aDesign) {
    add({ pid: p1.id, tid: aDesign.id, uid: 'u3', type: 'report.start', text: '着手しました', at: tsOf(T(-9), 9) });
    add({ pid: p1.id, tid: aDesign.id, uid: 'u3', type: 'report.meeting', text: '打ち合わせ完了', comment: '施主打ち合わせ（2回目）。キッチン位置を北側へ変更。外壁はサイディングで確定。', at: tsOf(T(-5), 17) });
    add({ pid: p1.id, tid: aDesign.id, uid: 'u2', type: 'decision', text: '決定事項を登録しました', comment: '外壁はサイディング（色：ウォームグレー）で確定', at: tsOf(T(-5), 18) });
  }
  const dec = { id: nid(S, 'd'), pid: p1.id, content: '外壁はサイディング（色：ウォームグレー）で確定。塗り壁案は不採用。', by: 'u2', on: T(-5), tasks: [aDesign && aDesign.id].filter(Boolean), createdBy: 'u2' };
  S.decisions.push(dec);
  S.decisions.push({ id: nid(S, 'd'), pid: p2.id, content: '園児の登園時間（7:30〜9:00）は重機の搬入を行わない。', by: 'u6', on: T(-15), tasks: [mMeet && mMeet.id].filter(Boolean), createdBy: 'u6' });
  if (mMeet) add({ pid: p2.id, tid: mMeet.id, uid: 'u9', type: 'report.meeting', text: '打ち合わせ完了', comment: '園長・保護者会と工程共有。搬入時間帯の制限あり（決定事項参照）。', at: tsOf(T(-15), 16) });
  if (sTask) {
    add({ pid: p3.id, tid: sTask.id, uid: 'u5', type: 'report.start', text: '着手しました', at: tsOf(T(-4), 10) });
    add({ pid: p3.id, tid: sTask.id, uid: 'u5', type: 'report.issue', text: '問題が発生しました', comment: 'ユニットバスの指定品番が廃番。代替品の提案が必要。', at: tsOf(T(-1), 14) });
  }

  // 依頼
  const r1 = { id: nid(S, 'r'), pid: p1.id, from: 'u5', toDept: 'design', toUser: null, receiver: 'u4', title: '基礎伏図の最新版を共有してください', content: 'キッチン位置変更後の基礎伏図が必要です。基礎業者への見積依頼に使います。', reason: '基礎工事の見積依頼のため', desired: T(4), urgency: '急ぎ', status: 'sent', history: [{ uid: 'u5', act: '依頼を送信', at: tsOf(T(-1), 11) }], createdAt: tsOf(T(-1), 11) };
  const r2 = { id: nid(S, 'r'), pid: p3.id, from: 'u1', toDept: 'const', toUser: 'u9', receiver: 'u9', title: '浴室の現地調査に同行してください', content: '施主立ち会いのもと、既存浴室の寸法と配管位置を確認したいです。', reason: '代替品の選定のため', desired: T(3), urgency: '通常', status: 'sent', history: [{ uid: 'u1', act: '依頼を送信', at: tsOf(T(0), 8) }], createdAt: tsOf(T(0), 8) };
  const r3 = { id: nid(S, 'r'), pid: p1.id, from: 'u3', toDept: 'sales', toUser: 'u1', receiver: 'u1', title: '施主へ窓仕様の確認', content: '窓の仕様について施主に確認をお願いします。', reason: '実施設計の確定のため', desired: T(6), urgency: '通常', status: 'returned', history: [{ uid: 'u3', act: '依頼を送信', at: tsOf(T(-3), 10) }, { uid: 'u1', act: '差し戻し（情報不足）', comment: 'どの窓か（図面番号）と、確認したい項目を記載してください。', at: tsOf(T(-2), 9) }], createdAt: tsOf(T(-3), 10) };
  S.requests.push(r1, r2, r3);
  add({ pid: p1.id, uid: 'u5', type: 'request.sent', text: '設計へ依頼を送信「' + r1.title + '」', at: tsOf(T(-1), 11) });
  add({ pid: p1.id, uid: 'u1', type: 'request.returned', text: '依頼を差し戻し「' + r3.title + '」', comment: r3.history[1].comment, at: tsOf(T(-2), 9) });

  // 期限変更申請（設計 田中 → 所属長 伊藤）
  if (aConf && aConf.due) {
    const items = computeImpact(S, aConf.id, addDays(aConf.due, 7));
    S.changes.push({ id: nid(S, 'c'), kind: 'due', pid: p1.id, tid: aConf.id, reason: '長期優良住宅の認定審査が混雑しており、書類の差し替えが発生', oldDate: aConf.due, newDate: addDays(aConf.due, 7), impact: '確認申請以降', comment: '審査機関に確認済み', items: items.map(i => ({ ...i, excluded: false })), status: 'pending', by: 'u3', approver: 'u4', at: tsOf(T(-1), 16) });
    aConf.status = '承認待ち';
  }
  // 工程変更申請（保育園 工務 加藤 → 案件責任者 山本）
  if (mMid && mMid.due) {
    const nd = addDays(mMid.due, 6);
    const items = computeImpact(S, mMid.id, nd);
    S.changes.push({ id: nid(S, 'c'), kind: 'slip', pid: p2.id, tid: mMid.id, reason: '資材（CLTパネル）の納品遅れ', oldDate: mMid.due, newDate: nd, impact: '竣工検査・完了検査・引渡し', comment: 'メーカーより6日遅れの連絡あり。', items: items.map(i => ({ ...i, excluded: false })), status: 'pending', by: 'u9', approver: 'u6', at: tsOf(T(0), 9) });
    add({ pid: p2.id, tid: mMid.id, uid: 'u9', type: 'report.slip', text: '工程がずれました（承認待ち）', comment: '資材（CLTパネル）の納品遅れ。6日遅れの見込み。', at: tsOf(T(0), 9) });
  }
  // 完了申請
  if (aSub) { reopen(aSub, '承認待ち'); aSub.approver = 'u2'; S.approvals.push({ id: nid(S, 'a'), kind: 'complete', pid: p1.id, tid: aSub.id, by: 'u1', approver: 'u2', status: 'pending', comment: '子育てグリーン住宅支援の対象を確認済み。要件表を添付しました。', at: tsOf(T(0), 8) }); }

  // 通知
  const N = (uid, level, text, link, ago) => S.notifications.push({ id: nid(S, 'n'), uid, level, text, link, at: Date.now() - ago * 3600000, read: false });
  N('u4', 'important', '渡辺 大輔さんから依頼「基礎伏図の最新版を共有してください」が届きました', { v: 'request', id: r1.id }, 20);
  N('u9', 'important', '佐藤 健太さんから依頼「浴室の現地調査に同行してください」が届きました', { v: 'request', id: r2.id }, 2);
  N('u3', 'important', '依頼「施主へ窓仕様の確認」が差し戻されました', { v: 'request', id: r3.id }, 30);
  N('u6', 'important', '加藤 陽介さんから工程変更の承認依頼が届きました（みどり保育園）', { v: 'change', id: S.changes[1] && S.changes[1].id }, 1);
  N('u4', 'important', '田中 翔さんから期限変更の承認依頼が届きました（青木様邸）', { v: 'change', id: S.changes[0] && S.changes[0].id }, 18);
  N('u2', 'important', '佐藤 健太さんから完了申請が届きました「補助金の要件確認」', { v: 'task', id: aSub && aSub.id }, 3);
  N('u6', 'urgent', '問題が発生しました：森田様邸 浴室修繕「ユニットバスの指定品番が廃番」', { v: 'task', id: sTask && sTask.id }, 22);
  N('u1', 'normal', '田中 翔さんがコメントしました「実施設計」', { v: 'task', id: aDesign && aDesign.id }, 40);
  N('u5', 'normal', '前工程「地盤調査の手配」が完了しました。「地盤改良方法の決定」を開始できます', { v: 'task', id: aSoil && aSoil.id }, 50);
  N('u3', 'normal', '高橋 美咲さんが決定事項を登録しました「外壁はサイディング…」', { v: 'project', id: p1.id }, 110);
  return S;
}
function tsOf(dateIso, h) { const d = parse(dateIso); d.setHours(h, 0, 0, 0); return d.getTime(); }
function act(S, o) { S.activities.push({ id: nid(S, 'a'), at: Date.now(), ...o }); }
