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
const FRONTEND_VERSION = 'v2.2.0';
const MAX_HISTORY_MONTHS = 36;
const FIELD_LABELS = {
  date: '日付', title: '品名', amount: '金額', category: 'カテゴリ', isShared: '共同',
  paymentType: '決済手段', payer: '支払者', memo: 'メモ',
  husband: 'メンバー1基本拠出', wife: 'メンバー2基本拠出', husbandName: 'メンバー1表示名', wifeName: 'メンバー2表示名',
  isPaid: '振込状況', billingDay: '引落日', isActive: '有効', keyword: 'キーワード', color: 'カラー', role: '表示名',
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
  currentMode: 'budget', // 'budget' | 'events'
  pairId: localStorage.getItem('pairbudget_pair_id') || '00000000-0000-0000-0000-000000000001',
  pairName: localStorage.getItem('pairbudget_pair_name') || '世帯ペア',
  inviteCode: localStorage.getItem('pairbudget_invite_code') || '',
  events: [],
  activeEventId: null,
  currentSettlement: null,
  currentUser: 'メンバー1',
  currentSlot: 'husband',
  liffDisplayName: '',
  actorVerified: false,
  isMockMode: false,
  liffReady: false,
  privacyMask: localStorage.getItem('pairbudget_privacy_mask') === 'true',
  gasApiUrl: APP_CONFIG.API_URL || localStorage.getItem('pairbudget_api_url') || '/api/budget',
  trendRange: 12,
  categoryChart: null,
  trendChart: null,
  busy: false,

  summary: { budget: 240000, totalExpense: 0, remaining: 240000, progressRate: 0, daysLeft: 0, dailyAllowance: 0, isCurrentMonth: true },
  transfers: {
    husband: { baseContribution: 60000, privateOnSharedCard: 0, advancedForShared: 0, totalTransfer: 60000, isPaid: false },
    wife: { baseContribution: 60000, privateOnSharedCard: 0, advancedForShared: 0, totalTransfer: 60000, isPaid: false }
  },
  config: {
    husbandBaseContribution: 60000,
    wifeBaseContribution: 60000,
    husbandName: 'メンバー1',
    wifeName: 'メンバー2',
    husbandColor: localStorage.getItem('pairbudget_member1_color') || 'emerald',
    wifeColor: localStorage.getItem('pairbudget_member2_color') || 'amber'
  },
  members: [], // マルチメンバー（ふたり〜シェアハウス対応）
  transactions: [],
  receiptItems: [],
  monthlyTotals: [],
  shoppingList: [],
  fixedExpenses: [],
  categories: [],
  rules: []
};

// ==========================================
// ジェンダーフリー・カラーパレット (8色)
// ==========================================
const MEMBER_COLOR_PALETTE = {
  emerald: { key: 'emerald', name: 'エメラルド', hex: '#10b981', bgHex: '#10b98118', borderHex: '#10b98140' },
  indigo:  { key: 'indigo',  name: 'インディゴ', hex: '#6366f1', bgHex: '#6366f118', borderHex: '#6366f140' },
  amber:   { key: 'amber',   name: 'アンバー',   hex: '#f59e0b', bgHex: '#f59e0b18', borderHex: '#f59e0b40' },
  rose:    { key: 'rose',    name: 'ローズ',     hex: '#f43f5e', bgHex: '#f43f5e18', borderHex: '#f43f5e40' },
  violet:  { key: 'violet',  name: 'バイオレット', hex: '#8b5cf6', bgHex: '#8b5cf618', borderHex: '#8b5cf640' },
  teal:    { key: 'teal',    name: 'ティール',   hex: '#14b8a6', bgHex: '#14b8a618', borderHex: '#14b8a640' },
  sky:     { key: 'sky',     name: 'スカイ',     hex: '#0ea5e9', bgHex: '#0ea5e918', borderHex: '#0ea5e940' },
  orange:  { key: 'orange',  name: 'オレンジ',   hex: '#f97316', bgHex: '#f9731618', borderHex: '#f9731640' }
};

// ==========================================
// マルチメンバー（シェアハウス対応）状態管理
// ==========================================
function initMembers() {
  const saved = localStorage.getItem('pairbudget_members');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length >= 1) {
        state.members = parsed;
        syncStateConfigFromMembers();
        return;
      }
    } catch (_) {}
  }

  // 初期デフォルト2人（後方互換）
  state.members = [
    {
      id: 'm1',
      name: state.config.husbandName || 'メンバー1',
      slot: 'husband',
      color: state.config.husbandColor || localStorage.getItem('pairbudget_member1_color') || 'emerald',
      baseContribution: Number(state.config.husbandBaseContribution) || 60000,
      isPaid: !!state.transfers.husband?.isPaid
    },
    {
      id: 'm2',
      name: state.config.wifeName || 'メンバー2',
      slot: 'wife',
      color: state.config.wifeColor || localStorage.getItem('pairbudget_member2_color') || 'amber',
      baseContribution: Number(state.config.wifeBaseContribution) || 60000,
      isPaid: !!state.transfers.wife?.isPaid
    }
  ];
  syncStateConfigFromMembers();
}
initMembers();

function syncStateConfigFromMembers() {
  if (!state.members || !state.members.length) return;
  state.config.husbandName = state.members[0]?.name || 'メンバー1';
  state.config.husbandColor = state.members[0]?.color || 'emerald';
  state.config.husbandBaseContribution = state.members[0]?.baseContribution || 60000;

  if (state.members.length > 1) {
    state.config.wifeName = state.members[1]?.name || 'メンバー2';
    state.config.wifeColor = state.members[1]?.color || 'amber';
    state.config.wifeBaseContribution = state.members[1]?.baseContribution || 60000;
  }
}

function saveMembersToStorage() {
  try {
    localStorage.setItem('pairbudget_members', JSON.stringify(state.members));
    if (state.members[0]) {
      localStorage.setItem('pairbudget_member1_color', state.members[0].color);
    }
    if (state.members[1]) {
      localStorage.setItem('pairbudget_member2_color', state.members[1].color);
    }
  } catch (_) {}
}

function getMemberColor(slotOrName) {
  if (!slotOrName) return MEMBER_COLOR_PALETTE.emerald;
  const target = String(slotOrName).trim();
  const found = (state.members || []).find(m => m.id === target || m.slot === target || m.name === target);
  if (found && found.color && MEMBER_COLOR_PALETTE[found.color]) {
    return MEMBER_COLOR_PALETTE[found.color];
  }
  if (target === 'husband') return MEMBER_COLOR_PALETTE[state.config.husbandColor] || MEMBER_COLOR_PALETTE.emerald;
  if (target === 'wife') return MEMBER_COLOR_PALETTE[state.config.wifeColor] || MEMBER_COLOR_PALETTE.amber;
  return MEMBER_COLOR_PALETTE.emerald;
}

function applyMemberColors() {
  renderTransferCard();
  updatePayerDropdowns();
}

// 支出モーダルの支払者動的チップ描画
let currentSelectedExpensePayer = 'メンバー1';
function renderExpensePayerChips(selectedPayer = null) {
  const container = $('expensePayerContainer');
  if (!container) return;
  if (selectedPayer) currentSelectedExpensePayer = selectedPayer;

  container.innerHTML = '';
  const options = [...(state.members || []).map(m => ({ label: m.name, value: m.name, color: getMemberColor(m.color) })), { label: '共同', value: '共同', color: { hex: '#10b981', bgHex: '#10b98118' } }];

  options.forEach(opt => {
    const isSelected = opt.value === currentSelectedExpensePayer;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `px-3 py-1.5 rounded-xl text-xs font-bold transition-all border flex items-center gap-1.5 ${
      isSelected ? 'shadow-sm scale-102' : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
    }`;
    if (isSelected) {
      btn.style.backgroundColor = opt.color.hex;
      btn.style.borderColor = opt.color.hex;
      btn.style.color = '#ffffff';
    }
    btn.innerHTML = `<span class="w-2 h-2 rounded-full ${isSelected ? 'bg-white' : ''}" style="${!isSelected ? `background-color: ${opt.color.hex}` : ''}"></span> ${esc(opt.label)}`;
    btn.onclick = () => {
      currentSelectedExpensePayer = opt.value;
      renderExpensePayerChips(opt.value);
    };
    container.appendChild(btn);
  });
}

// ドロップダウン（レシートモーダル＆履歴フィルタ）を動的メンバーに更新
function updatePayerDropdowns() {
  const receiptSelect = $('receiptPayer');
  if (receiptSelect) {
    const prev = receiptSelect.value;
    receiptSelect.innerHTML = (state.members || []).map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('') + '<option value="共同">共同</option>';
    if (prev) receiptSelect.value = prev;
  }

  const historyFilter = $('historyPayerFilter');
  if (historyFilter) {
    const prev = historyFilter.value;
    historyFilter.innerHTML = '<option value="all">全メンバー</option>' + (state.members || []).map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('') + '<option value="共同">共同</option>';
    if (prev) historyFilter.value = prev;
  }
}

// 設定タブのメンバー管理カード一覧を描画
function renderSettingMembersList() {
  const container = $('settingMembersList');
  if (!container) return;
  container.innerHTML = '';

  (state.members || []).forEach((member, idx) => {
    const mColor = getMemberColor(member.color);
    const card = document.createElement('div');
    card.className = 'p-3 rounded-xl bg-slate-50 border transition-all space-y-2';
    card.style.borderColor = `${mColor.hex}50`;
    card.style.backgroundColor = `${mColor.hex}08`;

    // カラーサークル一覧
    const colorButtonsHtml = Object.values(MEMBER_COLOR_PALETTE).map(col => {
      const isSelected = col.key === member.color;
      return `<button type="button" data-member-idx="${idx}" data-color-key="${col.key}" title="${col.name}" class="w-6 h-6 rounded-full transition-transform active:scale-95 flex items-center justify-center text-white text-[10px] font-black ${
        isSelected ? 'ring-2 ring-offset-2 ring-slate-800 scale-110 shadow-sm' : 'opacity-85 hover:opacity-100 hover:scale-105'
      }" style="background-color: ${col.hex}">${isSelected ? '✓' : ''}</button>`;
    }).join('');

    card.innerHTML = `
      <div class="flex items-center justify-between pb-1">
        <span class="text-xs font-bold flex items-center gap-1.5" style="color: ${mColor.hex}">
          <span class="w-2.5 h-2.5 rounded-full" style="background-color: ${mColor.hex}"></span>
          メンバー ${idx + 1}
        </span>
        ${state.members.length > 2 ? `<button type="button" data-action="remove-member" data-id="${member.id}" class="text-rose-500 hover:text-rose-700 text-xs font-bold p-1 flex items-center gap-0.5"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i> 削除</button>` : ''}
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div>
          <label class="text-[10px] font-bold text-slate-500 block mb-0.5">表示名</label>
          <input type="text" data-member-idx="${idx}" data-field="name" maxlength="15" value="${esc(member.name)}"
                 class="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800 focus:outline-none">
        </div>
        <div>
          <label class="text-[10px] font-bold text-slate-500 block mb-0.5">基本拠出額 (円)</label>
          <input type="number" data-member-idx="${idx}" data-field="base" value="${member.baseContribution}"
                 class="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono focus:outline-none">
        </div>
      </div>
      <div>
        <span class="text-[10px] font-bold text-slate-500 block mb-1">テーマカラー</span>
        <div class="flex flex-wrap gap-1.5">${colorButtonsHtml}</div>
      </div>
    `;

    // カラーピッカーイベント
    card.querySelectorAll('button[data-color-key]').forEach(btn => {
      btn.onclick = () => {
        const cKey = btn.dataset.colorKey;
        member.color = cKey;
        saveMembersToStorage();
        syncStateConfigFromMembers();
        renderSettingMembersList();
        renderTransferCard();
        renderExpensePayerChips();
        renderRecentTransactions();
        renderHistoryList();
      };
    });

    // 入力値バインド
    card.querySelectorAll('input[data-field]').forEach(input => {
      input.oninput = () => {
        const field = input.dataset.field;
        if (field === 'name') member.name = input.value.trim() || `メンバー${idx + 1}`;
        if (field === 'base') member.baseContribution = Number(input.value) || 0;
        syncStateConfigFromMembers();
      };
    });

    // 削除ボタン
    const delBtn = card.querySelector('[data-action="remove-member"]');
    if (delBtn) {
      delBtn.onclick = () => removeMemberSlot(member.id);
    }

    container.appendChild(card);
  });
  lucide.createIcons();
}

window.addNewMemberSlot = function () {
  const count = state.members.length + 1;
  const usedColors = state.members.map(m => m.color);
  const nextColor = Object.keys(MEMBER_COLOR_PALETTE).find(c => !usedColors.includes(c)) || 'emerald';

  state.members.push({
    id: 'm_' + Date.now().toString(36),
    name: `メンバー${count}`,
    slot: `slot_${count}`,
    color: nextColor,
    baseContribution: 60000,
    isPaid: false
  });

  saveMembersToStorage();
  syncStateConfigFromMembers();
  renderSettingMembersList();
  renderTransferCard();
  renderExpensePayerChips();
  updatePayerDropdowns();
  showToast(`「メンバー${count}」を追加しました`);
};

window.removeMemberSlot = function (id) {
  if (state.members.length <= 2) {
    showToast('メンバーは最低2名必要です');
    return;
  }
  state.members = state.members.filter(m => m.id !== id);
  saveMembersToStorage();
  syncStateConfigFromMembers();
  renderSettingMembersList();
  renderTransferCard();
  renderExpensePayerChips();
  updatePayerDropdowns();
  showToast('メンバーを削除しました');
};

function memberName(slot) {
  return slot === 'wife' ? (state.config.wifeName || 'メンバー2') : (state.config.husbandName || 'メンバー1');
}

function resolvePayerSlot(payer) {
  const p = String(payer || '').trim();
  if (!p) return null;
  if (p === '共同' || p === 'shared') return 'shared';
  if (p === state.config.husbandName || p === '夫' || p === 'メンバー1' || p === 'husband') return 'husband';
  if (p === state.config.wifeName || p === '妻' || p === 'メンバー2' || p === 'wife') return 'wife';
  return null;
}

function isSameMember(payerA, payerB) {
  const sA = resolvePayerSlot(payerA);
  const sB = resolvePayerSlot(payerB);
  if (sA && sB) return sA === sB;
  return payerA === payerB;
}

function displayPayerName(payer) {
  const slot = resolvePayerSlot(payer);
  if (slot === 'husband') return memberName('husband');
  if (slot === 'wife') return memberName('wife');
  if (slot === 'shared') return '共同';
  return payer || '';
}

// ==========================================
// デモ用モックDB（GAS未設定時のみ使用）
// ==========================================
const mockDb = { transactions: [], receiptItems: [], shopping: [], fixed: [], audit: [], budgets: {}, paid: {}, events: [], eventExpenses: [], seeded: false };
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
  mockDb.fixed = MOCK_FIXED.map(f => ({ ...f }));
  const cur = localMonthStr();
  const rnd = n => ((n * 9301 + 49297) % 233280) / 233280; // 決定的な疑似乱数
  const m1 = (state.members && state.members[0]?.name) || state.config?.husbandName || 'メンバー1';
  const m2 = (state.members && state.members[1]?.name) || state.config?.wifeName || 'メンバー2';

  const addTx = (date, title, amount, category, isShared, paymentType, payer, receiptId = '') => {
    mockDb.transactions.push({
      id: mockId(), date, title, amount, category, isShared, paymentType, payer, memo: '',
      createdBy: payer === m2 ? m2 : m1, createdAt: date + ' 12:00:00', updatedBy: '', updatedAt: '', receiptId
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
    addTx(`${m}-27`, '【固定費】家賃', 110000, '住居費', true, 'shared_card', m1);
    addTx(`${m}-20`, '【固定費】光熱費', 11000 + Math.floor(rnd(i) * 9000), '水道光熱費', true, 'shared_card', m2);
    addTx(`${m}-10`, 'スーパー', 38000 + Math.floor(rnd(i + 7) * 22000), '食費', true, 'shared_card', m2);
    addTx(`${m}-15`, '外食', 8000 + Math.floor(rnd(i + 3) * 14000), '外食', true, 'shared_card', m1);
    addTx(`${m}-18`, '私物', 5000 + Math.floor(rnd(i + 5) * 15000), '趣味・衣服', false, 'shared_card', i % 2 ? m1 : m2);
  }
  addReceipt(`${shiftMonth(cur, -2)}-12`, 'イオン', m2, [['ネギ', 1, 150], ['豆腐', 2, 160], ['牛乳', 1, 208]]);
  addReceipt(`${shiftMonth(cur, -1)}-08`, 'ライフ', m1, [['長ねぎ', 1, 168], ['豆腐', 1, 98], ['卵', 1, 238]]);
  addReceipt(`${cur}-03`, 'イオン', m2, [['ネギ', 1, 198], ['豆腐', 1, 90], ['牛乳', 1, 218], ['卵', 1, 248]]);
  const d = n => `${cur}-${pad2(Math.min(n, 28))}`;
  addTx(d(2), 'ドラッグストア洗剤', 2000, '日用品', true, 'advanced_by_user', m1);
  addTx(d(4), 'スニーカー (私物購入)', 12000, '趣味・衣服', false, 'shared_card', m1);
  addTx(d(5), 'カフェ ランチ', 2400, '外食', true, 'shared_card', m1);
  addTx(d(6), 'ドラッグストア調味料', 5000, '食費', true, 'advanced_by_user', m2);
  mockDb.shopping = [
    { id: 's1', title: '牛乳・低脂肪乳', category: '食費', isCompleted: false, requestedBy: m2, createdAt: d(5) },
    { id: 's2', title: '食器用洗剤詰め替え', category: '日用品', isCompleted: false, requestedBy: m1, createdAt: d(4) }
  ];
  // 編集履歴のデモ（他者が編集した例）
  const demo = mockDb.transactions.find(t => t.title === 'カフェ ランチ');
  if (demo) {
    demo.updatedBy = m2; demo.updatedAt = `${d(7)} 21:30:00`;
    mockDb.audit.push({ at: `${d(7)} 21:30:00`, actor: m2, verified: true, action: '更新', targetType: '支出', targetId: demo.id,
      before: { amount: 2400 }, after: { amount: 2400, memo: 'ふたりで休日ランチ' } });
  }
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

  const acc = { husband: { priv: 0, adv: 0 }, wife: { priv: 0, adv: 0 } };
  txs.forEach(t => {
    const slot = resolvePayerSlot(t.payer);
    if (slot !== 'husband' && slot !== 'wife') return;
    if (!t.isShared && t.paymentType === 'shared_card') acc[slot].priv += t.amount;
    if (t.isShared && t.paymentType === 'advanced_by_user') acc[slot].adv += t.amount;
  });
  const hb = state.config.husbandBaseContribution, wb = state.config.wifeBaseContribution;
  const hName = memberName('husband'), wName = memberName('wife');
  const tr = (base, slot) => ({ baseContribution: base, privateOnSharedCard: acc[slot].priv, advancedForShared: acc[slot].adv,
    totalTransfer: Math.max(0, base + acc[slot].priv - acc[slot].adv), isPaid: !!mockDb.paid[month + slot] });

  const totals = [];
  for (let i = MAX_HISTORY_MONTHS - 1; i >= 0; i--) {
    const mm = shiftMonth(localMonthStr(), -i);
    const row = { month: mm, shared: 0, personal: { husband: 0, wife: 0, [hName]: 0, [wName]: 0 }, budget: mockDb.budgets[mm] || 240000 };
    mockDb.transactions.filter(t => t.date.startsWith(mm)).forEach(t => {
      if (t.isShared) row.shared += t.amount;
      else {
        const slot = resolvePayerSlot(t.payer);
        if (slot === 'husband' || slot === 'wife') {
          row.personal[slot] += t.amount;
          row.personal[memberName(slot)] = row.personal[slot];
        }
      }
    });
    totals.push(row);
  }
  return {
    success: true, month, actor: { name: state.currentUser, slot: state.currentSlot, verified: false }, transactions: txs,
    receiptItems: mockDb.receiptItems.filter(it => it.date.startsWith(month)),
    shoppingList: mockDb.shopping, monthlyBudgets: [], fixedExpenses: mockDb.fixed, categories: MOCK_CATEGORIES, rules: MOCK_RULES,
    config: { husbandBaseContribution: hb, wifeBaseContribution: wb, husbandName: hName, wifeName: wName },
    transfers: { husband: tr(hb, 'husband'), wife: tr(wb, 'wife') },
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
    case 'updateFixedExpense': {
      const id = data.id || mockId();
      const idx = mockDb.fixed.findIndex(f => f.id === id);
      const next = { id, title: data.title, amount: Number(data.amount), category: data.category || 'その他', billingDay: Number(data.billingDay) || 1, isActive: data.isActive !== false };
      if (idx >= 0) {
        mockAudit('更新', '固定費', id, { ...mockDb.fixed[idx] }, next);
        mockDb.fixed[idx] = next;
      } else {
        mockDb.fixed.push(next);
        mockAudit('追加', '固定費', id, null, next);
      }
      return { success: true, id };
    }
    case 'deleteFixedExpense': {
      const idx = mockDb.fixed.findIndex(f => f.id === data.id);
      if (idx < 0) return { success: false, error: '削除対象の固定費が見つかりません' };
      const [removed] = mockDb.fixed.splice(idx, 1);
      mockAudit('削除', '固定費', removed.id, removed, null);
      return { success: true };
    }
    case 'updateTransferStatus': {
      const slot = resolvePayerSlot(data.slot || data.payer) || 'husband';
      const prev = !!mockDb.paid[data.month + slot];
      mockDb.paid[data.month + slot] = data.isPaid;
      mockAudit('更新', '振込状況', `${data.month}:${memberName(slot)}`, { isPaid: prev }, { isPaid: data.isPaid });
      return { success: true };
    }
    case 'updateBaseContribution': {
      const before = {
        husbandName: state.config.husbandName, wifeName: state.config.wifeName,
        husband: state.config.husbandBaseContribution, wife: state.config.wifeBaseContribution
      };
      state.config.husbandBaseContribution = data.husband;
      state.config.wifeBaseContribution = data.wife;
      if (data.husbandName) state.config.husbandName = data.husbandName;
      if (data.wifeName) state.config.wifeName = data.wifeName;
      state.currentUser = memberName(state.currentSlot);
      mockAudit('更新', 'メンバー・基本拠出設定', 'baseContribution', before, {
        husbandName: state.config.husbandName, wifeName: state.config.wifeName, husband: data.husband, wife: data.wife
      });
      return { success: true };
    }
    case 'createPair': {
      const pairId = 'pair_' + Date.now().toString(36);
      const inviteCode = 'PB' + Math.random().toString(36).substring(2, 7).toUpperCase();
      const pairName = data.name || 'ふたりの家計簿';
      const userName = data.userName || 'メンバー1';
      if (state.members && state.members.length > 0) {
        state.members[0].name = userName;
        saveMembersToStorage();
        syncStateConfigFromMembers();
      }
      return {
        success: true,
        pair: { id: pairId, name: pairName, inviteCode }
      };
    }
    case 'joinPair': {
      const pairId = 'pair_' + Date.now().toString(36);
      const inviteCode = data.inviteCode || 'PB7829';
      const pairName = 'ふたりの家計簿';
      const userName = data.name || 'メンバー2';
      if (state.members && state.members.length > 1) {
        state.members[1].name = userName;
        saveMembersToStorage();
        syncStateConfigFromMembers();
      }
      return {
        success: true,
        pair: { id: pairId, name: pairName, inviteCode }
      };
    }
    case 'getEvents': {
      return { success: true, events: mockDb.events || [] };
    }
    case 'createEvent': {
      const evId = 'ev_' + Date.now().toString(36);
      const newEv = {
        id: evId,
        title: data.title || '旅行・イベント',
        startDate: data.startDate || localDateStr(new Date()),
        endDate: data.endDate || localDateStr(new Date()),
        budget: Number(data.budget) || 0,
        currency: data.currency || 'JPY',
        status: 'active',
        members: data.members || (state.members || []).map(m => m.name),
        totalExpense: 0,
        createdAt: mockNow()
      };
      if (!mockDb.events) mockDb.events = [];
      mockDb.events.unshift(newEv);
      return { success: true, event: newEv };
    }
    case 'deleteEvent': {
      if (mockDb.events) mockDb.events = mockDb.events.filter(e => e.id !== data.id);
      if (mockDb.eventExpenses) mockDb.eventExpenses = mockDb.eventExpenses.filter(e => e.eventId !== data.id);
      return { success: true };
    }
    case 'addEventExpense': {
      const expId = 'ee_' + Date.now().toString(36);
      const exp = {
        id: expId,
        eventId: data.eventId,
        title: data.title,
        amount: Number(data.amount) || 0,
        payer: data.payer || state.currentUser,
        splitType: data.splitType || 'equal',
        date: data.date || localDateStr(new Date()),
        category: data.category || 'その他',
        createdAt: mockNow()
      };
      if (!mockDb.eventExpenses) mockDb.eventExpenses = [];
      mockDb.eventExpenses.push(exp);
      return { success: true, expense: exp };
    }
    case 'deleteEventExpense': {
      if (mockDb.eventExpenses) mockDb.eventExpenses = mockDb.eventExpenses.filter(e => e.id !== data.id);
      return { success: true };
    }
    case 'getEventSettlement': {
      const expenses = (mockDb.eventExpenses || []).filter(e => e.eventId === data.eventId);
      const members = (state.members || []).map(m => m.name);
      return {
        success: true,
        settlement: {
          eventId: data.eventId,
          totalAmount: expenses.reduce((s, e) => s + e.amount, 0),
          perPerson: members.length ? Math.round(expenses.reduce((s, e) => s + e.amount, 0) / members.length) : 0,
          transfers: []
        }
      };
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
    (it.isShared !== false || isSameMember(it.payer, state.currentUser)) &&
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
// 通信 & キャッシュ
// ==========================================
const CACHE_PREFIX = 'pairbudget_init_v2_';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7日間アクセスがなければ自動破棄

function cacheKeyForMonth(month) {
  return `${CACHE_PREFIX}${month}`;
}

function saveInitCache(data) {
  if (!data || !data.month || state.isMockMode) return;
  try {
    const payload = {
      savedAt: Date.now(),
      data: data
    };
    localStorage.setItem(cacheKeyForMonth(data.month), JSON.stringify(payload));
  } catch (_) { /* 容量超過時は無視 */ }
}

function loadInitCache(month) {
  try {
    const raw = localStorage.getItem(cacheKeyForMonth(month));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // 旧キャッシュ構造との互換チェック
    if (parsed && parsed.data && parsed.savedAt) {
      if (Date.now() - parsed.savedAt > CACHE_MAX_AGE_MS) {
        localStorage.removeItem(cacheKeyForMonth(month));
        return null;
      }
      return parsed.data;
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

function clearAllLocalCache() {
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(CACHE_PREFIX) || k.startsWith('pairbudget_init_'))) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  } catch (_) {}
}

async function callGas(action, data, extra = {}) {
  const idToken = state.liffReady ? liff.getIDToken() : null;

  const sendRequest = async (url) => {
    if (!url) throw new Error('API URL is empty');
    const isGoogleScript = url.includes('script.google.com');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': isGoogleScript ? 'text/plain' : 'application/json'
      },
      body: JSON.stringify({ action, data: data || {}, idToken, pairId: state.pairId, ...extra })
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      throw new Error('HTML response returned instead of JSON (Endpoint may not exist)');
    }
    return res.json();
  };

  try {
    return await sendRequest(state.gasApiUrl);
  } catch (err) {
    // もし /api/budget が404等の場合、APP_CONFIG.GAS_URL があればフォールバック試行
    if (state.gasApiUrl !== APP_CONFIG.GAS_URL && APP_CONFIG.GAS_URL) {
      console.warn('プライマリAPI失敗のためGAS_URLへフォールバック試行:', err);
      try {
        return await sendRequest(APP_CONFIG.GAS_URL);
      } catch (gasErr) {
        console.warn('GAS_URLフォールバックも失敗:', gasErr);
      }
    }
    throw err;
  }
}

async function api(action, data = {}, extra = {}) {
  if (state.isMockMode) {
    return await mockApi(action, data);
  }
  try {
    return await callGas(action, data, extra);
  } catch (err) {
    console.warn('API通信エラー (デモモードへフォールバック):', action, err);
    // バックエンド未起動、404、オフライン時は自動でデモモードへフォールバック
    state.isMockMode = true;
    showBanner('⚠️ バックエンドに接続できないため、デモモードで動作中です（ローカルで全機能を操作可能）', 'warn');
    return await mockApi(action, data);
  }
}

function reLoginLiff() {
  if (typeof liff === 'undefined') return;
  clearAllLocalCache(); // ログアウト・再認証時は端末内のキャッシュを安全に破棄
  try {
    if (liff.isLoggedIn() && !liff.isInClient()) {
      liff.logout();
    }
  } catch (_) {}
  // クエリパラメータやハッシュを取り除いたクリーンなURLへリダイレクト
  const cleanUrl = window.location.origin + window.location.pathname;
  liff.login({ redirectUri: cleanUrl });
}

function handleApiError(res) {
  if (res.code === 'AUTH') {
    // 自動リダイレクトすると原因が分からず画面がチカチカするため、
    // 自動リダイレクトを一切行わず、画面上部バナーにエラーと再ログインボタンを表示する
    const reason = res.error || 'LINEログインの認証に失敗しました';
    showBanner(`${reason} 👉 [ここをタップして再ログイン]`, 'error');
    const banner = $('mockBanner');
    if (banner) {
      banner.style.cursor = 'pointer';
      banner.onclick = () => {
        reLoginLiff();
      };
    }
    showToast(reason, { duration: 6000 });
    return;
  }
  if (res.code === 'SETUP_REQUIRED') {
    showBanner(res.error || 'GASのスクリプトプロパティ設定を確認してください', 'error');
    showToast(res.error || '設定エラーが発生しました', { duration: 6000 });
    return;
  }
  if (res.code === 'UNREGISTERED') {
    showBanner(res.error, 'error');
    openRegisterModal(res.availableRoles);
    return;
  }
  showToast(res.error || 'エラーが発生しました');
}

window.switchOnboardingTab = function (tab) {
  const isCreate = tab === 'create';
  $('onboardingCreateForm')?.classList.toggle('hidden', !isCreate);
  $('onboardingJoinForm')?.classList.toggle('hidden', isCreate);
  const createBtn = $('tabOnboardingCreateBtn');
  const joinBtn = $('tabOnboardingJoinBtn');
  if (createBtn && joinBtn) {
    if (isCreate) {
      createBtn.className = 'py-2 rounded-lg bg-white text-brand-700 shadow-sm transition-all flex items-center justify-center gap-1.5 font-bold';
      joinBtn.className = 'py-2 rounded-lg text-slate-500 hover:text-slate-800 transition-all flex items-center justify-center gap-1.5 font-medium';
    } else {
      createBtn.className = 'py-2 rounded-lg text-slate-500 hover:text-slate-800 transition-all flex items-center justify-center gap-1.5 font-medium';
      joinBtn.className = 'py-2 rounded-lg bg-white text-indigo-700 shadow-sm transition-all flex items-center justify-center gap-1.5 font-bold';
    }
  }
  lucide.createIcons();
};

function openRegisterModal(opts = {}) {
  const modal = $('registerMemberModal');
  if (!modal) return;

  // ステップ1（入力）を表示、ステップ2（完了）を非表示
  $('onboardingStepForm')?.classList.remove('hidden');
  $('onboardingStepComplete')?.classList.add('hidden');

  // URLパラメータまたは引数の招待コードをチェック
  let inviteCode = opts.inviteCode || '';
  if (!inviteCode) {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      inviteCode = urlParams.get('invite') || '';
    } catch (_) {}
  }

  if (inviteCode) {
    switchOnboardingTab('join');
    if ($('onboardingJoinCode')) $('onboardingJoinCode').value = inviteCode.toUpperCase().trim();
  } else {
    switchOnboardingTab('create');
  }

  // LIFF表示名があれば入力欄にセット
  if (state.liffDisplayName) {
    if ($('onboardingCreatorName') && !$('onboardingCreatorName').value) {
      $('onboardingCreatorName').value = state.liffDisplayName;
    }
    if ($('onboardingJoinName') && !$('onboardingJoinName').value) {
      $('onboardingJoinName').value = state.liffDisplayName;
    }
  }

  modal.classList.remove('hidden');
  lucide.createIcons();
}

async function submitOnboardingCreate(e) {
  if (e) e.preventDefault();
  const userName = $('onboardingCreatorName')?.value.trim();
  const groupName = $('onboardingGroupName')?.value.trim() || 'ふたりの家計簿';
  if (!userName) {
    showToast('あなたのニックネームを入力してください');
    $('onboardingCreatorName')?.focus();
    return;
  }
  showToast('家計簿グループを作成中…', { loading: true });

  try {
    const res = await api('createPair', { name: groupName, userName });
    hideToast();

    // res.pair が存在しない場合でも安全にフォールバック
    const pair = (res && res.pair) ? res.pair : {
      id: 'pair_' + Date.now().toString(36),
      name: groupName,
      inviteCode: 'PB' + Math.random().toString(36).substring(2, 7).toUpperCase()
    };

    // 作成成功: 状態とストレージを更新
    state.pairId = pair.id;
    state.pairName = pair.name;
    state.inviteCode = pair.inviteCode;
    state.currentUser = userName;
    if (state.members && state.members.length > 0) {
      state.members[0].name = userName;
      saveMembersToStorage();
      syncStateConfigFromMembers();
    }
    localStorage.setItem('pairbudget_pair_id', pair.id);
    localStorage.setItem('pairbudget_pair_name', pair.name);
    localStorage.setItem('pairbudget_invite_code', pair.inviteCode);
    updatePairHeader();

    // ステップ2（完了画面）を表示
    if ($('onboardingGeneratedCode')) $('onboardingGeneratedCode').textContent = pair.inviteCode;
    $('onboardingStepForm')?.classList.add('hidden');
    $('onboardingStepComplete')?.classList.remove('hidden');
    lucide.createIcons();
    showToast('グループを作成しました！🎉');
  } catch (err) {
    console.error('submitOnboardingCreate例外発生 (フォールバック実行):', err);
    hideToast();
    const fallbackCode = 'PB' + Math.random().toString(36).substring(2, 7).toUpperCase();
    state.pairId = 'pair_demo';
    state.pairName = groupName;
    state.inviteCode = fallbackCode;
    state.currentUser = userName;
    if (state.members && state.members.length > 0) {
      state.members[0].name = userName;
      saveMembersToStorage();
      syncStateConfigFromMembers();
    }
    localStorage.setItem('pairbudget_pair_id', 'pair_demo');
    localStorage.setItem('pairbudget_pair_name', groupName);
    localStorage.setItem('pairbudget_invite_code', fallbackCode);
    updatePairHeader();
    if ($('onboardingGeneratedCode')) $('onboardingGeneratedCode').textContent = fallbackCode;
    $('onboardingStepForm')?.classList.add('hidden');
    $('onboardingStepComplete')?.classList.remove('hidden');
    lucide.createIcons();
    showToast('グループを作成しました！🎉');
  }
}

async function submitOnboardingJoin(e) {
  if (e) e.preventDefault();
  const inviteCode = $('onboardingJoinCode')?.value.trim().toUpperCase();
  const userName = $('onboardingJoinName')?.value.trim();
  if (!inviteCode) {
    showToast('招待コードを入力してください');
    $('onboardingJoinCode')?.focus();
    return;
  }
  if (!userName) {
    showToast('あなたのニックネームを入力してください');
    $('onboardingJoinName')?.focus();
    return;
  }
  showToast('グループに参加中…', { loading: true });

  try {
    const res = await api('joinPair', { inviteCode, name: userName });
    hideToast();

    const pair = (res && res.pair) ? res.pair : {
      id: 'pair_' + Date.now().toString(36),
      name: 'ふたりの家計簿',
      inviteCode: inviteCode
    };

    state.pairId = pair.id;
    state.pairName = pair.name;
    state.inviteCode = pair.inviteCode;
    state.currentUser = userName;
    if (state.members && state.members.length > 1) {
      state.members[1].name = userName;
      saveMembersToStorage();
      syncStateConfigFromMembers();
    }
    localStorage.setItem('pairbudget_pair_id', pair.id);
    localStorage.setItem('pairbudget_pair_name', pair.name);
    localStorage.setItem('pairbudget_invite_code', pair.inviteCode);
    updatePairHeader();

    $('registerMemberModal')?.classList.add('hidden');
    hideBanner();
    showToast(`グループ「${pair.name}」に参加しました！🤝`);
    await loadInitialData(state.viewMonth, { skipCache: true });
  } catch (err) {
    console.error('submitOnboardingJoin例外発生 (フォールバック実行):', err);
    hideToast();
    state.pairId = 'pair_demo';
    state.pairName = 'ふたりの家計簿';
    state.inviteCode = inviteCode;
    state.currentUser = userName;
    localStorage.setItem('pairbudget_pair_id', 'pair_demo');
    localStorage.setItem('pairbudget_pair_name', 'ふたりの家計簿');
    localStorage.setItem('pairbudget_invite_code', inviteCode);
    updatePairHeader();
    $('registerMemberModal')?.classList.add('hidden');
    hideBanner();
    showToast(`グループに参加しました！🤝`);
    await loadInitialData(state.viewMonth, { skipCache: true });
  }
}

window.copyOnboardingCode = function () {
  const code = state.inviteCode || $('onboardingGeneratedCode')?.textContent.trim();
  if (!code || code === '------') return;
  const url = `${window.location.origin}${window.location.pathname}?invite=${code}`;
  const text = `ふたりの家計簿に招待されました！\nグループ: ${state.pairName || 'ふたりの家計簿'}\n招待コード: ${code}\n参加はこちら: ${url}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('招待メッセージをコピーしました！LINE等で送信してください');
    }).catch(() => {
      prompt('以下の招待コードをコピーしてください:', code);
    });
  } else {
    prompt('以下の招待コードをコピーしてください:', code);
  }
};

window.shareOnboardingViaLine = function () {
  const code = state.inviteCode || $('onboardingGeneratedCode')?.textContent.trim();
  if (!code || code === '------') return;
  const url = `${window.location.origin}${window.location.pathname}?invite=${code}`;
  const text = `ふたりの家計簿に招待されました！\nグループ: ${state.pairName || 'ふたりの家計簿'}\n招待コード: ${code}\nここから参加してね👇\n${url}`;
  window.open(`https://line.me/R/msg/text/?${encodeURIComponent(text)}`, '_blank');
};

window.finishOnboarding = function () {
  $('registerMemberModal')?.classList.add('hidden');
  hideBanner();
  loadInitialData(state.viewMonth, { skipCache: true });
};

function showBanner(msg, kind) {
  const banner = $('mockBanner');
  if (!banner) return;
  banner.classList.remove('hidden');
  banner.className = banner.className.replace(/bg-(amber|rose)-500/g, '') + (kind === 'error' ? ' bg-rose-500' : ' bg-amber-500');
  const span = banner.querySelector('span');
  if (span) span.textContent = msg;
}

function hideBanner() {
  const banner = $('mockBanner');
  if (banner) banner.classList.add('hidden');
}

/**
 * 書き込み → 同一リクエスト（1往復）で最新データを受け取って画面更新（旧GASへのフォールバック付き）
 */
async function writeAndRefresh(action, data, successMsg, loadingMsg) {
  if (state.busy) return { success: false };
  state.busy = true;
  if (loadingMsg) showToast(loadingMsg, { loading: true });
  try {
    const res = await api(action, data, { returnInitialData: true, viewMonth: state.viewMonth });
    if (!res.success) { handleApiError(res); return res; }
    if (res.initialData && res.initialData.success) {
      saveInitCache(res.initialData);
      applyData(res.initialData);
    } else {
      await loadInitialData(state.viewMonth, { skipCache: true });
    }
    if (successMsg) showToast(successMsg);
    else hideToast();
    return res;
  } finally {
    state.busy = false;
  }
}

async function loadInitialData(month, opts = {}) {
  const isMonthSwitch = Boolean(month && month !== state.viewMonth);
  if (month) state.viewMonth = month;
  const targetMonth = state.viewMonth;

  if (!state.gasApiUrl) {
    state.isMockMode = true;
    showBanner('デモモードで動作中（GAS URL未設定・データは保存されません）', 'warn');
    applyData(await mockApi('getInitialData', { month: targetMonth }));
    return;
  }

  // キャッシュがあれば即座（0.02秒）に先行描画し、裏で最新データを取得して差分更新
  let usedCache = false;
  if (!opts.skipCache) {
    const cached = loadInitCache(targetMonth);
    if (cached && cached.month === targetMonth) {
      usedCache = true;
      applyData(cached);
    } else {
      renderMonthNav();
    }
  }
  if (!usedCache && !opts.silent) {
    showToast(isMonthSwitch ? `${targetMonth.replace('-', '年')}月のデータを読み込み中…` : '最新データを同期しています…', { loading: true });
  }

  try {
    const res = await api('getInitialData', { month: targetMonth });
    if (state.viewMonth !== targetMonth) return; // 月送り連打時の古いレスポンスを破棄

    if (!res || !res.success) {
      if (res) handleApiError(res);
      // バックエンド障害時はデモモードに自動フォールバックして描画
      state.isMockMode = true;
      showBanner('⚠️ バックエンドに接続できないため、デモモードで動作中です（ローカルで全機能を操作可能）', 'warn');
      const fallbackData = await mockApi('getInitialData', { month: targetMonth });
      applyData(fallbackData);
      if (!usedCache && !opts.silent) hideToast();
      return;
    }

    sessionStorage.removeItem('pairbudget_reauth_ts');
    if (!usedCache && !opts.silent) hideToast();
    if (!state.isMockMode) {
      hideBanner();
      saveInitCache(res);
    }
    applyData(res);
  } catch (err) {
    console.warn('loadInitialDataエラー -> デモモードで起動:', err);
    state.isMockMode = true;
    showBanner('⚠️ バックエンドに接続できないため、デモモードで動作中です（ローカルで全機能を操作可能）', 'warn');
    const fallbackData = await mockApi('getInitialData', { month: targetMonth });
    applyData(fallbackData);
    if (!usedCache && !opts.silent) hideToast();
  }
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
  state.backendVersion = data.version || (state.isMockMode ? 'demo' : 'v2.1以下 (未更新)');
  if (data.members && Array.isArray(data.members) && data.members.length > 0) {
    state.members = data.members;
    syncStateConfigFromMembers();
    saveMembersToStorage();
  } else if (data.config) {
    state.config = {
      husbandBaseContribution: Number(data.config.husbandBaseContribution) || 60000,
      wifeBaseContribution: Number(data.config.wifeBaseContribution) || 60000,
      husbandName: data.config.husbandName || 'メンバー1',
      wifeName: data.config.wifeName || 'メンバー2'
    };
    if (state.members && state.members.length >= 2) {
      if (data.config.husbandName) state.members[0].name = data.config.husbandName;
      if (data.config.husbandBaseContribution) state.members[0].baseContribution = Number(data.config.husbandBaseContribution);
      if (data.config.wifeName) state.members[1].name = data.config.wifeName;
      if (data.config.wifeBaseContribution) state.members[1].baseContribution = Number(data.config.wifeBaseContribution);
    }
  }
  if (data.pair) {
    state.pairId = data.pair.id;
    state.pairName = data.pair.name;
    state.inviteCode = data.pair.inviteCode || '';
    localStorage.setItem('pairbudget_pair_id', data.pair.id);
    localStorage.setItem('pairbudget_pair_name', data.pair.name);
    localStorage.setItem('pairbudget_invite_code', data.pair.inviteCode || '');
    updatePairHeader();
  }
  if (data.actor && data.actor.verified) {
    state.currentUser = data.actor.name;
    state.currentSlot = data.actor.slot || resolvePayerSlot(data.actor.name) || 'husband';
    state.actorVerified = true;
  } else {
    state.currentUser = memberName(state.currentSlot);
  }
  renderAll();
}

// ==========================================
// 描画
// ==========================================
function renderAll() {
  renderMonthNav();
  renderMemberLabels();
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

function renderMemberLabels() {
  const hName = memberName('husband');
  const wName = memberName('wife');
  if ($('husbandNameLabel')) $('husbandNameLabel').textContent = hName;
  if ($('wifeNameLabel')) $('wifeNameLabel').textContent = wName;
  if ($('filterPayerHusband')) $('filterPayerHusband').textContent = hName;
  if ($('filterPayerWife')) $('filterPayerWife').textContent = wName;
  if ($('expensePayerHusband')) $('expensePayerHusband').value = hName;
  if ($('expensePayerHusbandLabel')) $('expensePayerHusbandLabel').textContent = hName;
  if ($('expensePayerWife')) $('expensePayerWife').value = wName;
  if ($('expensePayerWifeLabel')) $('expensePayerWifeLabel').textContent = wName;
  if ($('receiptPayerHusband')) {
    $('receiptPayerHusband').value = hName;
    $('receiptPayerHusband').textContent = hName;
  }
  if ($('receiptPayerWife')) {
    $('receiptPayerWife').value = wName;
    $('receiptPayerWife').textContent = wName;
  }
}

function renderMonthNav() {
  const [y, m] = state.viewMonth.split('-');
  $('currentMonthLabel').textContent = `${y}年${Number(m)}月`;
  $('nextMonthBtn').disabled = state.viewMonth >= localMonthStr();
  $('prevMonthBtn').disabled = state.viewMonth <= shiftMonth(localMonthStr(), -(MAX_HISTORY_MONTHS - 1));
}

function renderTransferCard() {
  const container = $('transferCardsContainer');
  if (!container) return;

  const count = state.members.length;
  container.className = count === 2
    ? 'grid grid-cols-2 gap-3'
    : 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3';

  container.innerHTML = '';

  state.members.forEach((member, idx) => {
    const mColor = getMemberColor(member.color);
    const mName = member.name;

    // 当月の私物利用額（共同カードで私物を買った額）
    const privateOnShared = state.transactions
      .filter(t => !t.isShared && t.paymentType === 'shared_card' && isSameMember(t.payer, mName))
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);

    // 当月の個人立替額（自分の財布で共同支出を立替えた額）
    const advancedForShared = state.transactions
      .filter(t => t.isShared && t.paymentType === 'advanced_by_user' && isSameMember(t.payer, mName))
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);

    const baseContribution = Number(member.baseContribution) || 0;
    const totalTransfer = Math.max(0, baseContribution + privateOnShared - advancedForShared);
    const isPaid = !!member.isPaid;

    const card = document.createElement('div');
    card.className = 'bg-slate-800/80 rounded-xl p-3 border border-slate-700 transition-colors flex flex-col justify-between';
    card.style.borderColor = `${mColor.hex}40`;

    const statusBadge = isPaid
      ? '<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-bold shrink-0">振込済</span>'
      : '<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-medium shrink-0">未完了</span>';

    const btnHtml = isPaid
      ? `<button type="button" data-member-id="${esc(member.id)}" class="mt-2.5 w-full py-1.5 rounded-lg text-xs font-bold bg-slate-700 text-slate-300 flex items-center justify-center gap-1 transition-opacity hover:opacity-90">
           <i data-lucide="check" class="w-3.5 h-3.5"></i> 振込済み（取消）
         </button>`
      : `<button type="button" data-member-id="${esc(member.id)}" class="mt-2.5 w-full py-1.5 rounded-lg text-xs font-bold text-white flex items-center justify-center gap-1 shadow-sm transition-opacity hover:opacity-90" style="background-color: ${mColor.hex}">
           <i data-lucide="check-circle" class="w-3.5 h-3.5"></i> 振込済みにする
         </button>`;

    card.innerHTML = `
      <div>
        <div class="flex items-center justify-between mb-1.5">
          <span class="text-xs font-bold flex items-center gap-1 truncate" style="color: ${mColor.hex}">
            <i data-lucide="user" class="w-3 h-3 shrink-0"></i> <span class="truncate">${esc(mName)}</span>の振込
          </span>
          ${statusBadge}
        </div>
        <div class="text-lg font-black text-white">${yen(totalTransfer)}</div>
        <div class="text-[10px] text-slate-400 mt-1 space-y-0.5">
          <div>基本: ${yen(baseContribution)}</div>
          <div>私物: +${yen(privateOnShared)} / 立替: -${yen(advancedForShared)}</div>
        </div>
      </div>
      <div>${btnHtml}</div>
    `;

    // 振込ステータストグル
    card.querySelector('button[data-member-id]')?.addEventListener('click', () => {
      toggleMemberTransferStatus(member.id);
    });

    container.appendChild(card);
  });

  lucide.createIcons();
}

window.toggleMemberTransferStatus = async function (memberId) {
  const member = state.members.find(m => m.id === memberId);
  if (!member) return;
  member.isPaid = !member.isPaid;
  saveMembersToStorage();
  renderTransferCard();

  // 後方互換API呼び出し
  const slot = member.slot || 'husband';
  writeAndRefresh('updateTransferStatus', { month: state.viewMonth, slot, payer: member.name, isPaid: member.isPaid }, `${member.name}の振込ステータスを更新しました`, '更新中…').catch(() => {});
};

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
    : (!t.isShared && isSameMember(t.payer, state.currentUser)));
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
    data: rows.map(r => shared ? r.shared : (r.personal[state.currentSlot] ?? r.personal[state.currentUser] ?? 0)),
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
  const masked = !item.isShared && state.privacyMask && !isSameMember(item.payer, state.currentUser);
  const title = masked ? '🔒 私物支出 (マスキング中)' : item.title;

  let tag = '';
  if (!item.isShared && item.paymentType === 'shared_card') tag = '<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-bold">私物(返還要)</span>';
  else if (item.isShared && item.paymentType === 'advanced_by_user') tag = '<span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-bold">立替</span>';

  const edited = item.updatedBy
    ? `<div class="text-[10px] text-slate-500">✏️ ${esc(displayPayerName(item.updatedBy))}が修正 ${esc(shortDateTime(item.updatedAt))}</div>`
    : '';
  const meta = `<div class="text-[10px] text-slate-400">登録: ${esc(displayPayerName(item.createdBy) || '不明')} ${esc(shortDateTime(item.createdAt))}</div>${edited}`;

  const slot = resolvePayerSlot(item.payer);
  const payerName = displayPayerName(item.payer);
  const badgeText = payerName.slice(0, 2);
  const mColor = getMemberColor(slot);
  const badgeStyle = slot === 'shared'
    ? 'background-color: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0;'
    : `background-color: ${mColor.bgHex}; color: ${mColor.hex}; border: 1px solid ${mColor.borderHex};`;
  const items = item.receiptId && !masked ? state.receiptItems.filter(it => it.receiptId === item.receiptId) : [];

  const actions = isEditable ? `
    <button data-action="tx-history" data-id="${esc(item.id)}" class="text-slate-300 hover:text-slate-600 p-1" aria-label="変更履歴"><i data-lucide="history" class="w-3.5 h-3.5"></i></button>
    <button data-action="edit-tx" data-id="${esc(item.id)}" class="text-slate-300 hover:text-slate-600 p-1" aria-label="編集"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i></button>` : '';

  const head = `
    <div class="flex items-center gap-2.5 min-w-0">
      <span class="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold" style="${badgeStyle}" title="${esc(payerName)}">${esc(badgeText)}</span>
      <div class="min-w-0">
        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="text-xs font-bold text-slate-800 break-all">${item.receiptId ? '🧾 ' : ''}${esc(title)}</span>${tag}
        </div>
        <div class="text-[10px] text-slate-400">${esc(item.date)} ・ ${esc(payerName)} ・ ${esc(item.category)}${items.length ? ` ・ ${items.length}品` : ''}</div>
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
  const list = scopedTransactions().filter(t => {
    const catOk = cat === 'all' || t.category === cat;
    const payerOk = payer === 'all' || resolvePayerSlot(t.payer) === payer || t.payer === payer;
    return catOk && payerOk;
  });
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
  $('fixedExpensesList').innerHTML = state.fixedExpenses.length ? state.fixedExpenses.map(f => `
    <div data-action="edit-fixed" data-id="${esc(f.id)}" class="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-100 text-xs cursor-pointer transition-colors ${f.isActive ? '' : 'opacity-50'}">
      <div><span class="font-bold text-slate-800">${esc(f.title)}</span>
      <span class="text-[10px] text-slate-400 block">毎月${esc(f.billingDay)}日引落 (${esc(f.category)})</span></div>
      <div class="flex items-center gap-2">
        <div class="text-right"><span class="font-black text-slate-900">${yen(f.amount)}</span>
        <span class="text-[9px] ${f.isActive ? 'text-purple-600' : 'text-slate-400'} font-bold block">${f.isActive ? '自動計上 ON' : '停止中 OFF'}</span></div>
        <i data-lucide="edit-3" class="w-3.5 h-3.5 text-slate-300"></i>
      </div>
    </div>`).join('') : '<div class="py-4 text-center text-xs text-slate-400">固定費はまだ登録されていません</div>';
}

function categoryOptionsHtml(selected) {
  return state.categories.map(c => `<option value="${esc(c.name)}"${c.name === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
}

function renderCategoryDropdown() {
  const keepFilter = $('historyCategoryFilter').value;
  $('expenseCategory').innerHTML = categoryOptionsHtml();
  $('receiptCategory').innerHTML = categoryOptionsHtml();
  if ($('fixedExpenseCategory')) $('fixedExpenseCategory').innerHTML = categoryOptionsHtml();
  $('historyCategoryFilter').innerHTML = '<option value="all">全カテゴリ</option>' + categoryOptionsHtml();
  $('historyCategoryFilter').value = state.categories.some(c => c.name === keepFilter) ? keepFilter : 'all';
}

function renderSettings() {
  if ($('settingBudgetInput')) $('settingBudgetInput').value = state.summary.budget;
  if ($('settingHusbandName')) $('settingHusbandName').value = memberName('husband');
  if ($('settingWifeName')) $('settingWifeName').value = memberName('wife');
  if ($('settingHusbandBase')) $('settingHusbandBase').value = state.config.husbandBaseContribution;
  if ($('settingWifeBase')) $('settingWifeBase').value = state.config.wifeBaseContribution;
  if ($('privacyMaskToggle')) $('privacyMaskToggle').checked = state.privacyMask;

  // 動的メンバー一覧＆カラー設定を描画
  renderSettingMembersList();
  applyMemberColors();

  // バージョン表示
  if ($('frontVersionLabel')) $('frontVersionLabel').textContent = FRONTEND_VERSION;
  if ($('backVersionLabel')) {
    $('backVersionLabel').textContent = state.backendVersion || (state.isMockMode ? 'demo' : '未取得');
  }
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
  return isShared === false && Boolean(owner) && !isSameMember(owner, state.currentUser);
}

function diffText(before, after, log) {
  const masked = isMaskedAuditEntry(before, after, log);
  const maskLabel = '🔒 私物支出 (マスキング中)';
  if (!before && after) {
    if (after.role) return `登録: ${esc(after.role)}`;
    if (after.husband !== undefined) return `${esc(memberName('husband'))}: ${yen(after.husband)} / ${esc(memberName('wife'))}: ${yen(after.wife)}`;
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
  showToast('変更履歴を読み込み中…', { loading: true });
  const res = await api('getAuditLog', { limit: 50 });
  if (!res.success) { box.innerHTML = ''; handleApiError(res); return; }
  hideToast();
  box.innerHTML = res.logs.length ? res.logs.map(auditRowHtml).join('') : '<div class="py-3 text-center text-xs text-slate-400">履歴はまだありません</div>';
}

async function openTxHistory(id) {
  const tx = state.transactions.find(t => t.id === id);
  const masked = tx && !tx.isShared && state.privacyMask && !isSameMember(tx.payer, state.currentUser);
  $('auditDetailTitle').textContent = `変更履歴: ${tx ? (masked ? '🔒 私物支出 (マスキング中)' : tx.title) : ''}`;
  $('auditDetailBody').innerHTML = '<div class="py-4 text-center text-slate-400">読み込み中…</div>';
  $('auditDetailModal').classList.remove('hidden');
  showToast('履歴を取得中…', { loading: true });
  const res = await api('getAuditLog', { targetId: id, limit: 50 });
  if (!res.success) { $('auditDetailModal').classList.add('hidden'); handleApiError(res); return; }
  hideToast();
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
  showToast(`「${q}」の価格履歴を検索中…`, { loading: true });
  const res = await api('searchPrices', { query: q });
  if (!res.success) { box.classList.add('hidden'); handleApiError(res); return; }
  hideToast();
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
function resizeImageToBase64(file, maxSide = 1024, quality = 0.78) {
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
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした（対応形式: JPEG / PNG / WebP）')); };
    img.src = url;
  });
}

function receiptRowHtml(it) {
  return `<div class="flex gap-1.5 items-center" data-row>
    <input type="text" class="rc-name flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs" value="${esc(it.name)}" maxlength="50" aria-label="品名">
    <input type="number" class="rc-qty w-12 bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-xs text-center" value="${esc(it.quantity)}" min="1" max="99" inputmode="numeric" aria-label="数量">
    <input type="number" class="rc-price w-20 bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-xs text-right" value="${esc(it.price)}" aria-label="金額（値引きはマイナス）">
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
  if (file.type && !/^image\//i.test(file.type)) {
    showToast('画像ファイルを選んでください');
    $('receiptFileInput').value = '';
    return;
  }
  // LINE内ブラウザ(LIFF WebView)では input[type=file] の change イベント内で window.confirm() がブロックされ
  // false を返してモーダルが開かなくなるため、ネイティブ confirm は使わず即座に読み取りモーダルを開く
  closeExpenseModal();
  $('receiptModal').classList.remove('hidden');
  $('receiptForm').classList.add('hidden');
  $('receiptLoading').classList.remove('hidden');
  showToast('📷 レシート画像を最適化しています…', { loading: true });
  try {
    const imageBase64 = await resizeImageToBase64(file);
    showToast('🤖 AIがレシートを読み取り中です（5〜10秒ほどお待ちください）…', { loading: true });
    const res = await api('scanReceipt', { imageBase64, mimeType: 'image/jpeg' });
    if (!res || !res.success || !res.receipt) {
      closeReceiptModal();
      handleApiError(res || { error: 'レシートデータの取得に失敗しました' });
      return;
    }
    fillReceiptForm(res.receipt);
    showToast('✨ レシートを読み取りました！内容を確認してください');
  } catch (err) {
    closeReceiptModal();
    showToast(err.message || 'レシートの読み取りに失敗しました');
  } finally {
    $('receiptFileInput').value = '';
  }
}

function fillReceiptForm(r) {
  const receipt = r || {};
  scannedTotal = Number(receipt.total) || 0;
  $('receiptStore').value = receipt.store || '';
  $('receiptDate').value = receipt.date || localDateStr();
  $('receiptCategory').innerHTML = categoryOptionsHtml(guessCategoryByStore(receipt.store || ''));
  $('receiptIsShared').value = 'true';
  $('receiptPaymentType').value = 'shared_card';
  $('receiptPayer').value = memberName(state.currentSlot);
  const items = Array.isArray(receipt.items) && receipt.items.length ? receipt.items : [{ name: '', quantity: 1, price: 0 }];
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

  const payload = {
    store: $('receiptStore').value.trim(), date: $('receiptDate').value, category: $('receiptCategory').value,
    isShared: $('receiptIsShared').value === 'true', paymentType: $('receiptPaymentType').value,
    payer: $('receiptPayer').value, items
  };
  closeReceiptModal();
  await writeAndRefresh('saveReceipt', payload, 'レシートを保存しました（明細も記録）', '🧾 レシートと明細を保存しています…');
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
    const targetPayer = displayPayerName(editItem.payer);
    renderExpensePayerChips(targetPayer);
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
    const myName = state.currentUser || memberName(state.currentSlot);
    renderExpensePayerChips(myName);
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
    payer: currentSelectedExpensePayer || document.querySelector('input[name="expensePayer"]:checked')?.value || state.currentUser || '共同',
    memo: ''
  };
  const existing = id ? state.transactions.find(t => t.id === id) : null;
  if (existing) payload.memo = existing.memo;

  // 楽観的UI更新: モーダルを即座に閉じ、画面上のリストにも即時反映して体感待ち時間をゼロにする
  closeExpenseModal();
  if (!id && payload.date.startsWith(state.viewMonth)) {
    state.transactions.unshift({
      ...payload, id: 'temp_' + Date.now(), createdBy: state.currentUser, createdAt: mockNow(), updatedBy: '', updatedAt: '', receiptId: ''
    });
    if (payload.isShared) {
      state.summary.totalExpense += payload.amount;
      state.summary.remaining = state.summary.budget - state.summary.totalExpense;
      state.summary.progressRate = Math.min(100, Math.round((state.summary.totalExpense / state.summary.budget) * 100));
    }
    renderAll();
  } else if (existing) {
    Object.assign(existing, payload, { updatedBy: state.currentUser, updatedAt: mockNow() });
    renderAll();
  }
  await writeAndRefresh(
    id ? 'updateTransaction' : 'addTransaction',
    payload,
    id ? '支出を更新しました（履歴に記録）' : '支出を記録しました',
    id ? '支出を更新しています…' : '支出を保存しています…'
  );
}

async function handleExpenseDelete() {
  const id = $('expenseId').value;
  const tx = state.transactions.find(t => t.id === id);
  if (!tx) return;
  if (!window.confirm(`「${tx.title}」${yen(tx.amount)} を削除しますか？\n（削除の記録は変更履歴に残ります）`)) return;
  closeExpenseModal();
  state.transactions = state.transactions.filter(t => t.id !== id);
  renderAll();
  await writeAndRefresh('deleteTransaction', { id }, '削除しました（履歴に記録）', '支出を削除しています…');
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
  if (!res.success) { handleApiError(res); await loadInitialData(state.viewMonth, { skipCache: true }); }
  else if (res.id) { item.id = res.id; }
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

  $('buySyncModal').classList.add('hidden');
  item.isCompleted = true;
  renderShoppingList();
  lucide.createIcons();
  showToast('買い物完了＆支出に登録しています…', { loading: true });
  await api('updateShoppingItem', { id, title: item.title, category: item.category, isCompleted: true });
  await writeAndRefresh('addTransaction', {
    date: localDateStr(), title: item.title, amount, category: item.category || '食費', isShared: true,
    paymentType: $('buySyncPaymentType').value, payer: state.currentUser, memo: '買い物リストから連動登録'
  }, '買い物完了＆支出に登録しました！', '買い物完了＆支出に登録しています…');
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
// 固定費の追加・編集・削除
// ==========================================
function openFixedModal(editItem) {
  $('fixedExpenseForm').reset();
  if (editItem) {
    $('fixedModalTitle').textContent = '固定費を編集';
    $('fixedExpenseId').value = editItem.id;
    $('fixedExpenseTitle').value = editItem.title;
    $('fixedExpenseAmount').value = editItem.amount;
    $('fixedExpenseDay').value = editItem.billingDay || 1;
    if (editItem.category && !Array.from($('fixedExpenseCategory').options).some(o => o.value === editItem.category)) {
      $('fixedExpenseCategory').insertAdjacentHTML('beforeend', `<option value="${esc(editItem.category)}">${esc(editItem.category)}</option>`);
    }
    $('fixedExpenseCategory').value = editItem.category;
    $('fixedExpenseActive').checked = editItem.isActive !== false;
    $('fixedExpenseDeleteBtn').classList.remove('hidden');
  } else {
    $('fixedModalTitle').textContent = '固定費を追加';
    $('fixedExpenseId').value = '';
    $('fixedExpenseDay').value = 27;
    $('fixedExpenseActive').checked = true;
    $('fixedExpenseDeleteBtn').classList.add('hidden');
  }
  $('fixedExpenseModal').classList.remove('hidden');
  lucide.createIcons();
}

function closeFixedModal() {
  $('fixedExpenseModal').classList.add('hidden');
}

async function handleFixedSubmit(e) {
  e.preventDefault();
  const id = $('fixedExpenseId').value;
  const title = $('fixedExpenseTitle').value.trim();
  const amount = parseInt($('fixedExpenseAmount').value, 10);
  const billingDay = parseInt($('fixedExpenseDay').value, 10);
  if (!title) { showToast('項目名を入力してください'); return; }
  if (!Number.isInteger(amount) || amount <= 0) { showToast('月額を1円以上で入力してください'); return; }
  if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 31) { showToast('引落日は1〜31日で入力してください'); return; }
  const category = $('fixedExpenseCategory').value;
  const isActive = $('fixedExpenseActive').checked;
  closeFixedModal();
  await writeAndRefresh('updateFixedExpense', {
    id, title, amount, billingDay, category, isActive
  }, id ? '固定費を更新しました' : '固定費を追加しました', id ? '固定費を更新しています…' : '固定費を追加しています…');
}

async function handleFixedDelete() {
  const id = $('fixedExpenseId').value;
  const item = state.fixedExpenses.find(f => f.id === id);
  if (!item) return;
  if (!window.confirm(`固定費「${item.title}」（${yen(item.amount)}）を削除しますか？`)) return;
  closeFixedModal();
  state.fixedExpenses = state.fixedExpenses.filter(f => f.id !== id);
  renderFixedExpenses();
  lucide.createIcons();
  await writeAndRefresh('deleteFixedExpense', { id }, '固定費を削除しました', '固定費を削除しています…');
}

// ==========================================
// 設定
// ==========================================
async function handleSaveBudget() {
  const val = parseInt($('settingBudgetInput').value, 10);
  if (!Number.isInteger(val) || val <= 0) { showToast('有効な予算額を入力してください'); return; }
  await writeAndRefresh('updateMonthlyBudget', { month: state.viewMonth, amount: val, note: '' }, `${state.viewMonth.replace('-', '年')}月の予算を保存しました`, '予算を保存しています…');
}

async function handleBaseChange() {
  // 動的メンバー入力フィールドから最新値を反映
  const container = $('settingMembersList');
  if (container) {
    const inputs = container.querySelectorAll('input[data-field]');
    inputs.forEach(input => {
      const idx = parseInt(input.dataset.memberIdx, 10);
      const field = input.dataset.field;
      if (state.members[idx]) {
        if (field === 'name') state.members[idx].name = input.value.trim() || `メンバー${idx + 1}`;
        if (field === 'base') state.members[idx].baseContribution = parseInt(input.value, 10) || 0;
      }
    });
  }

  // 名前の重複・予約語チェック
  const names = (state.members || []).map(m => (m.name || '').trim());
  if (names.some(n => !n)) {
    showToast('メンバーの表示名を入力してください');
    return;
  }
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length) {
    showToast('メンバーの表示名は重複しない名前にしてください');
    return;
  }
  const reservedWords = ['共同', 'all', '未認証', '自動計上'];
  if (names.some(n => reservedWords.includes(n))) {
    showToast('「共同」などの予約語は表示名に使用できません');
    return;
  }
  if (state.members.some(m => !Number.isInteger(m.baseContribution) || m.baseContribution < 0)) {
    showToast('基本拠出額を正しく入力してください');
    return;
  }

  // メンバー設定を保存
  saveMembersToStorage();
  syncStateConfigFromMembers();
  applyMemberColors();

  // 後方互換パラメータ作成
  const husband = state.members[0]?.baseContribution || 0;
  const wife = state.members[1]?.baseContribution || 0;
  const husbandName = state.members[0]?.name || 'メンバー1';
  const wifeName = state.members[1]?.name || 'メンバー2';

  await writeAndRefresh('updateBaseContribution', {
    husband,
    wife,
    husbandName,
    wifeName,
    members: state.members
  }, 'メンバー設定（表示名・基本拠出・カラー）を保存しました', '設定を保存しています…');
}

async function toggleTransferStatus(slot) {
  const t = slot === 'husband' ? state.transfers.husband : state.transfers.wife;
  const nextPaid = !t.isPaid;
  const label = memberName(slot);
  // 楽観的UI更新でタップ直後にバッジを切り替え
  t.isPaid = nextPaid;
  renderTransferCard();
  lucide.createIcons();
  await writeAndRefresh('updateTransferStatus', { month: state.viewMonth, slot, payer: label, isPaid: nextPaid }, `${label}の振込ステータスを更新しました`, '振込ステータスを更新しています…');
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
    const mobileBtn = $(`nav${cap}Btn`);
    if (mobileBtn) {
      mobileBtn.className = `py-1 ${t === tabName ? 'text-brand-600' : 'text-slate-400'} flex flex-col items-center justify-center gap-0.5`;
    }
    const desktopBtn = $(`desktopNav${cap}Btn`);
    if (desktopBtn) {
      desktopBtn.className = `px-3.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
        t === tabName
          ? 'bg-white text-brand-700 shadow-sm font-bold'
          : 'text-slate-500 hover:text-slate-800 font-medium'
      }`;
    }
  });
  if (tabName === 'home') renderCharts(); // 非表示中に描画したグラフのサイズ崩れを防ぐ
  lucide.createIcons();
};

function showToast(msg, opts = {}) {
  const toast = $('toast');
  if (!toast) return;
  const loading = !!opts.loading;
  $('toastMessage').textContent = msg;
  if ($('toastSpinner')) $('toastSpinner').classList.toggle('hidden', !loading);
  if ($('toastIcon')) $('toastIcon').classList.toggle('hidden', loading);
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  if (!loading) {
    showToast.timer = setTimeout(() => toast.classList.add('hidden'), opts.duration || 2800);
  }
}

function hideToast() {
  const toast = $('toast');
  if (!toast) return;
  clearTimeout(showToast.timer);
  toast.classList.add('hidden');
}

function setupEventListeners() {
  $('scopeSharedBtn')?.addEventListener('click', () => setScope('shared'));
  $('scopePersonalBtn')?.addEventListener('click', () => setScope('personal'));
  $('prevMonthBtn')?.addEventListener('click', () => loadInitialData(shiftMonth(state.viewMonth, -1)));
  $('nextMonthBtn')?.addEventListener('click', () => loadInitialData(shiftMonth(state.viewMonth, 1)));

  $('transferHelpBtn')?.addEventListener('click', () => $('transferHelpModal')?.classList.remove('hidden'));

  $('openExpenseModalBtn')?.addEventListener('click', () => openExpenseModal(null));
  $('expenseForm')?.addEventListener('submit', handleExpenseSubmit);
  $('expenseDeleteBtn')?.addEventListener('click', handleExpenseDelete);
  $('receiptFileInput')?.addEventListener('change', e => handleReceiptFile(e.target.files[0]));

  $('receiptForm')?.addEventListener('submit', handleReceiptSubmit);
  $('receiptCloseBtn')?.addEventListener('click', closeReceiptModal);
  $('receiptAddRowBtn')?.addEventListener('click', () => {
    $('receiptItemRows')?.insertAdjacentHTML('beforeend', receiptRowHtml({ name: '', quantity: 1, price: '' }));
    lucide.createIcons();
  });
  $('receiptItemRows')?.addEventListener('input', updateReceiptTotal);

  $('addShoppingForm')?.addEventListener('submit', handleAddShoppingSubmit);
  $('buySyncForm')?.addEventListener('submit', handleBuySyncSubmit);

  $('historyCategoryFilter')?.addEventListener('change', renderHistoryList);
  $('historyPayerFilter')?.addEventListener('change', renderHistoryList);
  $('priceSearchForm')?.addEventListener('submit', handlePriceSearch);
  $('loadAuditBtn')?.addEventListener('click', loadAuditLog);
  $('auditDetailCloseBtn')?.addEventListener('click', () => $('auditDetailModal')?.classList.add('hidden'));
  $('openFixedModalBtn')?.addEventListener('click', () => openFixedModal(null));
  $('fixedModalCloseBtn')?.addEventListener('click', closeFixedModal);
  $('fixedExpenseForm')?.addEventListener('submit', handleFixedSubmit);
  $('fixedExpenseDeleteBtn')?.addEventListener('click', handleFixedDelete);

  $('trendRangeButtons')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    state.trendRange = Number(btn.dataset.range);
    $('trendRangeButtons')?.querySelectorAll('button').forEach(b => {
      b.className = 'px-2 py-1 rounded-md ' + (b === btn ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500');
    });
    renderTrendChart();
  });

  $('saveBudgetBtn')?.addEventListener('click', handleSaveBudget);
  $('saveMemberSettingsBtn')?.addEventListener('click', handleBaseChange);
  $('settingHusbandBase')?.addEventListener('change', handleBaseChange);
  $('settingWifeBase')?.addEventListener('change', handleBaseChange);
  $('privacyMaskToggle')?.addEventListener('change', e => {
    state.privacyMask = e.target.checked;
    localStorage.setItem('pairbudget_privacy_mask', state.privacyMask);
    renderRecentTransactions();
    renderHistoryList();
    if ($('auditLogList')?.children.length > 1) loadAuditLog();
    lucide.createIcons();
    showToast('プライバシー設定を更新しました');
  });
  $('onboardingCreateForm')?.addEventListener('submit', submitOnboardingCreate);
  $('onboardingJoinForm')?.addEventListener('submit', submitOnboardingJoin);
  $('submitOnboardingCreateBtn')?.addEventListener('click', submitOnboardingCreate);
  $('submitOnboardingJoinBtn')?.addEventListener('click', submitOnboardingJoin);
  $('onboardingCloseBtn')?.addEventListener('click', finishOnboarding);

  // モード切替・世帯ペア・臨時イベント リスナー
  $('modeBudgetBtn')?.addEventListener('click', () => switchAppMode('budget'));
  $('modeEventsBtn')?.addEventListener('click', () => switchAppMode('events'));
  $('openPairModalBtn')?.addEventListener('click', openPairModal);
  $('copyInviteCodeBtn')?.addEventListener('click', copyInviteCode);
  $('submitCreatePairBtn')?.addEventListener('click', submitCreatePair);
  $('submitJoinPairBtn')?.addEventListener('click', submitJoinPair);
  $('openCreateEventModalBtn')?.addEventListener('click', openCreateEventModal);
  $('submitCreateEventBtn')?.addEventListener('click', submitCreateEvent);
  $('copySettlementBtn')?.addEventListener('click', copySettlementText);
  $('openAddEventExpenseBtn')?.addEventListener('click', openAddEventExpenseModal);
  $('submitAddEventExpenseBtn')?.addEventListener('click', submitAddEventExpense);

  // 動的に生成された要素のクリック・変更はイベント委譲で処理（品名などをHTML属性に埋め込まない）
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const id = el.dataset.id;
    switch (el.dataset.action) {
      case 'edit-tx': { const tx = state.transactions.find(t => t.id === id); if (tx) openExpenseModal(tx); break; }
      case 'edit-fixed': { const fx = state.fixedExpenses.find(f => f.id === id); if (fx) openFixedModal(fx); break; }
      case 'tx-history': e.preventDefault(); openTxHistory(id); break;
      case 'delete-shop': deleteShoppingItemById(id); break;
      case 'remove-receipt-row': el.closest('[data-row]')?.remove(); updateReceiptTotal(); break;
    }
  });
  document.addEventListener('change', e => {
    const el = e.target.closest('[data-action="buy-shop"]');
    if (el && el.checked) { el.checked = false; openBuySyncModal(el.dataset.id); }
  });
}

async function initLiff() {
  const rawLiffId = String(APP_CONFIG.LIFF_ID || '').trim().replace(/^https?:\/\/liff\.line\.me\//i, '').replace(/\/+$/, '');
  if (!rawLiffId || typeof liff === 'undefined') return;
  try {
    await liff.init({ liffId: rawLiffId });
    if (!liff.isLoggedIn()) {
      // ログインしていない場合のみLINE認証へ遷移
      const cleanUrl = window.location.origin + window.location.pathname;
      liff.login({ redirectUri: cleanUrl });
      return 'redirect';
    }
    state.liffReady = true;
    // プロフィール取得はバックグラウンドで行い、初期データ取得をブロックしない
    liff.getProfile().then(profile => {
      if (profile && profile.displayName) {
        state.liffDisplayName = String(profile.displayName).trim().slice(0, 15);
        if ($('registerNameInput') && !$('registerNameInput').value) {
          $('registerNameInput').value = state.liffDisplayName;
        }
      }
    }).catch(() => {});
  } catch (err) {
    console.warn('LIFF初期化エラー:', err);
    showToast('LINEログインの初期化に失敗しました');
  }
}

// ==========================================
// モード切替 & 世帯ペア管理
// ==========================================

function switchAppMode(mode) {
  state.currentMode = mode;
  const isBudget = mode === 'budget';

  $('budgetView')?.classList.toggle('hidden', !isBudget);
  $('eventsView')?.classList.toggle('hidden', isBudget);

  // フローティングボタン（レシート/支出）は家計簿モードのみ表示
  const quickBtns = document.querySelector('.fixed.right-5.bottom-20');
  if (quickBtns) quickBtns.style.display = isBudget ? 'flex' : 'none';

  // モードタブのアクティブ状態
  const budgetBtn = $('modeBudgetBtn');
  const eventsBtn = $('modeEventsBtn');
  if (budgetBtn && eventsBtn) {
    if (isBudget) {
      budgetBtn.className = 'px-2.5 py-1 rounded-md bg-brand-500 text-white transition-all flex items-center gap-1';
      eventsBtn.className = 'px-2.5 py-1 rounded-md text-slate-400 hover:text-white transition-all flex items-center gap-1';
    } else {
      budgetBtn.className = 'px-2.5 py-1 rounded-md text-slate-400 hover:text-white transition-all flex items-center gap-1';
      eventsBtn.className = 'px-2.5 py-1 rounded-md bg-indigo-600 text-white transition-all flex items-center gap-1';
      loadEvents();
    }
  }
  lucide.createIcons();
}

function updatePairHeader() {
  const headerName = $('headerPairName');
  if (headerName) headerName.textContent = state.pairName || '世帯ペア';
  const modalName = $('modalPairName');
  if (modalName) modalName.textContent = state.pairName || '世帯ペア';
  const modalCode = $('modalInviteCode');
  if (modalCode) modalCode.textContent = state.inviteCode || '未発行';
}

function openPairModal() {
  updatePairHeader();
  $('pairModal')?.classList.remove('hidden');
  lucide.createIcons();
}

function closePairModal() {
  $('pairModal')?.classList.add('hidden');
}

async function submitCreatePair() {
  const name = $('newPairNameInput')?.value.trim();
  const userName = $('newPairCreatorNameInput')?.value.trim();
  if (!name || !userName) {
    showToast('世帯名とお名前を入力してください');
    return;
  }
  showToast('新しい世帯を作成中…', 'loading');
  const res = await api('createPair', { name, userName });
  hideToast();
  if (!res.success) {
    showToast(res.error || '作成に失敗しました');
    return;
  }
  state.pairId = res.pair.id;
  state.pairName = res.pair.name;
  state.inviteCode = res.pair.inviteCode;
  localStorage.setItem('pairbudget_pair_id', res.pair.id);
  localStorage.setItem('pairbudget_pair_name', res.pair.name);
  localStorage.setItem('pairbudget_invite_code', res.pair.inviteCode);
  closePairModal();
  showToast(`世帯ペア「${res.pair.name}」を作成しました！`);
  loadInitialData(state.viewMonth, { skipCache: true });
}

async function submitJoinPair() {
  const inviteCode = $('joinInviteCodeInput')?.value.trim().toUpperCase();
  const userName = $('joinUserNameInput')?.value.trim();
  if (!inviteCode || !userName) {
    showToast('招待コードとお名前を入力してください');
    return;
  }
  showToast('世帯に合流中…', 'loading');
  const res = await api('joinPair', { inviteCode, name: userName });
  hideToast();
  if (!res.success) {
    showToast(res.error || '合流に失敗しました');
    return;
  }
  state.pairId = res.pair.id;
  state.pairName = res.pair.name;
  state.inviteCode = res.pair.inviteCode;
  localStorage.setItem('pairbudget_pair_id', res.pair.id);
  localStorage.setItem('pairbudget_pair_name', res.pair.name);
  localStorage.setItem('pairbudget_invite_code', res.pair.inviteCode);
  closePairModal();
  showToast(`世帯「${res.pair.name}」に合流しました！`);
  loadInitialData(state.viewMonth, { skipCache: true });
}

function copyInviteCode() {
  const code = state.inviteCode || 'PAIR2026';
  const url = `${window.location.origin}${window.location.pathname}?invite=${code}`;
  const text = `ふたり家計簿に招待されました！\n世帯名: ${state.pairName}\n招待コード: ${code}\n合流URL: ${url}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('招待テキストをコピーしました！LINE等で送信してください');
    }).catch(() => {
      prompt('以下のテキストをコピーしてください:', text);
    });
  } else {
    prompt('以下のテキストをコピーしてください:', text);
  }
}

// ==========================================
// 臨時イベント・旅行精算機能
// ==========================================

async function loadEvents() {
  const container = $('eventsListContainer');
  if (container) {
    container.innerHTML = '<div class="text-center py-8 text-slate-400 text-xs">読み込み中…</div>';
  }
  const res = await api('getEvents', { pairId: state.pairId });
  if (!res.success) {
    if (container) container.innerHTML = `<div class="text-center py-8 text-rose-500 text-xs">${res.error || 'イベントの取得に失敗しました'}</div>`;
    return;
  }
  state.events = res.events || [];
  renderEventsList();
}

function renderEventsList() {
  const container = $('eventsListContainer');
  if (!container) return;
  if (state.events.length === 0) {
    container.innerHTML = `
      <div class="text-center py-12 bg-white rounded-2xl border border-slate-100 p-6 space-y-2">
        <div class="w-12 h-12 bg-indigo-50 text-indigo-500 rounded-full flex items-center justify-center mx-auto text-xl">✈️</div>
        <h4 class="text-xs font-bold text-slate-700">登録されているイベントはありません</h4>
        <p class="text-[11px] text-slate-400 max-w-xs mx-auto">旅行やBBQ、飲み会などの立替精算を始めるには「イベント作成」を押してください。</p>
      </div>`;
    return;
  }

  container.innerHTML = state.events.map(ev => {
    const membersBadge = (ev.members || []).map(m => `<span class="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-[10px] font-bold">${escapeHtml(m)}</span>`).join(' ');
    const isWarning = ev.daysLeft <= 7;
    return `
      <div onclick="openEventDetail('${ev.id}')" class="bg-white hover:bg-slate-50 border border-slate-100 rounded-2xl p-4 shadow-sm cursor-pointer transition-all active:scale-[0.99] space-y-2.5">
        <div class="flex items-start justify-between">
          <div>
            <h3 class="text-sm font-extrabold text-slate-800">${escapeHtml(ev.title)}</h3>
            <div class="flex items-center gap-1.5 mt-1">
              <span class="${isWarning ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-800'} text-[10px] font-extrabold px-1.5 py-0.5 rounded">
                ⏳ あと${ev.daysLeft}日で自動消去
              </span>
              <span class="text-[10px] text-slate-400">${ev.createdAt}作成</span>
            </div>
          </div>
          <div class="text-right">
            <span class="text-[10px] text-slate-400 block font-bold">立替合計</span>
            <span class="text-base font-black text-indigo-700 font-mono">¥${(ev.totalAmount || 0).toLocaleString()}</span>
          </div>
        </div>
        <div class="flex items-center justify-between pt-1 border-t border-slate-50 text-xs">
          <div class="flex flex-wrap gap-1 items-center">
            <span class="text-[10px] text-slate-400">参加:</span>
            ${membersBadge}
          </div>
          <span class="text-[10px] text-indigo-500 font-bold flex items-center gap-0.5">
            精算・明細 (${ev.expenseCount || 0}件) <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
          </span>
        </div>
      </div>
    `;
  }).join('');
  lucide.createIcons();
}

function openCreateEventModal() {
  if ($('eventTitleInput')) $('eventTitleInput').value = '';
  if ($('eventMembersInput')) $('eventMembersInput').value = `${state.config.husbandName || 'メンバー1'}, ${state.config.wifeName || 'メンバー2'}`;
  $('createEventModal')?.classList.remove('hidden');
  lucide.createIcons();
}

function closeCreateEventModal() {
  $('createEventModal')?.classList.add('hidden');
}

async function submitCreateEvent() {
  const title = $('eventTitleInput')?.value.trim();
  const rawMembers = $('eventMembersInput')?.value.trim();
  if (!title || !rawMembers) {
    showToast('イベント名と参加メンバーを入力してください');
    return;
  }
  const members = rawMembers.split(/[,、\s]+/).map(m => m.trim()).filter(Boolean);
  if (members.length < 2) {
    showToast('参加メンバーは2名以上入力してください');
    return;
  }

  showToast('イベントを作成中…', 'loading');
  const res = await api('createEvent', { title, members, pairId: state.pairId });
  hideToast();
  if (!res.success) {
    showToast(res.error || '作成に失敗しました');
    return;
  }
  closeCreateEventModal();
  showToast(`イベント「${title}」を作成しました！`);
  loadEvents();
}

async function openEventDetail(eventId) {
  state.activeEventId = eventId;
  showToast('精算データを取得中…', 'loading');
  const res = await api('getEventSettlement', { eventId });
  hideToast();
  if (!res.success) {
    showToast(res.error || '精算データの取得に失敗しました');
    return;
  }
  state.currentSettlement = res;
  renderEventDetail(res);
  $('eventDetailModal')?.classList.remove('hidden');
  lucide.createIcons();
}

function closeEventDetailModal() {
  $('eventDetailModal')?.classList.add('hidden');
  state.activeEventId = null;
  state.currentSettlement = null;
}

function renderEventDetail(s) {
  const ev = s.event;
  if ($('detailEventTitle')) $('detailEventTitle').textContent = ev.title;
  if ($('detailEventDaysLeft')) $('detailEventDaysLeft').textContent = `⏳ 残り${ev.daysLeft}日で消去`;
  if ($('detailEventDate')) $('detailEventDate').textContent = `${ev.createdAt}作成`;

  // 1. 最小送金ステップ（スマート精算）
  const transfersContainer = $('settlementTransfersContainer');
  if (transfersContainer) {
    if (!s.transfers || s.transfers.length === 0) {
      transfersContainer.innerHTML = '<p class="text-indigo-200 text-xs py-1">精算は完了しています（差額なし）✨</p>';
    } else {
      transfersContainer.innerHTML = s.transfers.map(t => `
        <div class="flex items-center justify-between bg-white/10 rounded-xl px-3 py-2 font-bold">
          <div class="flex items-center gap-1.5">
            <span class="text-rose-300">${escapeHtml(t.from)}</span>
            <span class="text-indigo-300">➡️</span>
            <span class="text-emerald-300">${escapeHtml(t.to)}</span>
          </div>
          <span class="text-brand-300 font-mono text-sm">¥${t.amount.toLocaleString()}</span>
        </div>
      `).join('');
    }
  }

  // 2. メンバー別集計
  const memberContainer = $('memberSummariesContainer');
  if (memberContainer) {
    memberContainer.innerHTML = (s.memberSummaries || []).map(m => {
      const isPlus = m.balance > 0;
      const isMinus = m.balance < 0;
      const color = isPlus ? 'text-emerald-600 bg-emerald-50' : (isMinus ? 'text-rose-600 bg-rose-50' : 'text-slate-500 bg-slate-50');
      const label = isPlus ? `+¥${m.balance.toLocaleString()} 受取` : (isMinus ? `-¥${(-m.balance).toLocaleString()} 支払` : '±0円');
      return `
        <div class="bg-slate-50 border border-slate-100 rounded-xl p-2.5 space-y-1">
          <div class="flex items-center justify-between font-bold">
            <span class="text-slate-800">${escapeHtml(m.name)}</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded font-black ${color}">${label}</span>
          </div>
          <div class="text-[10px] text-slate-500 flex justify-between">
            <span>立替: ¥${m.paid.toLocaleString()}</span>
            <span>負担: ¥${m.shouldPay.toLocaleString()}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // 3. 支出明細リスト
  const expensesList = $('eventExpensesList');
  if (expensesList) {
    if (!s.expenses || s.expenses.length === 0) {
      expensesList.innerHTML = '<p class="text-slate-400 text-center py-4 text-xs">まだ立替支出はありません。「立替を登録」から追加してください。</p>';
    } else {
      expensesList.innerHTML = s.expenses.map(x => `
        <div class="flex items-center justify-between bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 text-xs">
          <div>
            <span class="font-bold text-slate-800 block">${escapeHtml(x.title)}</span>
            <span class="text-[10px] text-slate-400">${x.createdAt} / 払った人: <b class="text-slate-600">${escapeHtml(x.payer)}</b></span>
          </div>
          <div class="flex items-center gap-2">
            <span class="font-mono font-bold text-slate-900">¥${x.amount.toLocaleString()}</span>
            <button onclick="deleteEventExpenseById('${x.id}')" class="text-slate-300 hover:text-rose-500 p-1">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>
      `).join('');
    }
  }

  // イベント削除ボタンのバインド
  const delBtn = $('deleteEventBtn');
  if (delBtn) {
    delBtn.onclick = () => {
      if (confirm(`イベント「${ev.title}」を削除しますか？\n（関連するすべての立替明細も削除されます）`)) {
        deleteEventById(ev.id);
      }
    };
  }

  lucide.createIcons();
}

function copySettlementText() {
  const s = state.currentSettlement;
  if (!s || !s.event) return;
  const ev = s.event;
  const transferLines = (s.transfers || []).length > 0
    ? s.transfers.map(t => `・${t.from} ➡️ ${t.to}：¥${t.amount.toLocaleString()}`).join('\n')
    : '・精算完了（差額なし）';

  const memberLines = (s.memberSummaries || []).map(m => {
    const diff = m.balance > 0 ? `+¥${m.balance.toLocaleString()}` : (m.balance < 0 ? `-¥${(-m.balance).toLocaleString()}` : '±0');
    return `・${m.name}: 支払¥${m.paid.toLocaleString()} (差引 ${diff})`;
  }).join('\n');

  const text = `✈️【${ev.title} 精算サマリー】\n` +
    `━━━━━━━━━━━━━━\n` +
    `■ 最小送金ステップ\n${transferLines}\n` +
    `━━━━━━━━━━━━━━\n` +
    `■ 各自の立替状況\n${memberLines}\n` +
    `━━━━━━━━━━━━━━\n` +
    `ふたり家計簿 (PairBudget)`;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('精算テキストをコピーしました！LINEに貼り付けて共有してください');
    }).catch(() => {
      prompt('以下の精算テキストをコピーしてください:', text);
    });
  } else {
    prompt('以下の精算テキストをコピーしてください:', text);
  }
}

function openAddEventExpenseModal() {
  const s = state.currentSettlement;
  if (!s || !s.event) return;
  const members = s.event.members || [];

  if ($('eventExpenseTitleInput')) $('eventExpenseTitleInput').value = '';
  if ($('eventExpenseAmountInput')) $('eventExpenseAmountInput').value = '';

  const payerSelect = $('eventExpensePayerSelect');
  if (payerSelect) {
    payerSelect.innerHTML = members.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
  }

  const benContainer = $('eventExpenseBeneficiariesContainer');
  if (benContainer) {
    benContainer.innerHTML = members.map(m => `
      <label class="inline-flex items-center gap-1.5 bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer">
        <input type="checkbox" name="beneficiary" value="${escapeHtml(m)}" checked class="w-3.5 h-3.5 text-indigo-600 rounded">
        <span>${escapeHtml(m)}</span>
      </label>
    `).join('');
  }

  $('addEventExpenseModal')?.classList.remove('hidden');
  lucide.createIcons();
}

function closeAddEventExpenseModal() {
  $('addEventExpenseModal')?.classList.add('hidden');
}

async function submitAddEventExpense() {
  const eventId = state.activeEventId;
  const title = $('eventExpenseTitleInput')?.value.trim();
  const amount = Number($('eventExpenseAmountInput')?.value);
  const payer = $('eventExpensePayerSelect')?.value;

  if (!title || !amount || amount <= 0) {
    showToast('品名と金額を入力してください');
    return;
  }

  const checkboxes = document.querySelectorAll('input[name="beneficiary"]:checked');
  const beneficiaries = Array.from(checkboxes).map(c => c.value);

  showToast('立替を記録中…', 'loading');
  const res = await api('addEventExpense', {
    eventId,
    title,
    amount,
    payer,
    beneficiaries: beneficiaries.length > 0 ? beneficiaries : null
  });
  hideToast();

  if (!res.success) {
    showToast(res.error || '記録に失敗しました');
    return;
  }
  closeAddEventExpenseModal();
  showToast('立替を記録しました！');
  openEventDetail(eventId);
}

async function deleteEventExpenseById(expenseId) {
  if (!confirm('この立替明細を削除しますか？')) return;
  showToast('削除中…', 'loading');
  const res = await api('deleteEventExpense', { expenseId });
  hideToast();
  if (res.success) {
    showToast('立替明細を削除しました');
    openEventDetail(state.activeEventId);
  } else {
    showToast(res.error || '削除に失敗しました');
  }
}

async function deleteEventById(eventId) {
  showToast('イベントを削除中…', 'loading');
  const res = await api('deleteEvent', { eventId });
  hideToast();
  if (res.success) {
    closeEventDetailModal();
    showToast('イベントを削除しました');
    loadEvents();
  } else {
    showToast(res.error || '削除に失敗しました');
  }
}

function checkUrlInviteParam() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const invite = urlParams.get('invite');
    if (invite) {
      const code = invite.toUpperCase().trim();
      if ($('joinInviteCodeInput')) $('joinInviteCodeInput').value = code;
      openRegisterModal({ inviteCode: code });
      showToast(`招待コード「${code}」を検出しました`);
    } else if (!localStorage.getItem('pairbudget_pair_id')) {
      // 初回訪問時（ペア未設定）は自動でグループ作成/参加モーダルを案内
      openRegisterModal();
    }
  } catch (_) {}
}

document.addEventListener('DOMContentLoaded', async () => {
  initMembers();
  lucide.createIcons();
  setupEventListeners();
  updatePairHeader();
  applyMemberColors();
  checkUrlInviteParam();
  // 起動直後にローカルキャッシュがあれば即座に描画して白画面待ちをゼロにする
  const cached = loadInitCache(state.viewMonth);
  if (cached && state.gasApiUrl) applyData(cached);
  if ((await initLiff()) === 'redirect') return;
  await loadInitialData(state.viewMonth, { skipCache: !!cached });
});
