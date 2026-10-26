/**
 * ふたり家計簿 - PairBudget フロントエンド v2
 * LIFF認証 / GAS API / Chart.js / レシートAI-OCR / 価格検索 / 変更履歴
 *
 * 方針:
 *  - 実接続時はサーバーが唯一の正。書き込み成功後にデータを再取得して画面を更新する
 *  - GAS URL未設定のときだけデモモード（メモリ上のモックDB）で動作する
 *  - 外部由来の文字列（OCR結果・品名など）は必ず esc() でエスケープして描画する
 */

const APP_CONFIG = window.PAIRBUDGET_CONFIG || {};
const MAX_HISTORY_MONTHS = 36;
const FIELD_LABELS = {
  date: '日付', title: '品名', amount: '金額', category: 'カテゴリ', isShared: '共同',
  paymentType: '決済手段', payer: '支払者', memo: 'メモ',
  husband: '夫の基本拠出', wife: '妻の基本拠出', isPaid: '振込状況',
  billingDay: '引落日', isActive: '有効', keyword: 'キーワード', color: 'カラー', role: '役割',
  store: '店名', total: '合計', itemCount: '品数'
};
const PAYMENT_LABELS = { shared_card: '共同カード', advanced_by_user: '個人立替', personal_cash: '個人自腹' };

// ==========================================
// ユーティリティ
// ==========================================
function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const yen = n => '¥' + Number(n || 0).toLocaleString();
const $ = id => document.getElementById(id);

function pad2(n) { return String(n).padStart(2, '0'); }
function localDateStr(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function localMonthStr(d = new Date()) { return localDateStr(d).slice(0, 7); }
function shiftMonth(monthStr, delta) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return localMonthStr(d);
}
function shortDateTime(s) { // 'yyyy-MM-dd HH:mm:ss' -> 'M/D HH:mm'
  const m = String(s || '').match(/^\d{4}-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${Number(m[1])}/${Number(m[2])} ${m[3]}:${m[4]}` : String(s || '');
}

// ==========================================
// アプリケーション状態
// ==========================================
const state = {
  viewMonth: localMonthStr(),
  activeScope: 'shared',
  currentUser: '夫',
  actorVerified: false,
  isMockMode: false,
  liffReady: false,
  privacyMask: localStorage.getItem('pairbudget_privacy_mask') === 'true',
  gasApiUrl: localStorage.getItem('pairbudget_gas_url') || APP_CONFIG.GAS_URL || '',
  trendRange: 12,
  categoryChart: null,
  trendChart: null,
  busy: false,

  summary: { budget: 240000, totalExpense: 0, remaining: 240000, progressRate: 0, daysLeft: 0, dailyAllowance: 0, isCurrentMonth: true },
  transfers: {
    husband: { baseContribution: 60000, privateOnSharedCard: 0, advancedForShared: 0, totalTransfer: 60000, isPaid: false },
    wife: { baseContribution: 60000, privateOnSharedCard: 0, advancedForShared: 0, totalTransfer: 60000, isPaid: false }
  },
  config: { husbandBaseContribution: 60000, wifeBaseContribution: 60000 },
  transactions: [],
  receiptItems: [],
  monthlyTotals: [],
  shoppingList: [],
  fixedExpenses: [],
  categories: [],
  rules: []
};

// ==========================================
// デモ用モックDB（GAS未設定時のみ使用）
// ==========================================
const mockDb = { transactions: [], receiptItems: [], shopping: [], audit: [], budgets: {}, paid: {}, seeded: false };
const MOCK_CATEGORIES = [
  { name: '食費', color: '#10B981', icon: 'utensils' }, { name: '日用品', color: '#3B82F6', icon: 'shopping-bag' },
  { name: '外食', color: '#F59E0B', icon: 'coffee' }, { name: '住居費', color: '#6366F1', icon: 'home' },
  { name: '水道光熱費', color: '#06B6D4', icon: 'zap' }, { name: '通信費', color: '#8B5CF6', icon: 'wifi' },
  { name: '趣味・衣服', color: '#EC4899', icon: 'heart' }, { name: 'その他', color: '#6B7280', icon: 'more-horizontal' }
];
const MOCK_FIXED = [
  { id: 'f1', title: '家賃', amount: 110000, category: '住居費', billingDay: 27, isActive: true },
  { id: 'f2', title: '光熱費 (電気・ガス)', amount: 15000, category: '水道光熱費', billingDay: 20, isActive: true },
  { id: 'f3', title: 'ネット光回線', amount: 5200, category: '通信費', billingDay: 15, isActive: true }
];
const MOCK_RULES = [{ keyword: 'イオン', category: '食費' }, { keyword: 'ライフ', category: '食費' }, { keyword: 'ドラッグ', category: '日用品' }];

function mockNow() { const d = new Date(); return `${localDateStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
function mockId() { return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function seedMockDb() {
  if (mockDb.seeded) return;
  mockDb.seeded = true;
  const cur = localMonthStr();
  const rnd = n => ((n * 9301 + 49297) % 233280) / 233280; // 決定的な疑似乱数
  const addTx = (date, title, amount, category, isShared, paymentType, payer, receiptId = '') => {
    mockDb.transactions.push({
      id: mockId(), date, title, amount, category, isShared, paymentType, payer, memo: '',
      createdBy: payer === '妻' ? '妻' : '夫', createdAt: date + ' 12:00:00', updatedBy: '', updatedAt: '', receiptId
    });
  };
  const addReceipt = (date, store, payer, items) => {
    const rid = mockId();
    items.forEach(([name, quantity, price]) => mockDb.receiptItems.push({
      receiptId: rid, date, store, name, quantity, price, unitPrice: Math.round(price / quantity), isShared: true, payer
    }));
    addTx(date, store, items.reduce((s, it) => s + it[2], 0), '食費', true, 'shared_card', payer, rid);
  };
  for (let i = 35; i >= 1; i--) {
    const m = shiftMonth(cur, -i);
    addTx(`${m}-27`, '【固定費】家賃', 110000, '住居費', true, 'shared_card', '夫');
    addTx(`${m}-20`, '【固定費】光熱費', 11000 + Math.floor(rnd(i) * 9000), '水道光熱費', true, 'shared_card', '妻');
    addTx(`${m}-10`, 'スーパー', 38000 + Math.floor(rnd(i + 7) * 22000), '食費', true, 'shared_card', '妻');
    addTx(`${m}-15`, '外食', 8000 + Math.floor(rnd(i + 3) * 14000), '外食', true, 'shared_card', '夫');
    addTx(`${m}-18`, '私物', 5000 + Math.floor(rnd(i + 5) * 15000), '趣味・衣服', false, 'shared_card', i % 2 ? '夫' : '妻');
  }
  addReceipt(`${shiftMonth(cur, -2)}-12`, 'イオン', '妻', [['ネギ', 1, 150], ['豆腐', 2, 160], ['牛乳', 1, 208]]);
  addReceipt(`${shiftMonth(cur, -1)}-08`, 'ライフ', '夫', [['長ねぎ', 1, 168], ['豆腐', 1, 98], ['卵', 1, 238]]);
  addReceipt(`${cur}-03`, 'イオン', '妻', [['ネギ', 1, 198], ['豆腐', 1, 90], ['牛乳', 1, 218], ['卵', 1, 248]]);
  const d = n => `${cur}-${pad2(Math.min(n, 28))}`;
  addTx(d(2), 'ドラッグストア洗剤', 2000, '日用品', true, 'advanced_by_user', '夫');
  addTx(d(4), 'スニーカー (私物購入)', 12000, '趣味・衣服', false, 'shared_card', '夫');
  addTx(d(5), 'カフェ ランチ', 2400, '外食', true, 'shared_card', '夫');
  addTx(d(6), 'ドラッグストア調味料', 5000, '食費', true, 'advanced_by_user', '妻');
  mockDb.shopping = [
    { id: 's1', title: '牛乳・低脂肪乳', category: '食費', isCompleted: false, requestedBy: '妻', createdAt: d(5) },
    { id: 's2', title: '食器用洗剤詰め替え', category: '日用品', isCompleted: false, requestedBy: '夫', createdAt: d(4) }
  ];
  // 編集履歴のデモ（他者が編集した例）
  const demo = mockDb.transactions.find(t => t.title === 'カフェ ランチ');
  demo.updatedBy = '妻'; demo.updatedAt = `${d(7)} 21:30:00`;
  mockDb.audit.push({ at: `${d(7)} 21:30:00`, actor: '妻', verified: true, action: '更新', targetType: '支出', targetId: demo.id,
    before: { amount: 2400 }, after: { amount: 2400, memo: 'ふたりで休日ランチ' } });
}

function mockBuildInitial(month) {
  seedMockDb();
  const txs = mockDb.transactions.filter(t => t.date.startsWith(month))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const budget = mockDb.budgets[month] || 240000;
  const isCurrent = month === localMonthStr();
  const total = txs.filter(t => t.isShared).reduce((s, t) => s + t.amount, 0);
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const daysLeft = isCurrent ? Math.max(1, lastDay - new Date().getDate() + 1) : 0;
  const remaining = budget - total;

  const acc = { '夫': { priv: 0, adv: 0 }, '妻': { priv: 0, adv: 0 } };
  txs.forEach(t => {
    if (!acc[t.payer]) return;
    if (!t.isShared && t.paymentType === 'shared_card') acc[t.payer].priv += t.amount;
    if (t.isShared && t.paymentType === 'advanced_by_user') acc[t.payer].adv += t.amount;
  });
  const hb = state.config.husbandBaseContribution, wb = state.config.wifeBaseContribution;
  const tr = (base, who) => ({ baseContribution: base, privateOnSharedCard: acc[who].priv, advancedForShared: acc[who].adv,
    totalTransfer: Math.max(0, base + acc[who].priv - acc[who].adv), isPaid: !!mockDb.paid[month + who] });

  const totals = [];
  for (let i = MAX_HISTORY_MONTHS - 1; i >= 0; i--) {
    const mm = shiftMonth(localMonthStr(), -i);
    const row = { month: mm, shared: 0, personal: { '夫': 0, '妻': 0 }, budget: mockDb.budgets[mm] || 240000 };
    mockDb.transactions.filter(t => t.date.startsWith(mm)).forEach(t => {
      if (t.isShared) row.shared += t.amount; else if (row.personal[t.payer] !== undefined) row.personal[t.payer] += t.amount;
    });
    totals.push(row);
  }
  return {
    success: true, month, actor: { name: state.currentUser, verified: false }, transactions: txs,
    receiptItems: mockDb.receiptItems.filter(it => it.date.startsWith(month)),
    shoppingList: mockDb.shopping, monthlyBudgets: [], fixedExpenses: MOCK_FIXED, categories: MOCK_CATEGORIES, rules: MOCK_RULES,
    config: { husbandBaseContribution: hb, wifeBaseContribution: wb },
    transfers: { husband: tr(hb, '夫'), wife: tr(wb, '妻') },
    summary: { budget, totalExpense: total, remaining, progressRate: Math.min(100, Math.round(total / budget * 100)),
      daysLeft, dailyAllowance: isCurrent ? Math.max(0, Math.floor(remaining / daysLeft)) : 0, isCurrentMonth: isCurrent },
    monthlyTotals: totals
  };
}

function mockAudit(action, targetType, targetId, before, after) {
  mockDb.audit.unshift({ at: mockNow(), actor: state.currentUser, verified: false, action, targetType, targetId, before, after });
}

function pickTxFields(t) {
  return { date: t.date, title: t.title, amount: t.amount, category: t.category, isShared: t.isShared,
    paymentType: t.paymentType, payer: t.payer, memo: t.memo };
}

async function mockApi(action, data) {
  seedMockDb();
  switch (action) {
    case 'getInitialData': return mockBuildInitial(data.month || state.viewMonth);
    case 'addTransaction': {
      if (!Number.isInteger(data.amount) || data.amount <= 0) return { success: false, error: '金額は1円以上の整数で入力してください' };
      const tx = { ...data, id: mockId(), memo: data.memo || '', createdBy: state.currentUser, createdAt: mockNow(), updatedBy: '', updatedAt: '', receiptId: '' };
      mockDb.transactions.push(tx);
      mockAudit('追加', '支出', tx.id, null, pickTxFields(tx));
      return { success: true, id: tx.id };
    }
    case 'updateTransaction': {
      const tx = mockDb.transactions.find(t => t.id === data.id);
      if (!tx) return { success: false, error: '対象の支出が見つかりません' };
      const before = pickTxFields(tx);
      const next = { ...data };
      if (tx.receiptId) { next.amount = tx.amount; next.title = tx.title; }
      Object.assign(tx, pickTxFields(next), { updatedBy: state.currentUser, updatedAt: mockNow() });
      if (tx.receiptId && before.date !== tx.date) {
        mockDb.receiptItems.forEach(it => { if (it.receiptId === tx.receiptId) it.date = tx.date; });
      }
      mockAudit('更新', '支出', tx.id, before, pickTxFields(tx));
      return { success: true };
    }
    case 'deleteTransaction': {
      const idx = mockDb.transactions.findIndex(t => t.id === data.id);
      if (idx < 0) return { success: false, error: '削除対象が見つかりません' };
      const [tx] = mockDb.transactions.splice(idx, 1);
      const before = pickTxFields(tx);
      if (tx.receiptId) {
        before.receiptId = tx.receiptId;
        before.items = mockDb.receiptItems.filter(it => it.receiptId === tx.receiptId)
          .map(it => ({ name: it.name, quantity: it.quantity, price: it.price }));
        mockDb.receiptItems = mockDb.receiptItems.filter(it => it.receiptId !== tx.receiptId);
      }
      mockAudit('削除', '支出', tx.id, before, null);
      return { success: true };
    }
    case 'scanReceipt':
      await new Promise(r => setTimeout(r, 1200));
      return { success: true, receipt: { store: 'イオン', date: localDateStr(), total: 736,
        items: [{ name: 'ネギ', quantity: 1, price: 180 }, { name: '豆腐', quantity: 1, price: 90 }, { name: '牛乳', quantity: 1, price: 218 }, { name: '卵', quantity: 1, price: 248 }] } };
    case 'saveReceipt': {
      const total = data.items.reduce((s, it) => s + it.price, 0);
      if (total <= 0) return { success: false, error: '合計金額が0円以下です' };
      const rid = mockId();
      data.items.forEach(it => mockDb.receiptItems.push({ receiptId: rid, date: data.date, store: data.store, name: it.name,
        quantity: it.quantity, price: it.price, unitPrice: Math.round(it.price / it.quantity), isShared: data.isShared, payer: data.payer }));
      const tx = { id: mockId(), date: data.date, title: data.store, amount: total, category: data.category, isShared: data.isShared,
        paymentType: data.paymentType, payer: data.payer, memo: 'レシート読み取り', createdBy: state.currentUser, createdAt: mockNow(),
        updatedBy: '', updatedAt: '', receiptId: rid };
      mockDb.transactions.push(tx);
      mockAudit('追加', 'レシート', tx.id, null, { receiptId: rid, store: data.store, date: data.date, total, itemCount: data.items.length, isShared: data.isShared, payer: data.payer });
      return { success: true, receiptId: rid, txId: tx.id, total };
    }
    case 'searchPrices': return mockSearchPrices(data.query);
    case 'getAuditLog': {
      const logs = mockDb.audit.filter(l => !data.targetId || l.targetId === data.targetId).slice(0, data.limit || 50);
      return { success: true, logs };
    }
    case 'addShoppingItem': mockDb.shopping.unshift({ ...data, isCompleted: false, requestedBy: state.currentUser, createdAt: localDateStr() }); return { success: true };
    case 'updateShoppingItem': { const s = mockDb.shopping.find(x => x.id === data.id); if (s) s.isCompleted = !!data.isCompleted; return { success: true }; }
    case 'deleteShoppingItem': mockDb.shopping = mockDb.shopping.filter(s => s.id !== data.id); return { success: true };
    case 'updateMonthlyBudget': {
      const prev = mockDb.budgets[data.month];
      mockDb.budgets[data.month] = data.amount;
      mockAudit(prev !== undefined ? '更新' : '追加', '月別予算', data.month, prev !== undefined ? { amount: prev } : null, { amount: data.amount });
      return { success: true };
    }
    case 'updateTransferStatus': {
      const prev = !!mockDb.paid[data.month + data.payer];
      mockDb.paid[data.month + data.payer] = data.isPaid;
      mockAudit('更新', '振込状況', `${data.month}:${data.payer}`, { isPaid: prev }, { isPaid: data.isPaid });
      return { success: true };
    }
    case 'updateBaseContribution': {
      const before = { husband: state.config.husbandBaseContribution, wife: state.config.wifeBaseContribution };
      state.config.husbandBaseContribution = data.husband;
      state.config.wifeBaseContribution = data.wife;
      mockAudit('更新', '基本拠出額', 'baseContribution', before, { husband: data.husband, wife: data.wife });
      return { success: true };
    }
    default: return { success: true };
  }
}

function normalizeName(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60)).replace(/\s+/g, '');
}

function mockSearchPrices(query) {
  const q = normalizeName(query);
  if (!q) return { success: false, error: '検索する品名を入力してください' };
  const matched = mockDb.receiptItems.filter(it =>
    it.price > 0 && it.unitPrice > 0 &&
    (it.isShared !== false || it.payer === state.currentUser) &&
    normalizeName(it.name).includes(q)
  ).sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!matched.length) return { success: true, query, count: 0, stats: null, byStore: [], history: [] };
  const prices = matched.map(m => m.unitPrice);
  const storeMap = {};
  matched.forEach(m => {
    const s = storeMap[m.store] || (storeMap[m.store] = { store: m.store, latest: m.unitPrice, latestDate: m.date, min: m.unitPrice, count: 0 });
    s.min = Math.min(s.min, m.unitPrice); s.count++;
  });
  return { success: true, query, count: matched.length,
    stats: { latest: matched[0].unitPrice, min: Math.min(...prices), max: Math.max(...prices), avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) },
    byStore: Object.values(storeMap).sort((a, b) => a.min - b.min), history: matched.slice(0, 100) };
}

// ==========================================
// 通信
// ==========================================
async function callGas(action, data) {
  const idToken = state.liffReady ? liff.getIDToken() : null;
  const res = await fetch(state.gasApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' }, // CORSプリフライト回避
    body: JSON.stringify({ action, data: data || {}, idToken })
  });
  return res.json();
}

async function api(action, data = {}) {
  try {
    return state.isMockMode ? await mockApi(action, data) : await callGas(action, data);
  } catch (err) {
    console.warn('API通信エラー:', action, err);
    return { success: false, error: '通信に失敗しました。電波の良い場所で再試行してください' };
  }
}

function handleApiError(res) {
  if (res.code === 'AUTH' && state.liffReady) {
    showToast('ログインの有効期限が切れました。再ログインします');
    setTimeout(() => liff.login(), 1200);
    return;
  }
  if (res.code === 'UNREGISTERED') {
    showBanner(res.error, 'error');
    openRegisterModal(res.availableRoles);
    return;
  }
  showToast(res.error || 'エラーが発生しました');
}

function openRegisterModal(availableRoles) {
  const canHusband = Array.isArray(availableRoles) ? availableRoles.includes('夫') : (availableRoles && typeof availableRoles === 'object' ? !!availableRoles.husband : true);
  const canWife = Array.isArray(availableRoles) ? availableRoles.includes('妻') : (availableRoles && typeof availableRoles === 'object' ? !!availableRoles.wife : true);
  $('registerHusbandBtn').disabled = !canHusband;
  $('registerWifeBtn').disabled = !canWife;
  $('registerMemberModal').classList.remove('hidden');
}

async function submitRegisterMember(role) {
  const registerCode = $('registerCodeInput').value.trim();
  $('registerHusbandBtn').disabled = true;
  $('registerWifeBtn').disabled = true;
  const res = await api('registerMember', { role, registerCode });
  if (!res.success) {
    showToast(res.error || '登録に失敗しました');
    openRegisterModal(res.availableRoles);
    return;
  }
  $('registerMemberModal').classList.add('hidden');
  hideBanner();
  showToast(res.message || `${role}として登録しました！`);
  await loadInitialData();
}

function showBanner(msg, kind) {
  const banner = $('mockBanner');
  banner.classList.remove('hidden');
  banner.className = banner.className.replace(/bg-(amber|rose)-500/g, '') + (kind === 'error' ? ' bg-rose-500' : ' bg-amber-500');
  banner.querySelector('span').textContent = msg;
}

function hideBanner() { $('mockBanner').classList.add('hidden'); }

/**
 * 書き込み → 成功なら最新データを再取得して画面更新
 */
async function writeAndRefresh(action, data, successMsg) {
  if (state.busy) return { success: false };
  state.busy = true;
  try {
    const res = await api(action, data);
    if (!res.success) { handleApiError(res); return res; }
    await loadInitialData();
    if (successMsg) showToast(successMsg);
    return res;
  } finally {
    state.busy = false;
  }
}

async function loadInitialData(month) {
  if (month) state.viewMonth = month;

  if (!state.gasApiUrl) {
    state.isMockMode = true;
    showBanner('デモモードで動作中（GAS URL未設定・データは保存されません）', 'warn');
    applyData(await mockApi('getInitialData', { month: state.viewMonth }));
    return;
  }

  state.isMockMode = false;
  const res = await api('getInitialData', { month: state.viewMonth });
  if (!res.success) {
    handleApiError(res);
    if (res.code !== 'UNREGISTERED' && res.code !== 'AUTH') showBanner('サーバーに接続できません。再読み込みしてください', 'error');
    return;
  }
  hideBanner();
  applyData(res);
}

function applyData(data) {
  state.viewMonth = data.month;
  state.transactions = data.transactions || [];
  state.receiptItems = data.receiptItems || [];
  state.shoppingList = data.shoppingList || [];
  state.fixedExpenses = data.fixedExpenses || [];
  state.categories = data.categories || [];
  state.rules = data.rules || [];
  state.monthlyTotals = data.monthlyTotals || [];
  state.summary = data.summary || state.summary;
  state.transfers = data.transfers || state.transfers;
  if (data.config) state.config = data.config;
  if (data.actor && data.actor.verified) {
    state.currentUser = data.actor.name;
    state.actorVerified = true;
  }
  renderAll();
}

// ==========================================
// 描画
// ==========================================
function renderAll() {
  renderMonthNav();
  renderCategoryDropdown();
  renderTransferCard();
  renderBudgetSummary();
  renderCharts();
  renderRecentTransactions();
  renderShoppingList();
  renderHistoryList();
  renderFixedExpenses();
  renderSettings();
  lucide.createIcons();
}

function renderMonthNav() {
  const [y, m] = state.viewMonth.split('-');
  $('currentMonthLabel').textContent = `${y}年${Number(m)}月`;
  $('nextMonthBtn').disabled = state.viewMonth >= localMonthStr();
  $('prevMonthBtn').disabled = state.viewMonth <= shiftMonth(localMonthStr(), -(MAX_HISTORY_MONTHS - 1));
}

function renderTransferCard() {
  [['husband', '夫', 'blue'], ['wife', '妻', 'pink']].forEach(([key, who, color]) => {
    const t = state.transfers[key];
    $(`${key}Amount`).textContent = yen(t.totalTransfer);
    $(`${key}Breakdown`).innerHTML =
      `<div>基本: ${yen(t.baseContribution)}</div><div>私物: +${yen(t.privateOnSharedCard)} / 立替: -${yen(t.advancedForShared)}</div>`;
    const badge = $(`${key}StatusBadge`);
    const btn = $(`${key}PayToggle`);
    if (t.isPaid) {
      badge.textContent = '振込済';
      badge.className = 'text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-bold';
      btn.innerHTML = '<i data-lucide="check" class="w-3.5 h-3.5"></i> 振込済み（取消）';
      btn.className = 'mt-2.5 w-full py-1.5 rounded-lg text-xs font-bold bg-slate-700 text-slate-300 flex items-center justify-center gap-1';
    } else {
      badge.textContent = '未完了';
      badge.className = 'text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-medium';
      btn.innerHTML = '<i data-lucide="check-circle" class="w-3.5 h-3.5"></i> 振込済みにする';
      btn.className = `mt-2.5 w-full py-1.5 rounded-lg text-xs font-bold bg-${color}-600 hover:bg-${color}-500 text-white flex items-center justify-center gap-1`;
    }
  });
}

function renderBudgetSummary() {
  const s = state.summary;
  $('budgetProgressRate').textContent = `${s.progressRate}% 消化`;
  const bar = $('budgetProgressBar');
  bar.style.width = `${s.progressRate}%`;
  const tone = s.progressRate > 90 ? 'bg-rose-500' : s.progressRate > 75 ? 'bg-amber-500' : 'bg-brand-500';
  bar.className = `${tone} h-full rounded-full transition-all duration-500`;
  $('remainingBudget').textContent = yen(s.remaining);
  $('daysLeft').textContent = s.isCurrentMonth ? s.daysLeft : '-';
  $('dailyAllowance').textContent = s.isCurrentMonth ? `${yen(s.dailyAllowance)} / 日` : '（過去の月）';
  $('totalExpenseSummary').textContent = `支出合計: ${yen(s.totalExpense)}`;
}

/** スコープ（共同/自分）に応じた表示対象の支出 */
function scopedTransactions() {
  return state.transactions.filter(t => state.activeScope === 'shared'
    ? t.isShared
    : (!t.isShared && t.payer === state.currentUser));
}

function renderCharts() {
  renderCategoryChart();
  renderTrendChart();
}

function renderCategoryChart() {
  const canvas = $('categoryChart');
  const ctx = canvas.getContext('2d');
  const totals = {};
  scopedTransactions().forEach(t => { totals[t.category] = (totals[t.category] || 0) + Number(t.amount); });
  const labels = Object.keys(totals);
  if (state.categoryChart) state.categoryChart.destroy();
  state.categoryChart = null;
  if (!labels.length) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
  const colors = labels.map(l => (state.categories.find(c => c.name === l) || {}).color || '#94A3B8');
  state.categoryChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: labels.map(l => totals[l]), backgroundColor: colors, borderWidth: 2, borderColor: '#FFFFFF' }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } } }
  });
}

function renderTrendChart() {
  const canvas = $('trendChart');
  if (state.trendChart) state.trendChart.destroy();
  state.trendChart = null;
  const rows = (state.monthlyTotals || []).slice(-state.trendRange);
  if (!rows.length) return;

  const shared = state.activeScope === 'shared';
  const labels = rows.map(r => { const [y, m] = r.month.split('-'); return state.trendRange > 12 ? `${y.slice(2)}/${Number(m)}` : `${Number(m)}月`; });
  const datasets = [{
    label: shared ? '共同の支出' : '自分の私物支出',
    data: rows.map(r => shared ? r.shared : (r.personal[state.currentUser] || 0)),
    borderColor: '#10B981', backgroundColor: 'rgba(16,185,129,0.12)', fill: true, tension: 0.3,
    pointRadius: state.trendRange > 12 ? 1.5 : 3, borderWidth: 2
  }];
  if (shared) {
    datasets.push({ label: '月の予算', data: rows.map(r => r.budget), borderColor: '#94A3B8', borderDash: [5, 4],
      pointRadius: 0, borderWidth: 1.5, fill: false });
  }
  state.trendChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: {
        y: { beginAtZero: true, ticks: { font: { size: 10 }, callback: v => (v >= 10000 ? (v / 10000) + '万' : v) } },
        x: { ticks: { font: { size: 10 }, maxTicksLimit: 12 } }
      },
      plugins: {
        legend: { labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${yen(c.parsed.y)}` } }
      }
    }
  });
}

/**
 * 支出1件の行。レシート由来の支出は店名でグループ化し、明細（ー ネギ 180）を展開表示する
 */
function createTransactionRow(item, isEditable) {
  const wrap = document.createElement('div');
  const masked = !item.isShared && state.privacyMask && item.payer !== state.currentUser;
  const title = masked ? '🔒 私物支出 (マスキング中)' : item.title;

  let tag = '';
  if (!item.isShared && item.paymentType === 'shared_card') tag = '<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-bold">私物(返還要)</span>';
  else if (item.isShared && item.paymentType === 'advanced_by_user') tag = '<span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-bold">立替</span>';

  const edited = item.updatedBy
    ? `<div class="text-[10px] text-slate-500">✏️ ${esc(item.updatedBy)}が修正 ${esc(shortDateTime(item.updatedAt))}</div>`
    : '';
  const meta = `<div class="text-[10px] text-slate-400">登録: ${esc(item.createdBy || '不明')} ${esc(shortDateTime(item.createdAt))}</div>${edited}`;

  const payerColor = item.payer === '夫' ? 'text-blue-500 bg-blue-50' : item.payer === '妻' ? 'text-pink-500 bg-pink-50' : 'text-slate-500 bg-slate-100';
  const items = item.receiptId && !masked ? state.receiptItems.filter(it => it.receiptId === item.receiptId) : [];

  const actions = isEditable ? `
    <button data-action="tx-history" data-id="${esc(item.id)}" class="text-slate-300 hover:text-slate-600 p-1" aria-label="変更履歴"><i data-lucide="history" class="w-3.5 h-3.5"></i></button>
    <button data-action="edit-tx" data-id="${esc(item.id)}" class="text-slate-300 hover:text-slate-600 p-1" aria-label="編集"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i></button>` : '';

  const head = `
    <div class="flex items-center gap-2.5 min-w-0">
      <span class="w-6 h-6 shrink-0 rounded-full ${payerColor} flex items-center justify-center text-[10px] font-bold">${esc(item.payer)}</span>
      <div class="min-w-0">
        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="text-xs font-bold text-slate-800 break-all">${item.receiptId ? '🧾 ' : ''}${esc(title)}</span>${tag}
        </div>
        <div class="text-[10px] text-slate-400">${esc(item.date)} ・ ${esc(item.category)}${items.length ? ` ・ ${items.length}品` : ''}</div>
        ${meta}
      </div>
    </div>
    <div class="flex items-center gap-1 shrink-0">
      <span class="text-sm font-black text-slate-900">${yen(item.amount)}</span>${actions}
    </div>`;

  if (items.length) {
    const lines = items.map(it => `<div class="flex justify-between text-[11px] text-slate-600"><span>ー ${esc(it.name)}${it.quantity > 1 ? ` ×${it.quantity}` : ''}</span><span>${yen(it.price)}</span></div>`).join('');
    wrap.innerHTML = `<details class="group py-2.5">
      <summary class="flex items-center justify-between cursor-pointer list-none gap-2">${head}</summary>
      <div class="ml-8 mt-1.5 pl-2 border-l-2 border-brand-100 space-y-0.5">${lines}</div></details>`;
  } else {
    wrap.innerHTML = `<div class="py-3 flex items-center justify-between gap-2">${head}</div>`;
  }
  return wrap;
}

function renderRecentTransactions() {
  const c = $('recentTransactionsList');
  c.innerHTML = '';
  const list = scopedTransactions().slice(0, 5);
  if (!list.length) { c.innerHTML = '<div class="py-4 text-center text-xs text-slate-400">この月の支出はまだありません</div>'; return; }
  list.forEach(i => c.appendChild(createTransactionRow(i, false)));
}

function renderHistoryList() {
  const c = $('fullTransactionsList');
  c.innerHTML = '';
  const cat = $('historyCategoryFilter').value;
  const payer = $('historyPayerFilter').value;
  const list = scopedTransactions().filter(t => (cat === 'all' || t.category === cat) && (payer === 'all' || t.payer === payer));
  if (!list.length) { c.innerHTML = '<div class="py-8 text-center text-xs text-slate-400">該当する支出はありません</div>'; return; }
  list.forEach(i => c.appendChild(createTransactionRow(i, true)));
}

function renderShoppingList() {
  const un = $('uncompletedShoppingList'), done = $('completedShoppingList');
  const open = state.shoppingList.filter(s => !s.isCompleted);
  const closed = state.shoppingList.filter(s => s.isCompleted);
  $('uncompletedCount').textContent = open.length;
  $('completedCount').textContent = closed.length;
  un.innerHTML = open.length ? open.map(it => `
    <div class="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100">
      <label class="flex items-center gap-2.5 cursor-pointer">
        <input type="checkbox" data-action="buy-shop" data-id="${esc(it.id)}" class="w-5 h-5 rounded text-brand-500 focus:ring-brand-400">
        <div><span class="text-sm font-bold text-slate-800">${esc(it.title)}</span>
        <span class="text-[10px] text-slate-400 block">${esc(it.requestedBy)}が追加</span></div>
      </label>
      <button data-action="delete-shop" data-id="${esc(it.id)}" class="text-slate-300 hover:text-rose-500 p-1" aria-label="削除"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
    </div>`).join('') : '<div class="py-6 text-center text-xs text-slate-400">現在買うものはありません✨</div>';
  done.innerHTML = closed.map(it => `
    <div class="flex items-center justify-between p-2 rounded-lg bg-slate-50/50 text-slate-400">
      <div class="flex items-center gap-2 line-through text-xs"><i data-lucide="check" class="w-3.5 h-3.5 text-brand-500"></i><span>${esc(it.title)}</span></div>
      <button data-action="delete-shop" data-id="${esc(it.id)}" class="text-slate-300 hover:text-rose-500 p-1" aria-label="削除"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
    </div>`).join('');
}

function renderFixedExpenses() {
  const total = state.fixedExpenses.reduce((s, f) => s + (f.isActive ? Number(f.amount) : 0), 0);
  $('fixedExpensesTotal').textContent = `合計: ${yen(total)}（年間 ${yen(total * 12)}）`;
  $('fixedExpensesList').innerHTML = state.fixedExpenses.map(f => `
    <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-xs">
      <div><span class="font-bold text-slate-800">${esc(f.title)}</span>
      <span class="text-[10px] text-slate-400 block">毎月${esc(f.billingDay)}日引落 (${esc(f.category)})</span></div>
      <div class="text-right"><span class="font-black text-slate-900">${yen(f.amount)}</span>
      <span class="text-[9px] text-purple-600 font-bold block">自動計上</span></div>
    </div>`).join('');
}

function categoryOptionsHtml(selected) {
  return state.categories.map(c => `<option value="${esc(c.name)}"${c.name === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
}

function renderCategoryDropdown() {
  const keepFilter = $('historyCategoryFilter').value;
  $('expenseCategory').innerHTML = categoryOptionsHtml();
  $('receiptCategory').innerHTML = categoryOptionsHtml();
  $('historyCategoryFilter').innerHTML = '<option value="all">全カテゴリ</option>' + categoryOptionsHtml();
  $('historyCategoryFilter').value = state.categories.some(c => c.name === keepFilter) ? keepFilter : 'all';
}

function renderSettings() {
  $('settingBudgetInput').value = state.summary.budget;
  $('settingHusbandBase').value = state.config.husbandBaseContribution;
  $('settingWifeBase').value = state.config.wifeBaseContribution;
  $('privacyMaskToggle').checked = state.privacyMask;
  $('settingGasUrl').value = state.gasApiUrl;
}

// ==========================================
// 変更履歴
// ==========================================
function formatValue(key, v) {
  if (key === 'amount' || key === 'husband' || key === 'wife' || key === 'total') return yen(v);
  if (key === 'isShared') return v ? '共同' : '私物';
  if (key === 'isPaid') return v ? '振込済' : '未完了';
  if (key === 'isActive') return v ? '有効' : '無効';
  if (key === 'billingDay') return `毎月${v}日`;
  if (key === 'paymentType') return PAYMENT_LABELS[v] || v;
  return v === '' || v === undefined || v === null ? '（空）' : String(v);
}

function isMaskedAuditEntry(before, after, log) {
  if (!state.privacyMask) return false;
  const obj = after || before || {};
  const isShared = obj.isShared !== undefined ? obj.isShared : (before && before.isShared);
  const owner = obj.payer || (before && before.payer) || (log && log.actor);
  return isShared === false && Boolean(owner) && owner !== state.currentUser;
}

function diffText(before, after, log) {
  const masked = isMaskedAuditEntry(before, after, log);
  const maskLabel = '🔒 私物支出 (マスキング中)';
  if (!before && after) {
    if (after.role) return `登録: ${esc(after.role)}`;
    if (after.husband !== undefined) return `夫: ${yen(after.husband)} / 妻: ${yen(after.wife)}`;
    const name = masked ? maskLabel : (after.title || after.store || after.name || after.keyword || '');
    const amt = after.amount !== undefined ? yen(after.amount) : (after.total !== undefined ? yen(after.total) : '');
    return `追加: ${esc(name)} ${amt}`.trim();
  }
  if (before && !after) {
    const name = masked ? maskLabel : (before.title || before.store || '');
    const amt = before.amount !== undefined ? yen(before.amount) : '';
    const itemSummary = !masked && Array.isArray(before.items) && before.items.length
      ? `（明細: ${before.items.map(it => `${esc(it.name)} ${yen(it.price)}`).join('、')}）`
      : '';
    return `削除: ${esc(name)} ${amt}（${esc(before.date || '')}）${itemSummary}`;
  }
  const parts = [];
  Object.keys(after || {}).forEach(k => {
    if (before && before[k] !== after[k] && FIELD_LABELS[k]) {
      const bVal = masked && (k === 'title' || k === 'store') ? maskLabel : formatValue(k, before[k]);
      const aVal = masked && (k === 'title' || k === 'store') ? maskLabel : formatValue(k, after[k]);
      parts.push(`${FIELD_LABELS[k]}: ${esc(bVal)} → <b>${esc(aVal)}</b>`);
    }
  });
  return parts.length ? parts.join('<br>') : '内容の変更なし';
}

function auditRowHtml(log) {
  const tone = log.action === '削除' ? 'text-rose-600' : log.action === '更新' ? 'text-amber-600' : 'text-emerald-600';
  return `<div class="py-2">
    <div class="flex items-center justify-between text-[11px]">
      <span class="font-bold ${tone}">${esc(log.action)}・${esc(log.targetType)}</span>
      <span class="text-slate-400">${esc(shortDateTime(log.at))}</span></div>
    <div class="text-[11px] text-slate-500">操作者: <b>${esc(log.actor)}</b>${log.verified ? '' : '（デモ）'}</div>
    <div class="text-[11px] text-slate-700 mt-0.5 leading-relaxed">${diffText(log.before, log.after, log)}</div></div>`;
}

async function loadAuditLog() {
  const box = $('auditLogList');
  box.innerHTML = '<div class="py-3 text-center text-xs text-slate-400">読み込み中…</div>';
  const res = await api('getAuditLog', { limit: 50 });
  if (!res.success) { box.innerHTML = ''; handleApiError(res); return; }
  box.innerHTML = res.logs.length ? res.logs.map(auditRowHtml).join('') : '<div class="py-3 text-center text-xs text-slate-400">履歴はまだありません</div>';
}

async function openTxHistory(id) {
  const tx = state.transactions.find(t => t.id === id);
  const masked = tx && !tx.isShared && state.privacyMask && tx.payer !== state.currentUser;
  $('auditDetailTitle').textContent = `変更履歴: ${tx ? (masked ? '🔒 私物支出 (マスキング中)' : tx.title) : ''}`;
  $('auditDetailBody').innerHTML = '<div class="py-4 text-center text-slate-400">読み込み中…</div>';
  $('auditDetailModal').classList.remove('hidden');
  const res = await api('getAuditLog', { targetId: id, limit: 50 });
  if (!res.success) { $('auditDetailModal').classList.add('hidden'); handleApiError(res); return; }
  const created = tx ? `<div class="py-2 text-[11px] text-slate-500">現在の登録者: <b>${esc(tx.createdBy)}</b>（${esc(shortDateTime(tx.createdAt))}）</div>` : '';
  $('auditDetailBody').innerHTML = created + (res.logs.length ? res.logs.map(auditRowHtml).join('') : '<div class="py-4 text-center text-slate-400">記録なし</div>');
  lucide.createIcons();
}

// ==========================================
// 価格検索
// ==========================================
async function handlePriceSearch(e) {
  e.preventDefault();
  const q = $('priceSearchInput').value.trim();
  if (!q) return;
  const box = $('priceSearchResult');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="text-xs text-slate-400 text-center py-2">検索中…</div>';
  const res = await api('searchPrices', { query: q });
  if (!res.success) { box.classList.add('hidden'); handleApiError(res); return; }
  if (!res.count) {
    box.innerHTML = `<div class="text-xs text-slate-400 text-center py-2">「${esc(q)}」の購入履歴はまだありません。レシートを読み取ると記録されます📷</div>`;
    return;
  }
  const s = res.stats;
  const chip = (label, v, tone) => `<div class="flex-1 text-center rounded-lg ${tone} py-1.5"><div class="text-[10px]">${label}</div><div class="text-sm font-black">${yen(v)}</div></div>`;
  box.innerHTML = `
    <div class="text-[11px] text-slate-500 mb-1.5">「${esc(res.query)}」 ${res.count}件の履歴（単価）</div>
    <div class="flex gap-1.5 mb-2">${chip('直近', s.latest, 'bg-slate-100 text-slate-700')}${chip('最安', s.min, 'bg-emerald-50 text-emerald-700')}
      ${chip('平均', s.avg, 'bg-slate-100 text-slate-700')}${chip('最高', s.max, 'bg-rose-50 text-rose-700')}</div>
    <div class="text-[11px] font-bold text-slate-600 mb-1">お店別（最安順）</div>
    <div class="space-y-0.5 mb-2">${res.byStore.map(b => `<div class="flex justify-between text-xs"><span>${esc(b.store)} <span class="text-slate-400">(${b.count}回)</span></span><span class="font-bold">最安 ${yen(b.min)} / 直近 ${yen(b.latest)}</span></div>`).join('')}</div>
    <div class="text-[11px] font-bold text-slate-600 mb-1">履歴</div>
    <div class="divide-y divide-slate-100 max-h-48 overflow-y-auto">${res.history.slice(0, 30).map(h => `<div class="flex justify-between py-1 text-xs"><span class="text-slate-500">${esc(h.date)} ${esc(h.store)}<br><span class="text-slate-800">${esc(h.name)}${h.quantity > 1 ? ` ×${h.quantity}` : ''}</span></span><span class="font-bold self-center">${yen(h.unitPrice)}</span></div>`).join('')}</div>`;
}

// ==========================================
// レシートAI-OCR
// ==========================================
function resizeImageToBase64(file, maxSide = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}

function receiptRowHtml(it) {
  return `<div class="flex gap-1.5 items-center" data-row>
    <input type="text" class="rc-name flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs" value="${esc(it.name)}" maxlength="50" aria-label="品名">
    <input type="number" class="rc-qty w-12 bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-xs text-center" value="${esc(it.quantity)}" min="1" max="99" inputmode="numeric" aria-label="数量">
    <input type="number" class="rc-price w-20 bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-xs text-right" value="${esc(it.price)}" inputmode="numeric" aria-label="金額">
    <button type="button" data-action="remove-receipt-row" class="p-1 text-slate-300 hover:text-rose-500" aria-label="行を削除"><i data-lucide="x" class="w-4 h-4"></i></button></div>`;
}

function collectReceiptRows() {
  return Array.from(document.querySelectorAll('#receiptItemRows [data-row]')).map(row => ({
    name: row.querySelector('.rc-name').value.trim(),
    quantity: parseInt(row.querySelector('.rc-qty').value, 10),
    price: parseInt(row.querySelector('.rc-price').value, 10)
  }));
}

let scannedTotal = 0;
function updateReceiptTotal() {
  const sum = collectReceiptRows().reduce((s, r) => s + (Number.isInteger(r.price) ? r.price : 0), 0);
  $('receiptTotal').textContent = yen(sum);
  const diff = scannedTotal ? sum - scannedTotal : 0;
  const diffNote = $('receiptDiffNote');
  if (diff !== 0) {
    diffNote.textContent = `⚠ レシート印字の合計 ${yen(scannedTotal)} と ${yen(Math.abs(diff))} 違います`;
    diffNote.className = 'text-xs font-bold text-rose-600';
    $('receiptSaveBtn').textContent = '差額があります。このまま保存';
  } else {
    diffNote.textContent = '';
    $('receiptSaveBtn').textContent = 'この内容で保存する';
  }
}

function guessCategoryByStore(store) {
  const hit = state.rules.find(r => store.includes(r.keyword));
  return hit && state.categories.some(c => c.name === hit.category) ? hit.category : (state.categories.some(c => c.name === '食費') ? '食費' : (state.categories[0] || {}).name);
}

async function handleReceiptFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { showToast('画像ファイルを選んでください'); return; }
  // 初回のみ：画像の送信先についての同意を取る
  if (!state.isMockMode && localStorage.getItem('pairbudget_ocr_consent') !== 'true') {
    const ok = window.confirm('レシート画像は、読み取りのためGoogleのAI（Gemini）に送信されます。\n・当アプリのサーバーには保存されません\n・無料枠では、送信内容がGoogleのサービス改善に使われる場合があります\n・カード番号や氏名が写らないようにしてください\n\n同意して続けますか？');
    if (!ok) { $('receiptFileInput').value = ''; return; }
    localStorage.setItem('pairbudget_ocr_consent', 'true');
  }
  closeExpenseModal();
  $('receiptModal').classList.remove('hidden');
  $('receiptForm').classList.add('hidden');
  $('receiptLoading').classList.remove('hidden');
  try {
    const imageBase64 = await resizeImageToBase64(file);
    const res = await api('scanReceipt', { imageBase64, mimeType: 'image/jpeg' });
    if (!res.success) { closeReceiptModal(); handleApiError(res); return; }
    fillReceiptForm(res.receipt);
  } catch (err) {
    closeReceiptModal();
    showToast(err.message || 'レシートの読み取りに失敗しました');
  }
}

function fillReceiptForm(r) {
  scannedTotal = r.total || 0;
  $('receiptStore').value = r.store || '';
  $('receiptDate').value = r.date || localDateStr();
  $('receiptCategory').innerHTML = categoryOptionsHtml(guessCategoryByStore(r.store || ''));
  $('receiptIsShared').value = 'true';
  $('receiptPaymentType').value = 'shared_card';
  $('receiptPayer').value = state.currentUser === '妻' ? '妻' : '夫';
  const items = r.items && r.items.length ? r.items : [{ name: '', quantity: 1, price: 0 }];
  $('receiptItemRows').innerHTML =
    '<div class="flex gap-1.5 text-[10px] text-slate-400 px-0.5"><span class="flex-1">品名</span><span class="w-12 text-center">数量</span><span class="w-20 text-right">金額(行合計)</span><span class="w-6"></span></div>' +
    items.map(receiptRowHtml).join('');
  $('receiptLoading').classList.add('hidden');
  $('receiptForm').classList.remove('hidden');
  updateReceiptTotal();
  lucide.createIcons();
}

function closeReceiptModal() {
  $('receiptModal').classList.add('hidden');
  $('receiptFileInput').value = '';
}

async function handleReceiptSubmit(e) {
  e.preventDefault();
  const items = collectReceiptRows();
  if (items.some(r => !r.name)) { showToast('品名が空の行があります'); return; }
  if (items.some(r => !Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > 99)) { showToast('数量は1〜99で入力してください'); return; }
  if (items.some(r => !Number.isInteger(r.price) || r.price === 0)) { showToast('金額が空または0の行があります'); return; }
  if (items.reduce((s, r) => s + r.price, 0) <= 0) { showToast('合計金額が0円以下です'); return; }

  const btn = $('receiptSaveBtn');
  btn.disabled = true;
  const res = await writeAndRefresh('saveReceipt', {
    store: $('receiptStore').value.trim(), date: $('receiptDate').value, category: $('receiptCategory').value,
    isShared: $('receiptIsShared').value === 'true', paymentType: $('receiptPaymentType').value,
    payer: $('receiptPayer').value, items
  }, 'レシートを保存しました（明細も記録）');
  btn.disabled = false;
  if (res.success) closeReceiptModal();
}

// ==========================================
// 支出の登録・編集・削除
// ==========================================
function openExpenseModal(editItem) {
  $('expenseForm').reset();
  $('expenseDate').value = localDateStr();
  const del = $('expenseDeleteBtn');
  const lockNote = $('expenseLockNote');
  if (editItem) {
    $('expenseModalTitle').textContent = '支出を編集';
    $('expenseId').value = editItem.id;
    $('expenseAmount').value = editItem.amount;
    $('expenseTitle').value = editItem.title;
    if (editItem.category && !Array.from($('expenseCategory').options).some(o => o.value === editItem.category)) {
      $('expenseCategory').insertAdjacentHTML('beforeend', `<option value="${esc(editItem.category)}">${esc(editItem.category)}</option>`);
    }
    $('expenseCategory').value = editItem.category;
    $('expensePaymentType').value = editItem.paymentType;
    $('expenseDate').value = editItem.date;
    document.querySelector(`input[name="expenseIsShared"][value="${editItem.isShared}"]`).checked = true;
    const payerRadio = document.querySelector(`input[name="expensePayer"][value="${editItem.payer}"]`);
    if (payerRadio) payerRadio.checked = true;
    const locked = !!editItem.receiptId;
    $('expenseAmount').disabled = locked;
    $('expenseTitle').disabled = locked;
    lockNote.classList.toggle('hidden', !locked);
    del.classList.remove('hidden');
    $('scanReceiptLabel').classList.add('hidden');
  } else {
    $('expenseModalTitle').textContent = '支出を記録';
    $('expenseId').value = '';
    $('expenseAmount').disabled = false;
    $('expenseTitle').disabled = false;
    lockNote.classList.add('hidden');
    del.classList.add('hidden');
    $('scanReceiptLabel').classList.remove('hidden');
    const payerRadio = document.querySelector(`input[name="expensePayer"][value="${state.currentUser}"]`);
    if (payerRadio) payerRadio.checked = true;
  }
  $('expenseModal').classList.remove('hidden');
  lucide.createIcons();
}

function closeExpenseModal() { $('expenseModal').classList.add('hidden'); }
window.closeExpenseModal = closeExpenseModal;

async function handleExpenseSubmit(e) {
  e.preventDefault();
  const id = $('expenseId').value;
  const amount = parseInt($('expenseAmount').value, 10);
  if (!Number.isInteger(amount) || amount <= 0) { showToast('1円以上の金額を入力してください'); return; }
  const title = $('expenseTitle').value.trim();
  if (!title) { showToast('品名を入力してください'); return; }
  const payload = {
    id, date: $('expenseDate').value || localDateStr(), title, amount,
    category: $('expenseCategory').value,
    isShared: document.querySelector('input[name="expenseIsShared"]:checked').value === 'true',
    paymentType: $('expensePaymentType').value,
    payer: document.querySelector('input[name="expensePayer"]:checked').value,
    memo: ''
  };
  const existing = id ? state.transactions.find(t => t.id === id) : null;
  if (existing) payload.memo = existing.memo;
  const res = await writeAndRefresh(id ? 'updateTransaction' : 'addTransaction', payload, id ? '支出を更新しました（履歴に記録）' : '支出を記録しました');
  if (res.success) closeExpenseModal();
}

async function handleExpenseDelete() {
  const id = $('expenseId').value;
  const tx = state.transactions.find(t => t.id === id);
  if (!tx) return;
  if (!window.confirm(`「${tx.title}」${yen(tx.amount)} を削除しますか？\n（削除の記録は変更履歴に残ります）`)) return;
  const res = await writeAndRefresh('deleteTransaction', { id }, '削除しました（履歴に記録）');
  if (res.success) closeExpenseModal();
}

// ==========================================
// 買い物リスト
// ==========================================
async function handleAddShoppingSubmit(e) {
  e.preventDefault();
  const input = $('shoppingInput');
  const title = input.value.trim();
  if (!title) return;
  const item = { id: 's_' + Date.now(), title, category: '日用品', isCompleted: false, requestedBy: state.currentUser, createdAt: localDateStr() };
  state.shoppingList.unshift(item);
  input.value = '';
  renderShoppingList();
  lucide.createIcons();
  showToast('買い物リストに追加しました');
  const res = await api('addShoppingItem', { title, category: '日用品' });
  if (!res.success) { handleApiError(res); await loadInitialData(); }
  else if (!state.isMockMode) loadInitialData(); // サーバー側のIDに同期
}

function openBuySyncModal(id) {
  const item = state.shoppingList.find(s => s.id === id);
  if (!item) return;
  $('buySyncItemId').value = id;
  $('buySyncTitle').textContent = item.title;
  $('buySyncAmount').value = '';
  $('buySyncModal').classList.remove('hidden');
  lucide.createIcons();
}

async function completeShoppingItem(id) {
  const item = state.shoppingList.find(s => s.id === id);
  if (!item) return;
  item.isCompleted = true;
  renderShoppingList();
  lucide.createIcons();
  const res = await api('updateShoppingItem', { id, title: item.title, category: item.category, isCompleted: true });
  if (!res.success) { handleApiError(res); await loadInitialData(); }
}

window.skipBuySync = function () {
  const id = $('buySyncItemId').value;
  $('buySyncModal').classList.add('hidden');
  completeShoppingItem(id);
};

async function handleBuySyncSubmit(e) {
  e.preventDefault();
  const id = $('buySyncItemId').value;
  const item = state.shoppingList.find(s => s.id === id);
  if (!item) return;
  const amount = parseInt($('buySyncAmount').value, 10);
  if (!Number.isInteger(amount) || amount <= 0) { showToast('1円以上の金額を入力してください'); return; }

  const res = await writeAndRefresh('addTransaction', {
    date: localDateStr(), title: item.title, amount, category: item.category || '食費', isShared: true,
    paymentType: $('buySyncPaymentType').value, payer: state.currentUser, memo: '買い物リストから連動登録'
  }, '買い物完了＆支出に登録しました！');
  if (res.success) {
    $('buySyncModal').classList.add('hidden');
    await completeShoppingItem(id);
  }
}

async function deleteShoppingItemById(id) {
  state.shoppingList = state.shoppingList.filter(s => s.id !== id);
  renderShoppingList();
  lucide.createIcons();
  showToast('アイテムを削除しました');
  const res = await api('deleteShoppingItem', { id });
  if (!res.success) { handleApiError(res); await loadInitialData(); }
}

// ==========================================
// 設定
// ==========================================
async function handleSaveBudget() {
  const val = parseInt($('settingBudgetInput').value, 10);
  if (!Number.isInteger(val) || val <= 0) { showToast('有効な予算額を入力してください'); return; }
  await writeAndRefresh('updateMonthlyBudget', { month: state.viewMonth, amount: val, note: '' }, `${state.viewMonth.replace('-', '年')}月の予算を保存しました`);
}

async function handleBaseChange() {
  const husband = parseInt($('settingHusbandBase').value, 10);
  const wife = parseInt($('settingWifeBase').value, 10);
  if (!Number.isInteger(husband) || !Number.isInteger(wife) || husband < 0 || wife < 0) { showToast('基本拠出額を正しく入力してください'); return; }
  await writeAndRefresh('updateBaseContribution', { husband, wife }, '基本拠出額を保存しました（履歴に記録）');
}

async function toggleTransferStatus(payer) {
  const t = payer === '夫' ? state.transfers.husband : state.transfers.wife;
  await writeAndRefresh('updateTransferStatus', { month: state.viewMonth, payer, isPaid: !t.isPaid }, `${payer}の振込ステータスを更新しました`);
}

// ==========================================
// イベント・初期化
// ==========================================
function setScope(scope) {
  state.activeScope = scope;
  const on = 'px-3 py-1.5 rounded-lg bg-white text-brand-700 shadow-sm transition-all flex items-center gap-1';
  const off = 'px-3 py-1.5 rounded-lg text-slate-500 transition-all flex items-center gap-1 hover:text-slate-800';
  $('scopeSharedBtn').className = scope === 'shared' ? on : off;
  $('scopePersonalBtn').className = scope === 'personal' ? on : off;
  renderCharts();
  renderRecentTransactions();
  renderHistoryList();
  lucide.createIcons();
}

window.switchTab = function (tabName) {
  ['home', 'shopping', 'history', 'settings'].forEach(t => {
    const cap = t.charAt(0).toUpperCase() + t.slice(1);
    $(`tabContent${cap}`).classList.toggle('hidden', t !== tabName);
    $(`nav${cap}Btn`).className = `py-1 ${t === tabName ? 'text-brand-600' : 'text-slate-400'} flex flex-col items-center justify-center gap-0.5`;
  });
  if (tabName === 'home') renderCharts(); // 非表示中に描画したグラフのサイズ崩れを防ぐ
  lucide.createIcons();
};

function showToast(msg) {
  const toast = $('toast');
  $('toastMessage').textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

function setupEventListeners() {
  $('scopeSharedBtn').addEventListener('click', () => setScope('shared'));
  $('scopePersonalBtn').addEventListener('click', () => setScope('personal'));
  $('prevMonthBtn').addEventListener('click', () => loadInitialData(shiftMonth(state.viewMonth, -1)));
  $('nextMonthBtn').addEventListener('click', () => loadInitialData(shiftMonth(state.viewMonth, 1)));

  $('transferHelpBtn').addEventListener('click', () => $('transferHelpModal').classList.remove('hidden'));
  $('husbandPayToggle').addEventListener('click', () => toggleTransferStatus('夫'));
  $('wifePayToggle').addEventListener('click', () => toggleTransferStatus('妻'));

  $('openExpenseModalBtn').addEventListener('click', () => openExpenseModal(null));
  $('expenseForm').addEventListener('submit', handleExpenseSubmit);
  $('expenseDeleteBtn').addEventListener('click', handleExpenseDelete);
  $('receiptFileInput').addEventListener('change', e => handleReceiptFile(e.target.files[0]));

  $('receiptForm').addEventListener('submit', handleReceiptSubmit);
  $('receiptCloseBtn').addEventListener('click', closeReceiptModal);
  $('receiptAddRowBtn').addEventListener('click', () => {
    $('receiptItemRows').insertAdjacentHTML('beforeend', receiptRowHtml({ name: '', quantity: 1, price: '' }));
    lucide.createIcons();
  });
  $('receiptItemRows').addEventListener('input', updateReceiptTotal);

  $('addShoppingForm').addEventListener('submit', handleAddShoppingSubmit);
  $('buySyncForm').addEventListener('submit', handleBuySyncSubmit);

  $('historyCategoryFilter').addEventListener('change', renderHistoryList);
  $('historyPayerFilter').addEventListener('change', renderHistoryList);
  $('priceSearchForm').addEventListener('submit', handlePriceSearch);
  $('loadAuditBtn').addEventListener('click', loadAuditLog);
  $('auditDetailCloseBtn').addEventListener('click', () => $('auditDetailModal').classList.add('hidden'));

  $('trendRangeButtons').addEventListener('click', e => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    state.trendRange = Number(btn.dataset.range);
    $('trendRangeButtons').querySelectorAll('button').forEach(b => {
      b.className = 'px-2 py-1 rounded-md ' + (b === btn ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500');
    });
    renderTrendChart();
  });

  $('saveBudgetBtn').addEventListener('click', handleSaveBudget);
  $('settingHusbandBase').addEventListener('change', handleBaseChange);
  $('settingWifeBase').addEventListener('change', handleBaseChange);
  $('privacyMaskToggle').addEventListener('change', e => {
    state.privacyMask = e.target.checked;
    localStorage.setItem('pairbudget_privacy_mask', state.privacyMask);
    renderRecentTransactions();
    renderHistoryList();
    if ($('auditLogList').children.length > 1) loadAuditLog();
    lucide.createIcons();
    showToast('プライバシー設定を更新しました');
  });
  $('registerHusbandBtn').addEventListener('click', () => submitRegisterMember('夫'));
  $('registerWifeBtn').addEventListener('click', () => submitRegisterMember('妻'));
  $('saveGasUrlBtn').addEventListener('click', () => {
    state.gasApiUrl = $('settingGasUrl').value.trim();
    localStorage.setItem('pairbudget_gas_url', state.gasApiUrl);
    showToast('API URLを保存しました');
    loadInitialData();
  });

  // 動的に生成された要素のクリック・変更はイベント委譲で処理（品名などをHTML属性に埋め込まない）
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const id = el.dataset.id;
    switch (el.dataset.action) {
      case 'edit-tx': { const tx = state.transactions.find(t => t.id === id); if (tx) openExpenseModal(tx); break; }
      case 'tx-history': e.preventDefault(); openTxHistory(id); break;
      case 'delete-shop': deleteShoppingItemById(id); break;
      case 'remove-receipt-row': el.closest('[data-row]').remove(); updateReceiptTotal(); break;
    }
  });
  document.addEventListener('change', e => {
    const el = e.target.closest('[data-action="buy-shop"]');
    if (el && el.checked) { el.checked = false; openBuySyncModal(el.dataset.id); }
  });
}

async function initLiff() {
  if (!APP_CONFIG.LIFF_ID || typeof liff === 'undefined') return;
  try {
    await liff.init({ liffId: APP_CONFIG.LIFF_ID });
    if (!liff.isLoggedIn()) { liff.login(); return 'redirect'; }
    state.liffReady = true;
  } catch (err) {
    console.warn('LIFF初期化エラー:', err);
    showToast('LINEログインの初期化に失敗しました');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  lucide.createIcons();
  setupEventListeners();
  if ((await initLiff()) === 'redirect') return;
  await loadInitialData();
});
