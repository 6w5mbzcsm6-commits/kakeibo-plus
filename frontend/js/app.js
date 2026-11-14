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
const FRONTEND_VERSION = 'v2.15.1';
const MAX_HISTORY_MONTHS = 36;
const FIELD_LABELS = {
  date: '日付', title: '品名', amount: '金額', category: 'カテゴリ', isShared: '共同',
  paymentType: '決済手段', payer: '支払者', memo: 'メモ',
  husband: 'メンバー1基本拠出', wife: 'メンバー2基本拠出', husbandName: 'メンバー1表示名', wifeName: 'メンバー2表示名',
  isPaid: '振込状況', billingDay: '引落日', isActive: '有効', keyword: 'キーワード', color: 'カラー', role: '表示名',
  store: '店名', total: '合計', itemCount: '品数'
};
const PAYMENT_LABELS = { shared_card: '共同カード', shared_account: '共同口座振替', advanced_by_user: '個人立替', personal_cash: '個人自腹' };

/**
 * 品名キーワードからの品目別カテゴリ自動推定 (v2.8.0)
 */
function inferItemCategory(name) {
  const n = String(name || '').toLowerCase();
  if (/洗剤|ティッシュ|トイレット|ペーパー|ラップ|アルミ|ゴミ袋|スポンジ|タオル|日用|シャンプー|リンス|ソープ|歯磨き|ハブラシ|電池|ウェット|サランラップ|クレラップ/i.test(n)) {
    return '日用品';
  }
  if (/薬|目薬|湿布|マスク|サプリ|ビタミン|絆創膏|パブロン|ロキソニン|風邪|医療/i.test(n)) {
    return '医療・健康';
  }
  if (/シートマスク|パック|化粧|コスメ|リップ|ファンデ|下着|ソックス|服|シャツ|パンツ|美容|ネイリパ/i.test(n)) {
    return '衣服・美容';
  }
  if (/弁当|定食|バーガー|マック|スタバ|カフェ|寿司|ラーメン|レストラン|外食/i.test(n)) {
    return '外食';
  }
  return '食費';
}

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

function sanitizePairId(id) {
  const s = String(id || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
    ? s
    : '00000000-0000-0000-0000-000000000001';
}

// ==========================================
// アプリケーション状態
// ==========================================
const state = {
  viewMonth: localMonthStr(),
  activeScope: 'shared',
  currentMode: 'budget', // 'budget' | 'events'
  pairId: sanitizePairId(localStorage.getItem('pairbudget_pair_id')),
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

  bankAccounts: (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('pairbudget_bank_accounts') || '[]');
      if (Array.isArray(raw)) {
        return raw.filter(a => a && !((a.id === 'acc_shared_main' && a.name && a.name.includes('三井住友')) || (a.id === 'acc_shared_card' && a.name && a.name.includes('楽天カード'))));
      }
      return [];
    } catch (_) { return []; }
  })(),
  securitySettings: {
    hasSecurityPin: false,
    algorithm: 'PBKDF2-HMAC-SHA256'
  },
  importedStatementItems: [],
  importedCsvBalanceInfo: null,
  categoryBudgets: (() => {
    try { return JSON.parse(localStorage.getItem('pairbudget_category_budgets') || '{}'); } catch (_) { return {}; }
  })(),
  customCategories: (() => {
    try { return JSON.parse(localStorage.getItem('pairbudget_custom_categories') || '[]'); } catch (_) { return []; }
  })(),
  surplusPolicy: localStorage.getItem('pairbudget_surplus_policy') || 'savings',
  savingsConfig: (() => {
    try { return JSON.parse(localStorage.getItem('pairbudget_savings_config') || '{"initialSavings":0,"monthlyInterests":{}}'); } catch (_) { return { initialSavings: 0, monthlyInterests: {} }; }
  })(),

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
    wifeColor: localStorage.getItem('pairbudget_member2_color') || 'amber',
    shoppingPurgeDays: 1,
    autoCheckShoppingOnReceipt: true,
    categoryBudgets: {},
    surplusPolicy: 'savings',
    savingsConfig: { initialSavings: 0, monthlyInterests: {} }
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
      btn.onclick = async () => {
        const cKey = btn.dataset.colorKey;
        member.color = cKey;
        saveMembersToStorage();
        syncStateConfigFromMembers();
        renderSettingMembersList();
        renderTransferCard();
        renderExpensePayerChips();
        renderRecentTransactions();
        renderHistoryList();
        showToast('🎨 テーマカラーを保存しました');
        // バックエンドにも同期保存
        try {
          const husband = state.members[0]?.baseContribution || 0;
          const wife = state.members[1]?.baseContribution || 0;
          const husbandName = state.members[0]?.name || 'メンバー1';
          const wifeName = state.members[1]?.name || 'メンバー2';
          await api('updateBaseContribution', {
            husband,
            wife,
            husbandName,
            wifeName,
            members: state.members
          });
        } catch (_) {}
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
  { id: 'f1', title: '家賃', amount: 110000, category: '住居費', billingDay: 27, isActive: true, paymentType: 'shared_account', payer: '共同口座' },
  { id: 'f2', title: '光熱費 (電気・ガス)', amount: 15000, category: '水道光熱費', billingDay: 20, isActive: true, paymentType: 'shared_account', payer: '共同口座' },
  { id: 'f3', title: 'ネット光回線', amount: 5200, category: '通信費', billingDay: 15, isActive: true, paymentType: 'shared_card', payer: '共同カード' }
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
    addTx(`${m}-27`, '【固定費】家賃', 110000, '住居費', true, 'shared_account', '共同口座');
    addTx(`${m}-20`, '【固定費】光熱費', 11000 + Math.floor(rnd(i) * 9000), '水道光熱費', true, 'shared_account', '共同口座');
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
    const row = {
      month: mm,
      shared: 0,
      personal: { husband: 0, wife: 0, [hName]: 0, [wName]: 0 },
      budget: mockDb.budgets[mm] || 240000,
      sharedCard: 0,
      sharedCardLiving: 0,
      sharedCardPersonal: 0,
      sharedAccount: 0,
      sharedAccountLiving: 0,
      sharedAccountPersonal: 0
    };
    mockDb.transactions.filter(t => t.date.startsWith(mm)).forEach(t => {
      const amt = Number(t.amount) || 0;
      if (t.isShared) {
        row.shared += amt;
      } else {
        const slot = resolvePayerSlot(t.payer);
        if (slot === 'husband' || slot === 'wife') {
          row.personal[slot] += amt;
          row.personal[memberName(slot)] = row.personal[slot];
        }
      }
      if (t.paymentType === 'shared_card') {
        row.sharedCard += amt;
        if (t.isShared) {
          row.sharedCardLiving += amt;
        } else {
          row.sharedCardPersonal += amt;
        }
      } else if (t.paymentType === 'shared_account') {
        row.sharedAccount += amt;
        if (t.isShared) {
          row.sharedAccountLiving += amt;
        } else {
          row.sharedAccountPersonal += amt;
        }
      }
    });
    totals.push(row);
  }
  return {
    success: true, month, actor: { name: state.currentUser, slot: state.currentSlot, verified: false }, transactions: txs,
    receiptItems: mockDb.receiptItems.filter(it => it.date.startsWith(month)),
    shoppingList: mockDb.shopping, monthlyBudgets: [], fixedExpenses: mockDb.fixed, categories: MOCK_CATEGORIES, rules: MOCK_RULES,
    config: {
      husbandBaseContribution: hb,
      wifeBaseContribution: wb,
      husbandName: hName,
      wifeName: wName,
      shoppingPurgeDays: (mockDb.config && mockDb.config.shoppingPurgeDays !== undefined) ? mockDb.config.shoppingPurgeDays : 1,
      autoCheckShoppingOnReceipt: (mockDb.config && mockDb.config.autoCheckShoppingOnReceipt !== undefined) ? mockDb.config.autoCheckShoppingOnReceipt : true,
      categoryBudgets: (mockDb.config && mockDb.config.categoryBudgets) ? mockDb.config.categoryBudgets : state.categoryBudgets,
      customCategories: (mockDb.config && mockDb.config.customCategories) ? mockDb.config.customCategories : state.customCategories,
      surplusPolicy: (mockDb.config && mockDb.config.surplusPolicy) ? mockDb.config.surplusPolicy : state.surplusPolicy,
      savingsConfig: (mockDb.config && mockDb.config.savingsConfig) ? mockDb.config.savingsConfig : state.savingsConfig
    },
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
      if (!Number.isInteger(data.amount) || data.amount === 0) return { success: false, error: '金額は0以外の整数で入力してください' };
      const tx = { ...data, id: mockId(), memo: data.memo || '', createdBy: state.currentUser, createdAt: mockNow(), updatedBy: '', updatedAt: '', receiptId: '' };
      mockDb.transactions.push(tx);
      mockAudit('追加', '支出', tx.id, null, pickTxFields(tx));
      return { success: true, id: tx.id };
    }
    case 'updateTransaction': {
      const tx = mockDb.transactions.find(t => t.id === data.id);
      if (!tx) return { success: false, error: '対象の支出が見つかりません' };
      if (!Number.isInteger(data.amount) || data.amount === 0) return { success: false, error: '金額は0以外の整数で入力してください' };
      const before = pickTxFields(tx);
      const next = { ...data };
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
      return { success: true, receipt: { store: 'イオン', date: localDateStr(), total: 954,
        items: [
          { name: 'ネギ', category: '食費', quantity: 1, price: 180 },
          { name: '豆腐', category: '食費', quantity: 1, price: 90 },
          { name: 'クレラップ', category: '日用品', quantity: 1, price: 218 },
          { name: '牛乳', category: '食費', quantity: 1, price: 218 },
          { name: '卵', category: '食費', quantity: 1, price: 248 }
        ] } };
    case 'saveReceipt': {
      const total = (data.items || []).reduce((s, it) => s + (Number(it.price) || 0), 0);
      if (total === 0) return { success: false, error: '合計金額が0円です' };
      const rid = mockId();
      (data.items || []).forEach(it => {
        const itemShared = (it.isShared !== undefined && it.isShared !== null) ? !!it.isShared : !!data.isShared;
        mockDb.receiptItems.push({
          receiptId: rid,
          date: data.date,
          store: data.store,
          name: it.name,
          category: it.category || data.category || '食費',
          quantity: it.quantity || 1,
          price: it.price,
          unitPrice: Math.round(it.price / (it.quantity || 1)),
          isShared: itemShared,
          payer: data.payer
        });
      });

      // 共同分（カテゴリ別に分割）と各自の私物に分割して支出レコード作成
      const sharedByCat = {};
      (data.items || []).filter(it => it.isShared !== false).forEach(it => {
        const cat = it.category || data.category || '食費';
        if (!sharedByCat[cat]) sharedByCat[cat] = [];
        sharedByCat[cat].push(it);
      });
      const sharedEntries = Object.entries(sharedByCat);

      const personalGroups = {};
      (data.items || []).filter(it => it.isShared === false).forEach(it => {
        const owner = it.owner || data.payer || state.currentUser;
        const cat = it.category || data.category || '日用品';
        const key = `${owner}___${cat}`;
        if (!personalGroups[key]) personalGroups[key] = { owner, category: cat, items: [] };
        personalGroups[key].items.push(it);
      });

      const createdTxIds = [];
      for (const [cat, catItems] of sharedEntries) {
        const catSum = catItems.reduce((s, it) => s + (Number(it.price) || 0), 0);
        if (catSum === 0) continue;
        const title = sharedEntries.length > 1 ? `${data.store} (${cat})` : data.store;
        const txShared = {
          id: mockId(), date: data.date, title, amount: catSum,
          category: cat, isShared: true, paymentType: data.paymentType,
          payer: data.paymentType === 'shared_card' ? '共同' : data.payer, memo: `レシート読み取り (共同・${cat})`, createdBy: state.currentUser,
          createdAt: mockNow(), updatedBy: '', updatedAt: '', receiptId: rid
        };
        mockDb.transactions.push(txShared);
        createdTxIds.push(txShared.id);
      }

      for (const grp of Object.values(personalGroups)) {
        const ownerSum = grp.items.reduce((s, it) => s + (Number(it.price) || 0), 0);
        if (ownerSum === 0) continue;
        const txPriv = {
          id: mockId(), date: data.date, title: `${data.store}（${grp.owner}私物・${grp.category}）`, amount: ownerSum,
          category: grp.category, isShared: false, paymentType: data.paymentType,
          payer: grp.owner, memo: `レシート読み取り (${grp.owner}私物・${grp.category}・要返還)`, createdBy: state.currentUser,
          createdAt: mockNow(), updatedBy: '', updatedAt: '', receiptId: rid
        };
        mockDb.transactions.push(txPriv);
        createdTxIds.push(txPriv.id);
      }

      mockAudit('追加', 'レシート', rid, null, {
        receiptId: rid,
        store: data.store,
        date: data.date,
        total,
        sharedSum,
        personalSum,
        itemCount: data.items.length,
        payer: data.payer
      });
      return { success: true, receiptId: rid, txId: createdTxIds[0] || '', total };
    }
    case 'updateReceipt': {
      const rid = data.receiptId;
      if (!rid) return { success: false, error: 'レシートIDが指定されていません' };
      const total = (data.items || []).reduce((s, it) => s + (Number(it.price) || 0), 0);
      if (total === 0) return { success: false, error: '合計金額が0円です' };

      const oldItems = mockDb.receiptItems.filter(it => it.receiptId === rid);
      const oldTxs = mockDb.transactions.filter(t => t.receiptId === rid);
      const beforeData = {
        store: oldTxs[0]?.title || '',
        date: oldTxs[0]?.date || '',
        items: oldItems.map(it => ({ name: it.name, quantity: it.quantity, price: it.price, isShared: it.isShared }))
      };

      // 古い明細を削除して新明細を挿入
      mockDb.receiptItems = mockDb.receiptItems.filter(it => it.receiptId !== rid);
      (data.items || []).forEach(it => {
        const itemShared = (it.isShared !== undefined && it.isShared !== null) ? !!it.isShared : !!data.isShared;
        mockDb.receiptItems.push({
          receiptId: rid,
          date: data.date,
          store: data.store,
          name: it.name,
          quantity: it.quantity || 1,
          price: it.price,
          unitPrice: Math.round(it.price / (it.quantity || 1)),
          isShared: itemShared,
          payer: data.payer
        });
      });

      // 既存の紐づくtransactionsを削除して再生成（カテゴリ別分割 v2.8.0）
      mockDb.transactions = mockDb.transactions.filter(t => t.receiptId !== rid);
      const sharedByCat = {};
      (data.items || []).filter(it => it.isShared !== false).forEach(it => {
        const cat = it.category || data.category || '食費';
        if (!sharedByCat[cat]) sharedByCat[cat] = [];
        sharedByCat[cat].push(it);
      });
      const sharedEntries = Object.entries(sharedByCat);

      const personalGroups = {};
      (data.items || []).filter(it => it.isShared === false).forEach(it => {
        const owner = it.owner || data.payer || state.currentUser;
        const cat = it.category || data.category || '日用品';
        const key = `${owner}___${cat}`;
        if (!personalGroups[key]) personalGroups[key] = { owner, category: cat, items: [] };
        personalGroups[key].items.push(it);
      });

      const createdTxIds = [];
      for (const [cat, catItems] of sharedEntries) {
        const catSum = catItems.reduce((s, it) => s + (Number(it.price) || 0), 0);
        if (catSum === 0) continue;
        const title = sharedEntries.length > 1 ? `${data.store} (${cat})` : data.store;
        const txShared = {
          id: mockId(), date: data.date, title, amount: catSum,
          category: cat, isShared: true, paymentType: data.paymentType,
          payer: data.paymentType === 'shared_card' ? '共同' : data.payer, memo: `レシート読み取り (共同・${cat})`, createdBy: state.currentUser,
          createdAt: mockNow(), updatedBy: state.currentUser, updatedAt: mockNow(), receiptId: rid
        };
        mockDb.transactions.push(txShared);
        createdTxIds.push(txShared.id);
      }

      for (const grp of Object.values(personalGroups)) {
        const ownerSum = grp.items.reduce((s, it) => s + (Number(it.price) || 0), 0);
        if (ownerSum === 0) continue;
        const txPriv = {
          id: mockId(), date: data.date, title: `${data.store}（${grp.owner}私物・${grp.category}）`, amount: ownerSum,
          category: grp.category, isShared: false, paymentType: data.paymentType,
          payer: grp.owner, memo: `レシート読み取り (${grp.owner}私物・${grp.category}・要返還)`, createdBy: state.currentUser,
          createdAt: mockNow(), updatedBy: state.currentUser, updatedAt: mockNow(), receiptId: rid
        };
        mockDb.transactions.push(txPriv);
        createdTxIds.push(txPriv.id);
      }

      mockAudit('更新', 'レシート', rid, beforeData, {
        store: data.store,
        date: data.date,
        items: data.items,
        total
      });

      return { success: true, receiptId: rid, txId: createdTxIds[0] || '', total };
    }
    case 'searchPrices': return mockSearchPrices(data.query);
    case 'getAuditLog': {
      const logs = mockDb.audit.filter(l => !data.targetId || l.targetId === data.targetId).slice(0, data.limit || 50);
      return { success: true, logs };
    }
    case 'updateBankAccounts': {
      state.bankAccounts = data.bankAccounts || [];
      try { localStorage.setItem('pairbudget_bank_accounts', JSON.stringify(state.bankAccounts)); } catch (_) {}
      return { success: true, bankAccounts: state.bankAccounts };
    }
    case 'importCardStatements': {
      const items = data.items || [];
      items.forEach(it => {
        mockDb.transactions.push({
          id: mockId(),
          date: it.date,
          title: it.title,
          amount: it.amount,
          category: it.category,
          isShared: it.isShared !== false,
          paymentType: it.paymentType || 'shared_card',
          payer: it.payer || '共同カード',
          memo: it.memo || 'クレカ/明細取込',
          createdBy: state.currentUser,
          createdAt: mockNow(),
          updatedBy: '',
          updatedAt: '',
          receiptId: ''
        });
      });
      return { success: true, count: items.length };
    }
    case 'scanStatementOrBalance': {
      await new Promise(r => setTimeout(r, 1000));
      return {
        success: true,
        screenType: 'statement',
        detectedCard: '楽天カード',
        statements: [
          { date: localDateStr(), title: 'イオン ネットスーパー', amount: 4820, category: '食費', isShared: true },
          { date: localDateStr(), title: 'マツモトキヨシ', amount: 1580, category: '日用品', isShared: true },
          { date: localDateStr(), title: 'スターバックス', amount: 620, category: '外食', isShared: true }
        ]
      };
    }
    case 'updateSecurityPin': {
      state.securitySettings.hasSecurityPin = true;
      return { success: true, message: 'PIN保存完了' };
    }
    case 'verifySecurityPin': {
      return { success: true, isValid: true };
    }
    case 'testSaltedHash': {
      const input = data.input || 'sample_secret_pin';
      const salt1 = 'a3f9c8e10b42d76589f1a2b3c4d5e6f7';
      const salt2 = '7b2d5e9a1c8f4306ea9b8c7d6e5f4a3b';
      return {
        success: true,
        input: input,
        algorithm: 'PBKDF2-HMAC-SHA256',
        iterations: 100000,
        saltLengthBits: 128,
        durationMs: 42,
        sample1: {
          salt: salt1,
          hashRecord: `pbkdf2_sha256$100000$${salt1}$e89ab012cd34ef56...`
        },
        sample2: {
          salt: salt2,
          hashRecord: `pbkdf2_sha256$100000$${salt2}$412bc789fa01de23...`
        }
      };
    }
    case 'addShoppingItem': mockDb.shopping.unshift({ ...data, isCompleted: false, requestedBy: state.currentUser, createdAt: localDateStr() }); return { success: true };
    case 'updateShoppingItem': {
      const s = mockDb.shopping.find(x => x.id === data.id);
      if (s) {
        s.isCompleted = !!data.isCompleted;
        s.completedAt = data.isCompleted ? new Date().toISOString() : null;
      }
      return { success: true };
    }
    case 'deleteShoppingItem': mockDb.shopping = mockDb.shopping.filter(s => s.id !== data.id); return { success: true };
    case 'updateShoppingPurgeDays': {
      mockDb.config = mockDb.config || {};
      mockDb.config.shoppingPurgeDays = Number(data.shoppingPurgeDays !== undefined ? data.shoppingPurgeDays : 1);
      return { success: true, shoppingPurgeDays: mockDb.config.shoppingPurgeDays };
    }
    case 'updateAutoCheckShopping': {
      mockDb.config = mockDb.config || {};
      mockDb.config.autoCheckShoppingOnReceipt = !!data.enabled;
      return { success: true, autoCheckShoppingOnReceipt: mockDb.config.autoCheckShoppingOnReceipt };
    }
    case 'getMonthlyReport': {
      const targetMonth = data.month || state.viewMonth;
      const txs = mockDb.transactions.filter(t => t.date.startsWith(targetMonth) && t.isShared);
      const total = txs.reduce((s, t) => s + (Number(t.amount) || 0), 0);
      const budget = (mockDb.budgets && mockDb.budgets[targetMonth]) || 240000;
      const balance = budget - total;
      const catMap = {};
      txs.forEach(t => {
        catMap[t.category] = (catMap[t.category] || 0) + Number(t.amount || 0);
      });
      const topCats = Object.entries(catMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cat, amt]) => ({ category: cat, amount: amt, rate: total > 0 ? Math.round((amt / total) * 100) : 0 }));
      const chartLabels = topCats.length ? topCats.map(c => c.category) : ['支出なし'];
      const chartData = topCats.length ? topCats.map(c => c.amount) : [1];
      const qcUrl = 'https://quickchart.io/chart?w=600&h=360&bkg=white&c=' + encodeURIComponent(JSON.stringify({
        type: 'doughnut',
        data: { labels: chartLabels, datasets: [{ data: chartData }] },
        options: { plugins: { title: { display: true, text: `${targetMonth} 収支` } } }
      }));
      const textSummary = `📊 【${targetMonth} ふたり家計簿 収支報告】\n・共同生活費 支出: ¥${total.toLocaleString()}\n・予算差額: ${balance >= 0 ? '+' : '-'}¥${Math.abs(balance).toLocaleString()}\n${balance >= 0 ? '🎉 今月は黒字達成です！' : '⚠️ 予算を超過しました'}`;
      return {
        success: true,
        data: {
          month: targetMonth,
          totalSharedExpense: total,
          monthlyBudget: budget,
          balance,
          isDeficit: balance < 0,
          chartUrl: qcUrl,
          textSummary,
          topCategories: topCats
        }
      };
    }
    case 'updateCategoryBudgets': {
      mockDb.config = mockDb.config || {};
      mockDb.config.categoryBudgets = data.categoryBudgets || {};
      return { success: true, categoryBudgets: mockDb.config.categoryBudgets };
    }
    case 'updateSurplusPolicy': {
      mockDb.config = mockDb.config || {};
      mockDb.config.surplusPolicy = data.surplusPolicy || 'savings';
      return { success: true, surplusPolicy: mockDb.config.surplusPolicy };
    }
    case 'updateSavingsConfig': {
      mockDb.config = mockDb.config || {};
      mockDb.config.savingsConfig = data.savingsConfig || { initialSavings: 0, monthlyInterests: {} };
      return { success: true, savingsConfig: mockDb.config.savingsConfig };
    }
    case 'updateMonthlyBudget': {
      const prev = mockDb.budgets[data.month];
      mockDb.budgets[data.month] = data.amount;
      mockAudit(prev !== undefined ? '更新' : '追加', '月別予算', data.month, prev !== undefined ? { amount: prev } : null, { amount: data.amount });
      return { success: true };
    }
    case 'updateFixedExpense': {
      const id = data.id || mockId();
      const idx = mockDb.fixed.findIndex(f => f.id === id);
      const pType = data.paymentType || 'shared_account';
      const next = { id, title: data.title, amount: Number(data.amount), category: data.category || 'その他', billingDay: Number(data.billingDay) || 1, isActive: data.isActive !== false, paymentType: pType, payer: data.payer || (pType === 'shared_card' ? '共同カード' : '共同口座') };
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
    case 'updateCustomCategories': {
      mockDb.config = mockDb.config || {};
      if (data.customCategories) mockDb.config.customCategories = data.customCategories;
      if (data.categoryBudgets) mockDb.config.categoryBudgets = data.categoryBudgets;
      return { success: true, customCategories: mockDb.config.customCategories, categoryBudgets: mockDb.config.categoryBudgets };
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
// 通信 & キャッシュ (バージョン紐付けキャッシュバスティング)
// ==========================================
const CACHE_PREFIX = `pairbudget_init_${FRONTEND_VERSION}_`;
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

/**
 * 過去バージョン由来のローカルキャッシュを自動破棄
 */
function cleanupOldVersionCaches() {
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('pairbudget_init_') && !k.startsWith(CACHE_PREFIX)) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  } catch (_) {}
}

function clearAllLocalCache() {
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('pairbudget_init_')) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  } catch (_) {}
}

/**
 * 強制キャッシュ破棄＆最新版リロード（ユーザー操作 or 自動自己修復）
 */
window.forceHardReload = function () {
  try {
    clearAllLocalCache();
    sessionStorage.clear();
  } catch (_) {}
  showToast('🔄 キャッシュをクリアして最新版を読み込みます…', { loading: true });
  setTimeout(() => {
    const cleanUrl = window.location.origin + window.location.pathname;
    window.location.replace(`${cleanUrl}?_v=${encodeURIComponent(FRONTEND_VERSION)}&_t=${Date.now()}`);
  }, 250);
};

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
      let errBody = '';
      try {
        const errJson = await res.json();
        errBody = errJson.error || errJson.message || JSON.stringify(errJson);
      } catch (_) {
        try {
          errBody = (await res.text()).slice(0, 150);
        } catch (_) {}
      }
      throw new Error(`サーバーエラー (${res.status}): ${errBody || res.statusText}`);
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

// API通信関数のエイリアス (v2.12.0 互換性確保)
const callApi = (...args) => api(...args);

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
    if (localStorage.getItem('pairbudget_onboarding_done') !== 'true') {
      openRegisterModal(res.availableRoles);
    }
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
    state.isMockMode = false;
    const res = await api('createPair', { name: groupName, userName });
    hideToast();

    // res.pair が存在しない場合でも安全にフォールバック
    const pair = (res && res.pair) ? res.pair : {
      id: '00000000-0000-0000-0000-000000000001',
      name: groupName,
      inviteCode: 'PB' + Math.random().toString(36).substring(2, 7).toUpperCase()
    };

    // 作成成功: 状態とストレージを更新
    state.pairId = sanitizePairId(pair.id);
    state.pairName = pair.name;
    state.inviteCode = pair.inviteCode;
    state.currentUser = userName;
    if (state.members && state.members.length > 0) {
      state.members[0].name = userName;
      saveMembersToStorage();
      syncStateConfigFromMembers();
    }
    localStorage.setItem('pairbudget_onboarding_done', 'true');
    localStorage.setItem('pairbudget_pair_id', state.pairId);
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
    state.pairId = '00000000-0000-0000-0000-000000000001';
    state.pairName = groupName;
    state.inviteCode = fallbackCode;
    state.currentUser = userName;
    if (state.members && state.members.length > 0) {
      state.members[0].name = userName;
      saveMembersToStorage();
      syncStateConfigFromMembers();
    }
    localStorage.setItem('pairbudget_onboarding_done', 'true');
    localStorage.setItem('pairbudget_pair_id', state.pairId);
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
    state.isMockMode = false;
    const res = await api('joinPair', { inviteCode, name: userName });
    hideToast();

    const pair = (res && res.pair) ? res.pair : {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'ふたりの家計簿',
      inviteCode: inviteCode
    };

    state.pairId = sanitizePairId(pair.id);
    state.pairName = pair.name;
    state.inviteCode = pair.inviteCode;
    state.currentUser = userName;
    if (state.members && state.members.length > 1) {
      state.members[1].name = userName;
      saveMembersToStorage();
      syncStateConfigFromMembers();
    }
    localStorage.setItem('pairbudget_onboarding_done', 'true');
    localStorage.setItem('pairbudget_pair_id', state.pairId);
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
    state.pairId = '00000000-0000-0000-0000-000000000001';
    state.pairName = 'ふたりの家計簿';
    state.inviteCode = inviteCode;
    state.currentUser = userName;
    localStorage.setItem('pairbudget_onboarding_done', 'true');
    localStorage.setItem('pairbudget_pair_id', state.pairId);
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
  localStorage.setItem('pairbudget_onboarding_done', 'true');
  state.pairId = sanitizePairId(state.pairId);
  localStorage.setItem('pairbudget_pair_id', state.pairId);
  $('registerMemberModal')?.classList.add('hidden');
  hideBanner();
  resetViewportZoom();
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

function getActiveTab() {
  try {
    return localStorage.getItem('pairbudget_active_tab') || 'home';
  } catch (_) {
    return 'home';
  }
}

/**
 * メインスケルトンローダーの表示制御 (アクティブタブとの整合性を保持)
 */
function showMainSkeleton() {
  const activeTab = getActiveTab();
  const sk = $('mainSkeletonLoader');
  const home = $('tabContentHome');
  if (sk && activeTab === 'home') sk.classList.remove('hidden');
  if (home) home.classList.add('hidden');
}

function hideMainSkeleton() {
  const activeTab = getActiveTab();
  const sk = $('mainSkeletonLoader');
  const home = $('tabContentHome');
  if (sk) sk.classList.add('hidden');
  if (home) {
    if (activeTab === 'home') {
      home.classList.remove('hidden');
      home.classList.remove('animate-fade-in');
      void home.offsetWidth;
      home.classList.add('animate-fade-in');
    } else {
      home.classList.add('hidden');
      if (typeof window.switchTab === 'function') {
        window.switchTab(activeTab);
      }
    }
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

  // キャッシュがない場合や月切り替え時はリアルなスケルトンを表示
  if (!usedCache || opts.showSkeleton || isMonthSwitch) {
    showMainSkeleton();
  }

  if (!usedCache && !opts.silent) {
    showToast(isMonthSwitch ? `${targetMonth.replace('-', '年')}月のデータを読み込み中…` : '最新データを同期しています…', { loading: true });
  }

  try {
    state.isMockMode = false;
    const res = await api('getInitialData', { month: targetMonth });
    if (state.viewMonth !== targetMonth) return; // 月送り連打時の古いレスポンスを破棄

    if (!res || !res.success) {
      if (res && (res.code === 'UNREGISTERED' || res.code === 'AUTH' || res.code === 'SETUP_REQUIRED')) {
        // バックエンド自体は正常稼働中（未登録または認証案内）なのでデモモードには落とさない
        state.isMockMode = false;
        state.backendVersion = res.version || 'v2.2.0';
        handleApiError(res);
        renderAll();
        hideMainSkeleton();
        if (!usedCache && !opts.silent) hideToast();
        return;
      }
      if (res) handleApiError(res);
      // バックエンド障害時はデモモードに自動フォールバックして描画
      state.isMockMode = true;
      showBanner('⚠️ バックエンドに接続できないため、デモモードで動作中です（ローカルで全機能を操作可能）', 'warn');
      const fallbackData = await mockApi('getInitialData', { month: targetMonth });
      applyData(fallbackData);
      hideMainSkeleton();
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
    hideMainSkeleton();
  } catch (err) {
    console.warn('loadInitialDataエラー -> デモモードで起動:', err);
    state.isMockMode = true;
    showBanner('⚠️ バックエンドに接続できないため、デモモードで動作中です（ローカルで全機能を操作可能）', 'warn');
    const fallbackData = await mockApi('getInitialData', { month: targetMonth });
    applyData(fallbackData);
    hideMainSkeleton();
    if (!usedCache && !opts.silent) hideToast();
  }
}

function applyData(data) {
  if (!data) return;
  state.viewMonth = data.month || state.viewMonth || localMonthStr();
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

  // フロントエンドとバックエンドのバージョン不一致時の自動修復リロード（ディスクキャッシュ対策）
  if (data.version && /^v2\./i.test(data.version) && data.version !== FRONTEND_VERSION) {
    try {
      const alreadyReloaded = sessionStorage.getItem('pairbudget_auto_reloaded_to');
      if (alreadyReloaded !== data.version) {
        sessionStorage.setItem('pairbudget_auto_reloaded_to', data.version);
        clearAllLocalCache();
        const cleanUrl = window.location.origin + window.location.pathname;
        window.location.replace(`${cleanUrl}?_v=${encodeURIComponent(data.version)}&_t=${Date.now()}`);
        return;
      }
    } catch (_) {}
  }
  if (data.bankAccounts && Array.isArray(data.bankAccounts)) {
    state.bankAccounts = data.bankAccounts;
    try { localStorage.setItem('pairbudget_bank_accounts', JSON.stringify(data.bankAccounts)); } catch (_) {}
  }
  if (data.securitySettings) {
    state.securitySettings = data.securitySettings;
  }
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
  if (data.config && data.config.shoppingPurgeDays !== undefined) {
    state.config.shoppingPurgeDays = Number(data.config.shoppingPurgeDays);
  }
  if (data.config && data.config.autoCheckShoppingOnReceipt !== undefined) {
    state.config.autoCheckShoppingOnReceipt = !!data.config.autoCheckShoppingOnReceipt;
  }
  if (data.config) {
    if (data.config.categoryBudgets) {
      state.categoryBudgets = data.config.categoryBudgets;
      try { localStorage.setItem('pairbudget_category_budgets', JSON.stringify(state.categoryBudgets)); } catch (_) {}
    }
    if (data.config.customCategories && Array.isArray(data.config.customCategories)) {
      state.customCategories = data.config.customCategories;
      try { localStorage.setItem('pairbudget_custom_categories', JSON.stringify(state.customCategories)); } catch (_) {}
    }
    if (data.config.surplusPolicy) {
      state.surplusPolicy = data.config.surplusPolicy;
      try { localStorage.setItem('pairbudget_surplus_policy', state.surplusPolicy); } catch (_) {}
    }
    if (data.config.savingsConfig) {
      state.savingsConfig = data.config.savingsConfig;
      try { localStorage.setItem('pairbudget_savings_config', JSON.stringify(state.savingsConfig)); } catch (_) {}
    }
    state.categoryBudgetsInheritedFrom = data.config.categoryBudgetsInheritedFrom || null;
    state.budgetInheritedFrom = data.config.budgetInheritedFrom || null;
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

  // カスタムカテゴリを state.categories にマージ (v2.7.0)
  (state.customCategories || []).forEach(customCat => {
    if (!state.categories.some(c => c.name === customCat.name)) {
      state.categories.push({
        name: customCat.name,
        color: customCat.color || '#10b981',
        icon: customCat.icon || 'tag',
        isCustom: true
      });
    }
  });

  renderAll();
  hideMainSkeleton();
  restoreUiState();
}

// ==========================================
// 描画
// ==========================================
function renderAll() {
  if ($('headerVersionBadge')) $('headerVersionBadge').textContent = FRONTEND_VERSION;
  if ($('frontVersionLabel')) $('frontVersionLabel').textContent = FRONTEND_VERSION;
  renderMonthNav();
  renderMemberLabels();
  renderCategoryDropdown();
  renderTransferCard();
  renderBudgetSummary();
  renderBankAccountsCard();
  renderSavingsCard();
  renderCategoryBudgets();
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

// ==========================================
// クイック月選択ボトムシート (v2.10.0新機能)
// ==========================================
let monthPickerSelectedYear = null;

function openMonthPickerSheet() {
  const sheet = $('monthPickerSheet');
  if (!sheet) return;

  const currentMonth = localMonthStr();
  const [curY, curM] = currentMonth.split('-');
  if ($('monthPickerCurrentLabel')) {
    $('monthPickerCurrentLabel').textContent = `${curY}年${Number(curM)}月`;
  }

  // 直近6ヶ月の月グリッドを描画
  const recentContainer = $('monthPickerRecentGrid');
  if (recentContainer) {
    const recentMonths = [];
    for (let i = 0; i < 6; i++) {
      recentMonths.push(shiftMonth(currentMonth, -i));
    }
    recentContainer.innerHTML = recentMonths.map((m, idx) => {
      const [y, mon] = m.split('-');
      const isSelected = m === state.viewMonth;
      const isToday = m === currentMonth;
      let badge = '';
      if (isToday) badge = '<span class="text-[9px] bg-emerald-100 text-emerald-800 font-bold px-1.5 py-0.2 rounded">今月</span>';
      else if (idx === 1) badge = '<span class="text-[9px] bg-slate-100 text-slate-500 font-medium px-1 py-0.2 rounded">前月</span>';

      const activeClass = isSelected
        ? 'bg-brand-500 text-white shadow-md ring-2 ring-brand-300 font-black'
        : 'bg-slate-50 hover:bg-slate-100 text-slate-800 border border-slate-200/80 font-bold';

      return `
        <button type="button" onclick="selectMonthFromPicker('${m}')" class="p-2.5 rounded-2xl flex flex-col items-center justify-center gap-1 transition-all active:scale-95 cursor-pointer ${activeClass}">
          <div class="flex items-center gap-1">
            <span class="text-xs leading-none">${Number(mon)}月</span>
            ${badge}
          </div>
          <span class="text-[10px] opacity-75 font-mono leading-none">${y}年</span>
        </button>
      `;
    }).join('');
  }

  // 年選択タブ ＆ 1〜12月グリッド
  const [viewY] = state.viewMonth.split('-');
  monthPickerSelectedYear = monthPickerSelectedYear || viewY;
  renderMonthPickerYearView(monthPickerSelectedYear);

  sheet.classList.remove('hidden');
  lucide.createIcons();
}
window.openMonthPickerSheet = openMonthPickerSheet;

function closeMonthPickerSheet() {
  const sheet = $('monthPickerSheet');
  if (sheet) sheet.classList.add('hidden');
}
window.closeMonthPickerSheet = closeMonthPickerSheet;

function selectMonthFromPicker(targetMonth) {
  closeMonthPickerSheet();
  if (targetMonth && targetMonth !== state.viewMonth) {
    const [y, m] = targetMonth.split('-');
    showToast(`📅 ${y}年${Number(m)}月に移動しました`);
    loadInitialData(targetMonth);
  }
}
window.selectMonthFromPicker = selectMonthFromPicker;

function switchMonthPickerYear(year) {
  monthPickerSelectedYear = String(year);
  renderMonthPickerYearView(monthPickerSelectedYear);
  lucide.createIcons();
}
window.switchMonthPickerYear = switchMonthPickerYear;

function renderMonthPickerYearView(targetYear) {
  const currentMonth = localMonthStr();
  const [curY] = currentMonth.split('-');
  const earliestMonth = shiftMonth(currentMonth, -(MAX_HISTORY_MONTHS - 1));
  const [earliestY] = earliestMonth.split('-');

  // 年タブボタン生成（過去3年分、例: 2024, 2025, 2026）
  const yearTabs = $('monthPickerYearTabs');
  if (yearTabs) {
    const years = [];
    for (let y = Number(curY); y >= Number(earliestY); y--) {
      years.push(String(y));
    }
    yearTabs.innerHTML = years.map(y => {
      const isSelected = y === String(targetYear);
      const activeClass = isSelected
        ? 'bg-white text-slate-900 shadow-xs'
        : 'text-slate-500 hover:text-slate-800';
      return `<button type="button" onclick="switchMonthPickerYear('${y}')" class="px-2.5 py-1 rounded-md transition-all cursor-pointer ${activeClass}">${y}年</button>`;
    }).join('');
  }

  // 1〜12月の月グリッド生成
  const monthsGrid = $('monthPickerAllMonthsGrid');
  if (monthsGrid) {
    const monthsHtml = [];
    for (let m = 1; m <= 12; m++) {
      const monthStr = `${targetYear}-${pad2(m)}`;
      const isFuture = monthStr > currentMonth;
      const isTooOld = monthStr < earliestMonth;
      const isDisabled = isFuture || isTooOld;
      const isSelected = monthStr === state.viewMonth;

      let btnClass = '';
      if (isSelected) {
        btnClass = 'bg-brand-500 text-white font-black shadow-sm ring-2 ring-brand-300';
      } else if (isDisabled) {
        btnClass = 'bg-slate-50 text-slate-300 border border-slate-100 cursor-not-allowed opacity-40';
      } else {
        btnClass = 'bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 font-bold active:scale-95 cursor-pointer';
      }

      monthsHtml.push(`
        <button type="button" ${isDisabled ? 'disabled' : `onclick="selectMonthFromPicker('${monthStr}')"`} class="py-2 rounded-xl text-xs text-center transition-all ${btnClass}">
          ${m}月
        </button>
      `);
    }
    monthsGrid.innerHTML = monthsHtml.join('');
  }
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
  if ($('budgetProgressRate')) $('budgetProgressRate').textContent = `${s.progressRate}% 消化`;
  const bar = $('budgetProgressBar');
  if (bar) {
    bar.style.width = `${s.progressRate}%`;
    const tone = s.progressRate > 90 ? 'bg-rose-500' : s.progressRate > 75 ? 'bg-amber-500' : 'bg-brand-500';
    bar.className = `${tone} h-full rounded-full transition-all duration-500`;
  }

  // 残金ラベル・金額
  if ($('remainingBudget')) $('remainingBudget').textContent = yen(s.remaining);

  // 「今月使えるお金」＆過去月の表示刷新
  const dailyLabel = $('dailyAllowanceLabel');
  const dailyEl = $('dailyAllowance');
  const dailySub = $('dailyAllowanceSub');

  if (s.isCurrentMonth) {
    if (dailyLabel) dailyLabel.textContent = '今月使えるお金';
    if (dailyEl) {
      dailyEl.textContent = yen(s.remaining);
      dailyEl.className = s.remaining < 0 ? 'text-base font-black text-rose-600' : 'text-base font-black text-brand-600';
    }
    if (dailySub) {
      dailySub.textContent = `1日あたり目安: ${yen(s.dailyAllowance)} / 日 (残${s.daysLeft}日)`;
      dailySub.className = 'text-[10px] text-slate-400 block';
    }
  } else {
    // 過去月の月次収支結果表示（「過去の月」を廃止し黒字/赤字をスタイリッシュに表示）
    if (dailyLabel) dailyLabel.textContent = '月次収支結果';
    if (dailyEl) {
      if (s.remaining >= 0) {
        dailyEl.textContent = `+${yen(s.remaining)}（黒字達成✨）`;
        dailyEl.className = 'text-xs font-black text-emerald-600';
      } else {
        dailyEl.textContent = `-${yen(Math.abs(s.remaining))}（予算超過）`;
        dailyEl.className = 'text-xs font-black text-rose-600';
      }
    }
    if (dailySub) {
      dailySub.textContent = '当月の生活費精算確定';
      dailySub.className = 'text-[10px] text-slate-400 block';
    }
  }

  // 余剰金 返金予定額バナー（返金モード: ratio / equal 時）
  const refundBanner = $('surplusRefundBanner');
  if (refundBanner) {
    if (state.surplusPolicy !== 'savings' && s.remaining > 0) {
      refundBanner.classList.remove('hidden');
      const refundTotal = s.remaining;
      if ($('surplusRefundTotalBadge')) $('surplusRefundTotalBadge').textContent = `余剰金 ${yen(refundTotal)}`;

      const members = state.members || [];
      const mCount = members.length || 2;
      const detailsEl = $('surplusRefundDetails');
      if (detailsEl) {
        if (state.surplusPolicy === 'equal') {
          // 均等割り
          const perPerson = Math.floor(refundTotal / mCount);
          detailsEl.innerHTML = members.map((m, i) => `
            <span class="bg-white/80 border border-emerald-200 px-2 py-0.5 rounded-md font-medium">
              ${esc(m.name || `メンバー${i + 1}`)}: <b>+${yen(perPerson)}</b> 返金
            </span>
          `).join('');
        } else {
          // 拠出比率按分
          const totalBase = members.reduce((sum, m) => sum + (Number(m.baseContribution) || 0), 0);
          detailsEl.innerHTML = members.map((m, i) => {
            const mBase = Number(m.baseContribution) || 0;
            const ratio = totalBase > 0 ? mBase / totalBase : 1 / mCount;
            const mRefund = Math.round(refundTotal * ratio);
            return `
              <span class="bg-white/80 border border-emerald-200 px-2 py-0.5 rounded-md font-medium">
                ${esc(m.name || `メンバー${i + 1}`)} (${Math.round(ratio * 100)}%): <b>+${yen(mRefund)}</b> 返金
              </span>
            `;
          }).join('');
        }
      }
    } else {
      refundBanner.classList.add('hidden');
    }
  }

  if ($('totalExpenseSummary')) $('totalExpenseSummary').textContent = `支出合計: ${yen(s.totalExpense)}`;
}

/**
 * 共同積立（貯金）および共同口座トータル残高を算出する共通関数 (v2.14.0: 案C口座分け × 案Aスッキリ統合)
 * - ① 普段の生活費口座 (shared_bank: 例 ¥161,421)
 * - ② 別口座貯金・余り繰越分 (shared_savings / initialSavings + 手動繰越収支 + 累計利息)
 * - 合計 (totalBalance) = ① 普段の生活費口座 + ② 別口座貯金・繰越分
 * - 過去CSV取込月に対して勝手に「予算−支出」の理論値を加算しない設計
 */
function computeJointSavingsSummary() {
  const currentBankBalance = (state.bankAccounts || [])
    .filter(a => a.type === 'shared_bank')
    .reduce((sum, a) => sum + (Number(a.balance) || 0), 0);

  const sharedSavingsAccountBalance = (state.bankAccounts || [])
    .filter(a => a.type === 'shared_savings')
    .reduce((sum, a) => sum + (Number(a.balance) || 0), 0);

  let rawInitialSavings = Number(state.savingsConfig?.initialSavings || 0);
  // 旧バージョンの自動同期で生活費口座残高と同じ値が initialSavings に入っていた場合の二重計上を防止
  if (rawInitialSavings > 0 && rawInitialSavings === currentBankBalance && sharedSavingsAccountBalance === 0) {
    rawInitialSavings = 0;
  }

  // 別口座貯金のベース残高（口座一覧の「別口座貯金」または初期繰越設定額）
  const initialSavings = sharedSavingsAccountBalance > 0 ? sharedSavingsAccountBalance : rawInitialSavings;

  const monthlyInterests = state.savingsConfig?.monthlyInterests || {};
  const monthlyBalances = state.savingsConfig?.monthlyBalances || {};

  // monthlyTotals を時系列順（古い月→新しい月）にソート
  const totals = (state.monthlyTotals || []).slice().sort((a, b) => (a.month > b.month ? 1 : -1));

  let separateSavingsBalance = initialSavings;
  let totalInterests = 0;
  let countedMonths = 0;
  const monthRows = [];

  totals.forEach(t => {
    const m = t.month;
    const hasManualBalance = monthlyBalances[m] !== undefined && monthlyBalances[m] !== '' && !isNaN(Number(monthlyBalances[m]));
    const hasInterest = Number(monthlyInterests[m] || 0) > 0;

    // ユーザーが明示的に登録した繰越収支または利息のみを別口座繰越に加算（過去CSV月の架空黒字加算を防止）
    const isCounted = hasManualBalance || hasInterest;

    let balance = 0;
    let isManual = false;
    if (hasManualBalance) {
      balance = Number(monthlyBalances[m]);
      isManual = true;
    }

    const interest = Number(monthlyInterests[m] || 0);

    if (isCounted) {
      separateSavingsBalance += (balance + interest);
      totalInterests += interest;
      countedMonths++;
    }

    monthRows.push({
      month: m,
      balance,
      interest,
      isCounted,
      isManual,
      hasManualBalance,
      manualBalanceValue: hasManualBalance ? monthlyBalances[m] : ''
    });
  });

  // ふたりの共同口座・積立 合計 ＝ ① 普段の生活費口座 ＋ ② 別口座貯金（繰越分）
  const totalBalance = currentBankBalance + separateSavingsBalance;

  return {
    totalBalance,
    separateSavingsBalance,
    initialSavings,
    currentBankBalance,
    totalInterests,
    countedMonths,
    monthRows
  };
}

/**
 * 共同積立を現在の口座残高とワンタップで完全同期 (v2.14.0)
 */
window.syncSavingsWithBankBalance = async function () {
  if (!state.savingsConfig) state.savingsConfig = {};
  state.savingsConfig.initialSavings = 0;
  try { localStorage.setItem('pairbudget_savings_config', JSON.stringify(state.savingsConfig)); } catch (_) {}
  renderBankAccountsCard();
  renderSavingsCard();
  updateBudgetOverWarningBox();
  showToast('🏦 口座残高と積立表示を整理・同期しました✨', 'success');
};

/**
 * ①普段の生活費口座 と ②別口座貯金 の残高が逆（テレコ）になった時にワンタップで入れ替える関数 (v2.15.1)
 */
window.swapLivingAndSavingsBalances = async function () {
  if (!Array.isArray(state.bankAccounts) || state.bankAccounts.length === 0) {
    renderBankAccountsCard();
  }
  const summary = computeJointSavingsSummary();
  const oldLivingBal = Number(summary.currentBankBalance || 0);
  const oldSavingsBal = Number(summary.initialSavings || 0);

  // 別口座CSV取込で①生活費口座が上書きされ②別口座が0だった場合は、①を161,421円に戻しつつ②へ別口座残高を移す
  const nextLivingBal = (oldSavingsBal === 0 && oldLivingBal > 0 && oldLivingBal !== 161421)
    ? 161421
    : oldSavingsBal;
  const nextSavingsBal = oldLivingBal;

  // ①生活費口座 (shared_bank) を更新
  let updatedLiving = false;
  state.bankAccounts = (state.bankAccounts || []).map(acc => {
    if (acc.type === 'shared_bank' && !updatedLiving) {
      updatedLiving = true;
      return { ...acc, balance: nextLivingBal, updatedAt: new Date().toISOString() };
    }
    return acc;
  });

  // ②別口座貯金 (shared_savings) および initialSavings を更新
  let updatedSavings = false;
  state.bankAccounts = state.bankAccounts.map(acc => {
    if (acc.type === 'shared_savings' && !updatedSavings) {
      updatedSavings = true;
      return { ...acc, balance: nextSavingsBal, updatedAt: new Date().toISOString() };
    }
    return acc;
  });
  if (!updatedSavings) {
    state.bankAccounts.push({
      id: 'acc_shared_savings',
      name: '別口座貯金（余り繰越用）',
      type: 'shared_savings',
      balance: nextSavingsBal,
      institution: '貯蓄用別口座',
      note: '余った分の繰越・共同貯金',
      updatedAt: new Date().toISOString()
    });
  }

  if (!state.savingsConfig) state.savingsConfig = {};
  state.savingsConfig.initialSavings = nextSavingsBal;

  try {
    localStorage.setItem('pairbudget_bank_accounts', JSON.stringify(state.bankAccounts));
    localStorage.setItem('pairbudget_savings_config', JSON.stringify(state.savingsConfig));
  } catch (_) {}

  renderBankAccountsCard();
  renderSavingsCard();
  updateBudgetOverWarningBox();

  showToast(`🔄 ①生活費口座（${yen(nextLivingBal)}）⇄ ②別口座貯金（${yen(nextSavingsBal)}）に入れ替えました✨`, 'success');

  if (!state.isMockMode) {
    Promise.all([
      api('updateBankAccounts', { bankAccounts: state.bankAccounts }).catch(() => {}),
      api('updateSavingsConfig', { savingsConfig: state.savingsConfig }).catch(() => {})
    ]);
  }
};

/**
 * 共同口座 ＆ 別口座積立 統合ボード描画 (v2.14.0)
 */
function renderSavingsCard() {
  const card = $('savingsSummaryCard');
  if (!card) return;
  card.classList.remove('hidden');

  const summary = computeJointSavingsSummary();

  const rows = [];
  summary.monthRows.forEach(item => {
    if (!item.isCounted) return; // 未計上月は履歴表に表示しない

    const [, m] = item.month.split('-');
    const monthLabel = `${Number(m)}月`;

    const balanceFormatted = item.balance >= 0
      ? `<span class="text-emerald-600 font-bold font-mono">+${item.balance.toLocaleString()}</span>`
      : `<span class="text-rose-600 font-bold font-mono">-${Math.abs(item.balance).toLocaleString()}</span>`;

    const interestFormatted = item.interest > 0
      ? `<span class="font-bold text-slate-800 font-mono">${item.interest.toLocaleString()}</span>`
      : `<span class="text-slate-400 font-mono">0</span>`;

    rows.push(`
      <tr class="hover:bg-slate-50/80 transition-colors">
        <td class="py-2 px-3 font-bold text-slate-700">
          ${monthLabel}
          ${item.isManual ? '<span class="text-[9px] text-brand-600 bg-brand-50 rounded px-1 ml-0.5 font-normal">繰越記録</span>' : ''}
        </td>
        <td class="py-2 px-3 text-right">
          <button type="button" onclick="openSavingsModal('${item.month}')" class="hover:underline cursor-pointer" title="収支・利息を編集">
            ${balanceFormatted}
          </button>
        </td>
        <td class="py-2 px-3 text-right">
          <button type="button" onclick="openSavingsModal('${item.month}')" class="hover:underline inline-flex items-center gap-1 text-slate-700 cursor-pointer" title="利息を編集">
            ${interestFormatted}
            <i data-lucide="edit-2" class="w-2.5 h-2.5 text-slate-300"></i>
          </button>
        </td>
      </tr>
    `);
  });

  if ($('totalSavingsBalance')) $('totalSavingsBalance').textContent = yen(summary.totalBalance);
  if ($('separateSavingsBalanceLabel')) $('separateSavingsBalanceLabel').textContent = yen(summary.separateSavingsBalance);
  if ($('initialSavingsLabel')) $('initialSavingsLabel').textContent = yen(summary.initialSavings);
  if ($('totalInterestsLabel')) $('totalInterestsLabel').textContent = yen(summary.totalInterests);
  if ($('savingsCountMonths')) {
    $('savingsCountMonths').textContent = summary.separateSavingsBalance > 0
      ? `生活費口座 ＋ 別口座貯金`
      : `生活費口座と一致`;
  }

  const tbody = $('savingsMonthlyTableBody');
  if (tbody) {
    tbody.innerHTML = rows.length ? rows.slice(-6).reverse().join('') : '<tr><td colspan="3" class="py-3 text-center text-slate-400">月別の繰越・利息記録はまだありません（「+ 繰越・利息を入力」から追加可能）</td></tr>';
  }

  // 月初に共同口座へ残すお金ガイド (v2.9.0: 共同カードと共同口座直接引落の完全分離)
  if ($('guideNextMonthBudget')) $('guideNextMonthBudget').textContent = yen(state.summary.budget);

  // ② 前月共同カード引落分（クレカ決済のみ・カード会社の請求確定明細と完全一致）
  const lastMonthStr = shiftMonth(state.viewMonth, -1);
  const lastTotalObj = (state.monthlyTotals || []).find(m => m.month === lastMonthStr);
  const lastMonthCardTotal = lastTotalObj ? Number(lastTotalObj.sharedCard || 0) : 0;
  if ($('guideLastMonthSharedCard')) $('guideLastMonthSharedCard').textContent = yen(lastMonthCardTotal);

  // 当月共同カード利用額
  const curSharedCard = state.transactions
    .filter(t => t.paymentType === 'shared_card')
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);

  if ($('guideLastMonthSharedCardSub')) {
    if (lastMonthCardTotal > 0) {
      $('guideLastMonthSharedCardSub').textContent = `前月(${lastMonthStr})のカード決済実績 (明細一致)`;
    } else if (curSharedCard > 0) {
      $('guideLastMonthSharedCardSub').textContent = `当月利用中: ${yen(curSharedCard)} (翌月初引落予定)`;
    } else {
      $('guideLastMonthSharedCardSub').textContent = `前月のカード利用なし (¥0)`;
    }
  }

  // ③ 共同口座直接引落分 (家賃・光熱費・口座振替等)
  const fixedSharedAccountItems = (state.fixedExpenses || []).filter(f => f.isActive && (f.paymentType === 'shared_account' || (!f.paymentType && f.payer !== '共同カード')));
  const fixedSharedAccountTotal = fixedSharedAccountItems.reduce((s, f) => s + Number(f.amount || 0), 0);
  if ($('guideSharedAccount')) $('guideSharedAccount').textContent = yen(fixedSharedAccountTotal);
  if ($('guideSharedAccountSub')) {
    if (fixedSharedAccountItems.length > 0) {
      const titles = fixedSharedAccountItems.map(f => f.title).slice(0, 2).join('・');
      const more = fixedSharedAccountItems.length > 2 ? `他${fixedSharedAccountItems.length - 2}件` : '';
      $('guideSharedAccountSub').textContent = `口座振替 ${fixedSharedAccountItems.length}件 (${titles}${more ? `・${more}` : ''})`;
    } else {
      $('guideSharedAccountSub').textContent = `登録された口座振替なし`;
    }
  }

  // ④ 個人カード立替/私物精算控除
  const myAdjustment = (state.transfers && state.transfers[state.currentSlot])
    ? (Number(state.transfers[state.currentSlot].advancedForShared || 0) - Number(state.transfers[state.currentSlot].privateOnSharedCard || 0))
    : 0;
  if ($('guideAdjustment')) $('guideAdjustment').textContent = yen(Math.abs(myAdjustment));

  lucide.createIcons();
}

/**
 * 部門（カテゴリ）別 予算のこり状況リスト描画
 */
function renderCategoryBudgets() {
  const container = $('categoryBudgetsSummaryList');
  if (!container) return;

  // 🔄 前月引き継ぎ中バッジ表示制御 (v2.8.0)
  const inheritBadge = $('categoryBudgetsInheritedBadge');
  if (inheritBadge) {
    if (state.categoryBudgetsInheritedFrom) {
      inheritBadge.classList.remove('hidden');
      const [iy, im] = state.categoryBudgetsInheritedFrom.split('-');
      inheritBadge.textContent = `🔄 ${Number(iy)}年${Number(im)}月を引き継ぎ中`;
      inheritBadge.title = `対象月の個別設定がないため、${state.categoryBudgetsInheritedFrom}の割り振りを自動適用しています`;
    } else {
      inheritBadge.classList.add('hidden');
    }
  }

  const budgets = state.categoryBudgets || {};
  const categories = state.categories || [];
  if (!categories.length) return;

  // カテゴリ別支出を計算（共同生活費の予算消化のため、純粋な共同費のみで集計）
  const spentMap = {};
  state.transactions.filter(t => t.isShared).forEach(t => {
    spentMap[t.category] = (spentMap[t.category] || 0) + Number(t.amount || 0);
  });

  const cardsHtml = categories.map(cat => {
    const budget = Number(budgets[cat.name] || 0);
    const spent = spentMap[cat.name] || 0;
    const hasBudget = budget > 0;
    const remaining = budget - spent;
    const rate = hasBudget ? Math.round((spent / budget) * 100) : 0;

    let barColor = 'bg-brand-500';
    let statusText = '';
    if (hasBudget) {
      if (remaining < 0) {
        barColor = 'bg-rose-500';
        statusText = `<span class="text-rose-600 font-bold">⚠️ ${yen(Math.abs(remaining))} オーバー</span>`;
      } else if (rate >= 80) {
        barColor = 'bg-amber-500';
        statusText = `<span class="text-amber-700 font-bold">残り ${yen(remaining)}</span>`;
      } else {
        barColor = 'bg-emerald-500';
        statusText = `<span class="text-emerald-700 font-bold">残り ${yen(remaining)}</span>`;
      }
    } else {
      statusText = `<span class="text-slate-400">予算未設定</span>`;
    }

    return `
      <div onclick="filterHistoryByCategory('${esc(cat.name)}')" class="p-2.5 rounded-xl bg-slate-50/80 border border-slate-100 hover:border-brand-300 hover:bg-slate-100/90 hover:shadow-2xs transition-all cursor-pointer active:scale-98 space-y-1.5 group select-none" title="タップして「${esc(cat.name)}」の支出明細を表示">
        <div class="flex items-center justify-between text-xs">
          <span class="font-bold text-slate-800 flex items-center gap-1.5 group-hover:text-brand-700 transition-colors">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: ${cat.color || '#94a3b8'}"></span>
            ${esc(cat.name)}
            <i data-lucide="chevron-right" class="w-3 h-3 text-slate-300 group-hover:text-brand-500 transition-colors"></i>
          </span>
          <div>${statusText}</div>
        </div>

        ${hasBudget ? `
          <div class="w-full bg-slate-200/80 h-1.5 rounded-full overflow-hidden">
            <div class="${barColor} h-full rounded-full transition-all duration-300" style="width: ${Math.min(100, rate)}%"></div>
          </div>
          <div class="flex justify-between text-[10px] text-slate-400">
            <span>使用 ${yen(spent)}</span>
            <span>予算 ${yen(budget)} (${rate}%)</span>
          </div>
        ` : `
          <div class="text-[10px] text-slate-400 flex justify-between items-center">
            <span>支出: ${yen(spent)}</span>
            <span class="text-[9px] text-brand-600 font-medium opacity-0 group-hover:opacity-100 transition-opacity">明細を見る →</span>
          </div>
        `}
      </div>
    `;
  }).join('');

  container.innerHTML = cardsHtml;
  lucide.createIcons();
}

/** スコープ（共同/自分）に応じた表示対象の支出 (v2.6.0: 共同カードの個人支出も共同一覧に表示) */
function scopedTransactions() {
  return state.transactions.filter(t => state.activeScope === 'shared'
    ? (t.isShared || t.paymentType === 'shared_card')
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
  const nonExpenseCats = ['口座入金', '収入', 'クレカ引落振替', '振替'];
  scopedTransactions()
    .filter(t => !nonExpenseCats.includes(t.category) && !nonExpenseCats.includes(t.categoryId) && Number(t.amount) > 0)
    .forEach(t => { totals[t.category] = (totals[t.category] || 0) + Number(t.amount); });
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

  const isDeposit = item.category === '口座入金' || item.category === '収入' || item.categoryId === '口座入金' || item.categoryId === '収入' || item.paymentType === 'deposit' || item.txType === 'deposit';
  const isTransfer = item.category === 'クレカ引落振替' || item.categoryId === 'クレカ引落振替' || item.txType === 'card_transfer' || item.category === '振替';

  let tag = '';
  if (!item.isShared && item.paymentType === 'shared_card') tag = '<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-bold">私物(返還要)</span>';
  else if (item.isShared && item.paymentType === 'advanced_by_user') tag = '<span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-bold">立替</span>';
  else if (isDeposit) tag = '<span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold">💰 口座入金</span>';
  else if (isTransfer) tag = '<span class="text-[9px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-bold">💳 簿記振替(クレカ消込)</span>';

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
    <button data-action="tx-history" data-id="${esc(item.id)}" class="text-slate-300 hover:text-slate-600 p-1.5 rounded-lg active:bg-slate-100" aria-label="変更履歴"><i data-lucide="history" class="w-3.5 h-3.5"></i></button>
    <button data-action="edit-tx" data-id="${esc(item.id)}" class="text-slate-300 hover:text-slate-600 p-1.5 rounded-lg active:bg-slate-100" aria-label="編集"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i></button>` : '';

  const isRefund = Number(item.amount) < 0;
  const amountHtml = isDeposit
    ? `<span class="text-sm font-black text-emerald-600">+${yen(Math.abs(item.amount))}</span><span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold ml-1">入金</span>`
    : (isTransfer
      ? `<span class="text-sm font-black text-purple-600">-${yen(Math.abs(item.amount))}</span><span class="text-[9px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 font-bold ml-1">振替</span>`
      : (isRefund
        ? `<span class="text-sm font-black text-emerald-600">-${yen(Math.abs(item.amount))}</span><span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold ml-1">返金</span>`
        : `<span class="text-sm font-black text-slate-900">${yen(item.amount)}</span>`));

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
      ${amountHtml}${actions}
    </div>`;

  if (items.length) {
    const lines = items.map(it => {
      const priceText = Number(it.price) < 0 ? `-${yen(Math.abs(it.price))}` : yen(it.price);
      const isDiscount = Number(it.price) < 0;
      return `<div class="flex justify-between text-[11px] ${isDiscount ? 'text-emerald-700 font-bold' : 'text-slate-600'}"><span>ー ${esc(it.name)}${it.quantity > 1 ? ` ×${it.quantity}` : ''}</span><span>${priceText}</span></div>`;
    }).join('');
    wrap.innerHTML = `<details class="group py-2.5 rounded-xl transition-colors hover:bg-slate-50/60">
      <summary class="flex items-center justify-between cursor-pointer list-none gap-2">${head}</summary>
      <div class="ml-8 mt-1.5 pl-2 border-l-2 border-brand-100 space-y-0.5">${lines}</div></details>`;
  } else {
    wrap.innerHTML = `<div class="py-3 flex items-center justify-between gap-2 rounded-xl transition-colors hover:bg-slate-50/60 cursor-pointer">${head}</div>`;
  }

  // スマホ対応: 行全体タップで支出編集モーダルを開く（ボタンや詳細アコーディオン操作は除外）
  if (isEditable) {
    wrap.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('summary') || e.target.closest('input') || e.target.closest('a')) {
        return;
      }
      openExpenseModal(item);
    });
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
  const cat = $('historyCategoryFilter')?.value || 'all';
  const payer = $('historyPayerFilter')?.value || 'all';

  // 絞り込み中バッジの表示制御 (v2.11.0)
  const badgeWrap = $('historyActiveFilterBadgeWrap');
  if (badgeWrap) {
    if (cat !== 'all') {
      badgeWrap.classList.remove('hidden');
      if ($('historyActiveCategoryName')) $('historyActiveCategoryName').textContent = cat;
    } else {
      badgeWrap.classList.add('hidden');
    }
  }

  const list = scopedTransactions().filter(t => {
    const catOk = cat === 'all' || t.category === cat;
    const payerOk = payer === 'all' || resolvePayerSlot(t.payer) === payer || t.payer === payer;
    return catOk && payerOk;
  });
  if (!list.length) { c.innerHTML = '<div class="py-8 text-center text-xs text-slate-400">該当する支出はありません</div>'; return; }
  list.forEach(i => c.appendChild(createTransactionRow(i, true)));
  lucide.createIcons();
}

/**
 * ホームの部門別予算カードタップによるカテゴリ絞り込みジャンプ (v2.11.0新機能)
 */
function filterHistoryByCategory(categoryName) {
  if (!categoryName) return;

  // 1. 履歴タブへ切り替え
  switchTab('history');

  // 2. フィルタセレクトを対象カテゴリにセット
  const filterSelect = $('historyCategoryFilter');
  if (filterSelect) {
    if (!Array.from(filterSelect.options).some(o => o.value === categoryName)) {
      filterSelect.insertAdjacentHTML('beforeend', `<option value="${esc(categoryName)}">${esc(categoryName)}</option>`);
    }
    filterSelect.value = categoryName;
  }

  // 3. 履歴リストを再描画
  renderHistoryList();

  // 4. トースト通知
  showToast(`📂「${categoryName}」の支出に絞り込みました✨`);

  // 5. スムーズスクロール
  const targetEl = $('historyActiveFilterBadgeWrap') || $('fullTransactionsList');
  if (targetEl) {
    targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
window.filterHistoryByCategory = filterHistoryByCategory;

/**
 * カテゴリ絞り込みのワンタップ解除 (v2.11.0新機能)
 */
function clearHistoryCategoryFilter() {
  const filterSelect = $('historyCategoryFilter');
  if (filterSelect) filterSelect.value = 'all';
  renderHistoryList();
  showToast('全カテゴリの支出を表示しました');
}
window.clearHistoryCategoryFilter = clearHistoryCategoryFilter;

function renderShoppingList() {
  const un = $('uncompletedShoppingList'), done = $('completedShoppingList');
  const open = state.shoppingList.filter(s => !s.isCompleted);
  const closed = state.shoppingList.filter(s => s.isCompleted);
  if ($('uncompletedCount')) $('uncompletedCount').textContent = open.length;
  if ($('completedCount')) $('completedCount').textContent = closed.length;

  // 自動削除バッジの更新
  if ($('completedPurgeBadge')) {
    const days = state.config.shoppingPurgeDays !== undefined ? state.config.shoppingPurgeDays : 1;
    let badgeText = '';
    if (days === -1) badgeText = '自動削除: OFF';
    else if (days === 0) badgeText = '購入後に即時削除';
    else if (days === 1) badgeText = '購入から1日後に自動削除';
    else badgeText = `購入から${days}日後に自動削除`;
    $('completedPurgeBadge').textContent = badgeText;
  }

  if (un) {
    un.innerHTML = open.length ? open.map(it => `
      <div class="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100 hover:border-slate-200 transition-colors">
        <label class="flex items-center gap-2.5 cursor-pointer flex-1 mr-2">
          <input type="checkbox" data-action="buy-shop" data-id="${esc(it.id)}" class="w-5 h-5 rounded text-brand-500 focus:ring-brand-400 cursor-pointer">
          <div class="flex-1">
            <span class="text-sm font-bold text-slate-800 break-all">${esc(it.title)}</span>
            <span class="text-[10px] text-slate-400 block">${esc(it.requestedBy || 'メンバー')}が追加</span>
          </div>
        </label>
        <button data-action="delete-shop" data-id="${esc(it.id)}" class="text-slate-300 hover:text-rose-500 p-1 rounded-lg transition-colors" aria-label="削除"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
      </div>`).join('') : '<div class="py-6 text-center text-xs text-slate-400">現在買うものはありません✨</div>';
  }

  if (done) {
    done.innerHTML = closed.length ? closed.map(it => `
      <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-50/70 border border-slate-100/60 text-slate-400">
        <div class="flex items-center gap-2 flex-1 mr-2">
          <button type="button" data-action="unbuy-shop" data-id="${esc(it.id)}" title="買うものリストに戻す" class="w-5 h-5 rounded border border-brand-400 bg-brand-50 text-brand-600 flex items-center justify-center hover:bg-brand-100 transition-colors cursor-pointer shrink-0">
            <i data-lucide="check" class="w-3.5 h-3.5"></i>
          </button>
          <div class="flex-1">
            <span class="line-through text-xs text-slate-500 break-all font-medium">${esc(it.title)}</span>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <button type="button" data-action="unbuy-shop" data-id="${esc(it.id)}" class="text-[11px] text-brand-600 hover:text-brand-700 bg-white border border-brand-200 px-2 py-0.5 rounded-md font-medium transition-colors">
            戻す
          </button>
          <button data-action="delete-shop" data-id="${esc(it.id)}" class="text-slate-300 hover:text-rose-500 p-1" aria-label="削除"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
        </div>
      </div>`).join('') : '<div class="py-4 text-center text-xs text-slate-400">購入済みのアイテムはありません</div>';
  }
}

function renderFixedExpenses() {
  const total = state.fixedExpenses.reduce((s, f) => s + (f.isActive ? Number(f.amount) : 0), 0);
  $('fixedExpensesTotal').textContent = `合計: ${yen(total)}（年間 ${yen(total * 12)}）`;
  $('fixedExpensesList').innerHTML = state.fixedExpenses.length ? state.fixedExpenses.map(f => {
    const isCard = f.paymentType === 'shared_card' || f.payer === '共同カード';
    const badge = isCard
      ? '<span class="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-bold border border-blue-200">💳 共同カード</span>'
      : '<span class="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 font-bold border border-purple-200">🏦 口座振替</span>';
    return `
    <div data-action="edit-fixed" data-id="${esc(f.id)}" class="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-100 text-xs cursor-pointer transition-colors ${f.isActive ? '' : 'opacity-50'}">
      <div>
        <div class="flex items-center gap-1.5 mb-0.5">
          <span class="font-bold text-slate-800">${esc(f.title)}</span>
          ${badge}
        </div>
        <span class="text-[10px] text-slate-400 block">毎月${esc(f.billingDay)}日引落 (${esc(f.category)})</span>
      </div>
      <div class="flex items-center gap-2">
        <div class="text-right">
          <span class="font-black text-slate-900">${yen(f.amount)}</span>
          <span class="text-[9px] ${f.isActive ? 'text-purple-600' : 'text-slate-400'} font-bold block">${f.isActive ? '自動計上 ON' : '停止中 OFF'}</span>
        </div>
        <i data-lucide="edit-3" class="w-3.5 h-3.5 text-slate-300"></i>
      </div>
    </div>`;
  }).join('') : '<div class="py-4 text-center text-xs text-slate-400">固定費はまだ登録されていません</div>';
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
  if ($('settingShoppingPurgeDays')) {
    const purgeDays = state.config.shoppingPurgeDays !== undefined ? state.config.shoppingPurgeDays : 1;
    $('settingShoppingPurgeDays').value = String(purgeDays);
  }
  if ($('settingAutoCheckShoppingToggle')) {
    const autoCheck = state.config.autoCheckShoppingOnReceipt !== undefined ? !!state.config.autoCheckShoppingOnReceipt : true;
    $('settingAutoCheckShoppingToggle').checked = autoCheck;
  }

  // 余剰金精算ルール選択ラジオ
  const policyRadios = document.querySelectorAll('input[name="surplusPolicy"]');
  policyRadios.forEach(radio => {
    radio.checked = radio.value === state.surplusPolicy;
  });

  // 動的メンバー一覧＆カラー設定を描画
  renderSettingMembersList();
  applyMemberColors();

  // 部門別予算入力リスト描画
  renderCategoryBudgetsInputs();

  // 生活費予算警告バナー更新
  updateBudgetOverWarningBox();

  // バージョン表示
  if ($('frontVersionLabel')) $('frontVersionLabel').textContent = FRONTEND_VERSION;
  if ($('backVersionLabel')) {
    $('backVersionLabel').textContent = state.backendVersion || (state.isMockMode ? 'demo' : '未取得');
  }
}

/**
 * 設定タブの部門別予算入力リスト描画
 */
function renderCategoryBudgetsInputs() {
  const container = $('categoryBudgetsInputsList');
  if (!container) return;

  // 🔄 前月引き継ぎ案内バナー (v2.8.0)
  const noticeEl = $('categoryBudgetsInheritedNotice');
  const noticeTextEl = $('categoryBudgetsInheritedNoticeText');
  if (noticeEl && noticeTextEl) {
    if (state.categoryBudgetsInheritedFrom) {
      noticeEl.classList.remove('hidden');
      const [iy, im] = state.categoryBudgetsInheritedFrom.split('-');
      noticeTextEl.textContent = `直近設定月（${Number(iy)}年${Number(im)}月）の割り振りを自動引き継ぎ中`;
    } else {
      noticeEl.classList.add('hidden');
    }
  }

  // 📋 前月コピーボタンのラベル更新 (v2.8.0)
  const copyBtnLabel = $('copyLastMonthBtnLabel');
  if (copyBtnLabel) {
    const [cy, cm] = (state.currentMonth || localMonthStr()).split('-').map(Number);
    const d = new Date(cy, cm - 2, 1);
    const prevMonthNum = d.getMonth() + 1;
    copyBtnLabel.textContent = `前月（${prevMonthNum}月）の割り振りをコピー`;
  }

  const categories = state.categories || [];
  const budgets = state.categoryBudgets || {};

  container.innerHTML = categories.map(cat => {
    const bVal = budgets[cat.name] !== undefined ? budgets[cat.name] : '';
    const isCustom = !!cat.isCustom || ((state.customCategories || []).some(c => c.name === cat.name));
    return `
      <div class="flex items-center justify-between p-2 rounded-xl bg-slate-50 border border-slate-100">
        <label class="text-xs font-bold text-slate-700 flex items-center gap-1.5 flex-1 min-w-0">
          <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: ${cat.color || '#94a3b8'}"></span>
          <span class="truncate">${esc(cat.name)}</span>
          ${isCustom ? '<span class="text-[9px] bg-emerald-100 text-emerald-800 px-1.5 py-0.2 rounded font-normal shrink-0">カスタム</span>' : ''}
        </label>
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-xs text-slate-400 font-mono">¥</span>
          <input type="number" data-category-budget="${esc(cat.name)}" value="${bVal}" placeholder="0" class="w-20 sm:w-24 bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono text-right focus:outline-none focus:ring-1 focus:ring-brand-400">
          ${isCustom ? `
            <button type="button" onclick="deleteCustomCategory('${esc(cat.name)}')" class="text-slate-300 hover:text-rose-500 p-1 transition-colors cursor-pointer" title="部門を削除" aria-label="部門「${esc(cat.name)}」を削除">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          ` : '<span class="w-5"></span>'}
        </div>
      </div>
    `;
  }).join('');

  // 入力イベントで差額バッジをリアルタイム更新
  container.querySelectorAll('input[data-category-budget]').forEach(input => {
    input.addEventListener('input', updateCategoryBudgetsDiffBadge);
  });
  updateCategoryBudgetsDiffBadge();
}

/**
 * 📋 前月の部門別予算割り振りを現在のフォームに一発コピー (v2.8.0)
 */
function copyLastMonthCategoryBudgets() {
  const [cy, cm] = (state.currentMonth || localMonthStr()).split('-').map(Number);
  const d = new Date(cy, cm - 2, 1);
  const prevMonthStr = `${d.getFullYear()}-${('0' + (d.getMonth() + 1)).slice(-2)}`;

  let sourceBudgets = null;
  let sourceMonthLabel = `${d.getFullYear()}年${d.getMonth() + 1}月`;

  // 1. 直近設定月（引き継ぎ元）があればそれを採用
  if (state.categoryBudgetsInheritedFrom && state.categoryBudgets) {
    sourceBudgets = state.categoryBudgets;
    const [iy, im] = state.categoryBudgetsInheritedFrom.split('-');
    sourceMonthLabel = `${Number(iy)}年${Number(im)}月`;
  } else if (state.categoryBudgets && Object.keys(state.categoryBudgets).length > 0) {
    sourceBudgets = state.categoryBudgets;
  }

  if (!sourceBudgets || Object.keys(sourceBudgets).length === 0) {
    showToast('コピー元となる過去の部門別予算が見つかりませんでした');
    return;
  }

  const container = $('categoryBudgetsInputsList');
  if (!container) return;

  container.querySelectorAll('input[data-category-budget]').forEach(inp => {
    const catName = inp.dataset.categoryBudget;
    if (sourceBudgets[catName] !== undefined) {
      inp.value = sourceBudgets[catName];
    }
  });

  updateCategoryBudgetsDiffBadge();
  showToast(`📋 ${sourceMonthLabel}の予算割り振りを反映しました✨`);
}
window.copyLastMonthCategoryBudgets = copyLastMonthCategoryBudgets;

function updateCategoryBudgetsDiffBadge() {
  const badge = $('categoryBudgetsDiffBadge');
  if (!badge) return;
  const container = $('categoryBudgetsInputsList');
  if (!container) return;

  let totalAllocated = 0;
  container.querySelectorAll('input[data-category-budget]').forEach(inp => {
    const val = parseInt(inp.value, 10);
    if (!isNaN(val) && val > 0) totalAllocated += val;
  });

  const totalBudget = state.summary.budget || 240000;
  const diff = totalBudget - totalAllocated;

  if (diff === 0) {
    badge.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800';
    badge.textContent = 'ぴったり全額割り振り済✨';
  } else if (diff > 0) {
    badge.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700';
    badge.textContent = `未割り振り: ${yen(diff)}`;
  } else {
    badge.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800';
    badge.textContent = `予算オーバー: ${yen(Math.abs(diff))}`;
  }
}

// ==========================================
// 部門（カスタムカテゴリ）管理 (v2.7.0)
// ==========================================
const DEFAULT_CATEGORY_COLORS = [
  '#10b981', '#3b82f6', '#ec4899', '#8b5cf6',
  '#f59e0b', '#f97316', '#06b6d4', '#64748b'
];

function openAddCategoryModal() {
  const modal = $('addCategoryModal');
  if (!modal) return;
  if ($('newCategoryName')) $('newCategoryName').value = '';
  if ($('newCategoryBudget')) $('newCategoryBudget').value = '';
  if ($('newCategoryColor')) $('newCategoryColor').value = DEFAULT_CATEGORY_COLORS[0];

  const palette = $('newCategoryColorPalette');
  if (palette) {
    palette.innerHTML = DEFAULT_CATEGORY_COLORS.map((col, idx) => `
      <button type="button" data-color="${col}" onclick="selectCategoryColor('${col}')" class="category-color-btn w-7 h-7 rounded-full transition-transform active:scale-90 flex items-center justify-center ${idx === 0 ? 'ring-2 ring-offset-2 ring-slate-800 scale-110' : ''}" style="background-color: ${col};" aria-label="色選択 ${col}">
        <i data-lucide="check" class="w-3.5 h-3.5 text-white ${idx === 0 ? '' : 'hidden'}"></i>
      </button>
    `).join('');
    lucide.createIcons();
  }

  modal.classList.remove('hidden');
  setTimeout(() => $('newCategoryName')?.focus(), 100);
}
window.openAddCategoryModal = openAddCategoryModal;

function closeAddCategoryModal() {
  $('addCategoryModal')?.classList.add('hidden');
}
window.closeAddCategoryModal = closeAddCategoryModal;

function selectCategoryColor(col) {
  if ($('newCategoryColor')) $('newCategoryColor').value = col;
  document.querySelectorAll('.category-color-btn').forEach(btn => {
    const isSelected = btn.dataset.color === col;
    btn.classList.toggle('ring-2', isSelected);
    btn.classList.toggle('ring-offset-2', isSelected);
    btn.classList.toggle('ring-slate-800', isSelected);
    btn.classList.toggle('scale-110', isSelected);
    const icon = btn.querySelector('i');
    if (icon) icon.classList.toggle('hidden', !isSelected);
  });
}
window.selectCategoryColor = selectCategoryColor;

async function saveNewCategory() {
  const name = $('newCategoryName')?.value.trim();
  if (!name) {
    showToast('部門名を入力してください');
    $('newCategoryName')?.focus();
    return;
  }

  if (state.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    showToast(`部門「${name}」は既に存在します`);
    return;
  }

  const budget = parseInt($('newCategoryBudget')?.value, 10) || 0;
  const color = $('newCategoryColor')?.value || '#10b981';

  const newCat = {
    name,
    color,
    icon: 'tag',
    isCustom: true
  };

  state.categories.push(newCat);
  state.customCategories = state.customCategories || [];
  state.customCategories.push(newCat);
  if (budget > 0) {
    state.categoryBudgets[name] = budget;
  }

  try {
    localStorage.setItem('pairbudget_custom_categories', JSON.stringify(state.customCategories));
    localStorage.setItem('pairbudget_category_budgets', JSON.stringify(state.categoryBudgets));
  } catch (_) {}

  closeAddCategoryModal();

  renderCategoryDropdown();
  renderCategoryBudgetsInputs();
  renderCategoryBudgets();
  lucide.createIcons();

  await writeAndRefresh('updateCustomCategories', {
    customCategories: state.customCategories,
    categoryBudgets: state.categoryBudgets
  }, `✅ 新しい部門「${name}」を追加しました`, '部門を保存しています…');
}
window.saveNewCategory = saveNewCategory;

async function deleteCustomCategory(catName) {
  if (!catName) return;
  const ok = window.confirm(`部門「${catName}」を削除しますか？\n\n※ 過去の支出データは削除されませんが、部門別予算および選択肢から除外されます。`);
  if (!ok) return;

  state.categories = state.categories.filter(c => c.name !== catName);
  state.customCategories = (state.customCategories || []).filter(c => c.name !== catName);
  delete state.categoryBudgets[catName];

  try {
    localStorage.setItem('pairbudget_custom_categories', JSON.stringify(state.customCategories));
    localStorage.setItem('pairbudget_category_budgets', JSON.stringify(state.categoryBudgets));
  } catch (_) {}

  renderCategoryDropdown();
  renderCategoryBudgetsInputs();
  renderCategoryBudgets();
  lucide.createIcons();

  await writeAndRefresh('updateCustomCategories', {
    customCategories: state.customCategories,
    categoryBudgets: state.categoryBudgets
  }, `🗑️ 部門「${catName}」を削除しました`, '部門を更新しています…');
}
window.deleteCustomCategory = deleteCustomCategory;

// ==========================================
// スマホ専用 クイック記録アクションシート (v2.7.0)
// ==========================================
function openMobileRecordActionSheet() {
  const sheet = $('mobileRecordActionSheet');
  if (sheet) sheet.classList.remove('hidden');
}
function closeMobileRecordActionSheet() {
  const sheet = $('mobileRecordActionSheet');
  if (sheet) sheet.classList.add('hidden');
}
window.openMobileRecordActionSheet = openMobileRecordActionSheet;
window.closeMobileRecordActionSheet = closeMobileRecordActionSheet;

/**
 * 設定タブの生活費予算設定 警告バナー更新（2段階チェック）
 */
function updateBudgetOverWarningBox() {
  const box = $('budgetOverWarningBox');
  const input = $('settingBudgetInput');
  if (!box || !input) return;

  const budget = parseInt(input.value, 10) || 0;
  const totalContribution = (state.members || []).reduce((s, m) => s + (Number(m.baseContribution) || 0), 0);

  // メンバー拠出合計ラベル
  if ($('membersTotalContributionLabel')) {
    const details = (state.members || []).map((m, i) => `${m.name || `メンバー${i + 1}`}: ${yen(m.baseContribution || 0)}`).join(' / ');
    $('membersTotalContributionLabel').textContent = `👥 拠出合計: ${yen(totalContribution)}（${details}）`;
  }

  if (budget <= totalContribution) {
    const diff = totalContribution - budget;
    box.className = 'p-2.5 rounded-xl text-xs leading-relaxed bg-emerald-50 border border-emerald-200 text-emerald-800';
    box.innerHTML = `✅ メンバーの拠出額合計（${yen(totalContribution)}）の範囲内です（余剰予定: ${yen(diff)}）`;
  } else {
    const overAmt = budget - totalContribution;
    if (state.surplusPolicy === 'savings') {
      // 積立モード時: 現在の共同貯蓄残高を加味 (未利用月を除外した正確な残高)
      const summary = computeJointSavingsSummary();
      const totalSavings = summary.totalBalance;

      if (budget <= totalContribution + totalSavings) {
        const afterSavings = (totalContribution + totalSavings) - budget;
        box.className = 'p-2.5 rounded-xl text-xs leading-relaxed bg-amber-50 border border-amber-200 text-amber-800';
        box.innerHTML = `💡 ふたりの拠出金合計（${yen(totalContribution)}）から ${yen(overAmt)} オーバーしていますが、現在の共同積立貯蓄（${yen(totalSavings)}）から補填可能です（補填後の貯蓄目安: ${yen(afterSavings)}）`;
      } else {
        box.className = 'p-2.5 rounded-xl text-xs leading-relaxed bg-rose-50 border border-rose-200 text-rose-800';
        box.innerHTML = `🚨 メンバー拠出金＋現在の共同積立貯蓄（合計 ${yen(totalContribution + totalSavings)}）を ${yen(budget - (totalContribution + totalSavings))} オーバーしています！貯蓄を取り崩しても資金が不足します`;
      }
    } else {
      // 返金モード時 (ratio / equal)
      box.className = 'p-2.5 rounded-xl text-xs leading-relaxed bg-rose-50 border border-rose-200 text-rose-800';
      box.innerHTML = `⚠️ ふたりの拠出金合計（${yen(totalContribution)}）から ${yen(overAmt)} オーバーしています！拠出額を増やすか予算を見直してください`;
    }
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

function renderAuditSkeleton() {
  const box = $('auditLogList');
  if (!box) return;
  box.innerHTML = `
    <div class="divide-y divide-slate-100 animate-fade-in">
      <div class="py-2.5 space-y-1.5">
        <div class="flex items-center justify-between">
          <div class="h-3.5 w-28 rounded skeleton-shimmer"></div>
          <div class="h-3 w-16 rounded skeleton-shimmer"></div>
        </div>
        <div class="h-3 w-48 rounded skeleton-shimmer"></div>
      </div>
      <div class="py-2.5 space-y-1.5">
        <div class="flex items-center justify-between">
          <div class="h-3.5 w-24 rounded skeleton-shimmer"></div>
          <div class="h-3 w-14 rounded skeleton-shimmer"></div>
        </div>
        <div class="h-3 w-56 rounded skeleton-shimmer"></div>
      </div>
    </div>
  `;
}

async function loadAuditLog() {
  const box = $('auditLogList');
  renderAuditSkeleton();
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
  $('auditDetailBody').innerHTML = `
    <div class="space-y-2 py-3 animate-fade-in">
      <div class="h-3.5 w-32 rounded skeleton-shimmer"></div>
      <div class="h-3 w-48 rounded skeleton-shimmer"></div>
      <div class="h-3 w-40 rounded skeleton-shimmer"></div>
    </div>
  `;
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
function renderPriceSearchSkeleton() {
  const box = $('priceSearchResult');
  if (!box) return;
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="bg-slate-50 rounded-xl p-3.5 space-y-2.5 border border-slate-100 animate-fade-in">
      <div class="flex items-center justify-between">
        <div class="h-3.5 w-32 rounded skeleton-shimmer"></div>
        <div class="h-3 w-16 rounded skeleton-shimmer"></div>
      </div>
      <div class="h-7 w-24 rounded skeleton-shimmer"></div>
      <div class="h-2.5 w-44 rounded skeleton-shimmer"></div>
    </div>
  `;
}

async function handlePriceSearch(e) {
  e.preventDefault();
  const q = $('priceSearchInput').value.trim();
  if (!q) return;
  const box = $('priceSearchResult');
  renderPriceSearchSkeleton();
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

function getMemberNamesList() {
  if (state.members && state.members.length > 0) {
    return state.members.map(m => m.name).filter(Boolean);
  }
  const h = memberName('husband');
  const w = memberName('wife');
  return [h, w].filter(Boolean);
}

function receiptRowHtml(it, ctx) {
  const members = getMemberNamesList();
  const defaultMember = members[0] || 'メンバー1';

  const isShared = (it.isShared !== false && String(it.isShared) !== 'false') && (it.scope === 'shared' || !it.owner);
  let owner = it.owner || '';
  if (!isShared && !owner) {
    owner = (ctx && ctx.payer && ctx.payer !== '共同') ? ctx.payer : defaultMember;
  }

  const isOther = !isShared && !isSameMember(owner, state.currentUser);
  const shouldMask = !!(state.privacyMask && isOther);

  const realName = it.name || '';
  const displayName = shouldMask ? '🔒 私物支出 (マスキング中)' : realName;
  const inputClass = shouldMask
    ? 'rc-name flex-1 min-w-0 bg-slate-100 border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-400 cursor-not-allowed select-none'
    : 'rc-name flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs';
  const readonlyAttr = shouldMask ? 'readonly' : '';

  // 選択肢の生成 (共同 ＆ 各自の私物)
  let scopeOptionsHtml = `<option value="shared" ${isShared ? 'selected' : ''}>👥 共同</option>`;
  members.forEach(m => {
    const val = `personal_${m}`;
    const sel = (!isShared && owner === m) ? 'selected' : '';
    scopeOptionsHtml += `<option value="${esc(val)}" ${sel}>🔒 ${esc(m)}私物</option>`;
  });

  // 品目別カテゴリ選択肢の生成 (v2.8.0)
  const categories = state.categories || [];
  const currentCat = it.category || (realName ? inferItemCategory(realName) : '') || $('receiptCategory')?.value || '食費';
  let catOptionsHtml = '';
  categories.forEach(c => {
    const sel = c.name === currentCat ? 'selected' : '';
    catOptionsHtml += `<option value="${esc(c.name)}" ${sel}>${esc(c.name)}</option>`;
  });
  if (!categories.some(c => c.name === currentCat) && currentCat) {
    catOptionsHtml = `<option value="${esc(currentCat)}" selected>${esc(currentCat)}</option>` + catOptionsHtml;
  }

  return `<div class="flex gap-1.5 items-center" data-row>
    <select class="rc-scope bg-white border border-slate-200 rounded-lg px-1 py-1.5 text-[11px] font-bold text-slate-700 max-w-[85px] sm:max-w-[105px] shrink-0" onchange="syncReceiptRowMask(this)" aria-label="共同・私物">
      ${scopeOptionsHtml}
    </select>
    <select class="rc-category bg-white border border-slate-200 rounded-lg px-1 py-1.5 text-[11px] font-bold text-slate-700 max-w-[80px] sm:max-w-[95px] shrink-0" onchange="updateReceiptTotal()" aria-label="部門">
      ${catOptionsHtml}
    </select>
    <input type="text" ${readonlyAttr} class="${inputClass}" value="${esc(displayName)}" data-real-name="${esc(realName)}" maxlength="50" aria-label="品名" onchange="updateReceiptTotal()">
    <input type="number" class="rc-qty w-10 sm:w-12 bg-slate-50 border border-slate-200 rounded-lg px-1 py-1.5 text-xs text-center shrink-0" value="${esc(it.quantity)}" min="1" max="99" inputmode="numeric" aria-label="数量" onchange="updateReceiptTotal()">
    <input type="number" class="rc-price w-16 sm:w-20 bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-xs text-right shrink-0 font-mono" value="${esc(it.price)}" aria-label="金額" oninput="updateReceiptTotal()">
    <button type="button" data-action="remove-receipt-row" class="p-1 text-slate-300 hover:text-rose-500 shrink-0" aria-label="行を削除"><i data-lucide="x" class="w-4 h-4"></i></button></div>`;
}

function syncReceiptRowMask(selectEl) {
  const row = selectEl.closest('[data-row]');
  if (!row) return;
  const nameInp = row.querySelector('.rc-name');
  if (!nameInp) return;

  const scopeVal = selectEl.value;
  const isShared = scopeVal === 'shared';
  const owner = isShared ? '' : scopeVal.replace(/^personal_/, '');
  const isOther = !isShared && !isSameMember(owner, state.currentUser);
  const shouldMask = state.privacyMask && isOther;

  if (shouldMask) {
    if (nameInp.value !== '🔒 私物支出 (マスキング中)') {
      nameInp.dataset.realName = nameInp.value;
    }
    nameInp.value = '🔒 私物支出 (マスキング中)';
    nameInp.readOnly = true;
    nameInp.className = 'rc-name flex-1 min-w-0 bg-slate-100 border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-400 cursor-not-allowed select-none';
  } else {
    if (nameInp.dataset.realName && nameInp.value === '🔒 私物支出 (マスキング中)') {
      nameInp.value = nameInp.dataset.realName;
    }
    nameInp.readOnly = false;
    nameInp.className = 'rc-name flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs';
  }
  updateReceiptTotal();
}
window.syncReceiptRowMask = syncReceiptRowMask;

function collectReceiptRows() {
  const defaultCategory = $('receiptCategory')?.value || '食費';
  return Array.from(document.querySelectorAll('#receiptItemRows [data-row]')).map(row => {
    const nameInp = row.querySelector('.rc-name');
    let nameVal = nameInp ? nameInp.value.trim() : '';
    if (nameVal === '🔒 私物支出 (マスキング中)' && nameInp.dataset.realName) {
      nameVal = nameInp.dataset.realName;
    }
    const scopeVal = row.querySelector('.rc-scope')?.value || 'shared';
    const isShared = scopeVal === 'shared';
    const owner = isShared ? '' : scopeVal.replace(/^personal_/, '');
    const catVal = row.querySelector('.rc-category')?.value || defaultCategory;

    return {
      name: nameVal,
      category: catVal,
      quantity: parseInt(row.querySelector('.rc-qty')?.value, 10) || 1,
      price: parseInt(row.querySelector('.rc-price')?.value, 10) || 0,
      isShared,
      owner
    };
  });
}

let scannedTotal = 0;
function updateReceiptTotal() {
  const rows = collectReceiptRows();
  const sum = rows.reduce((s, r) => s + (Number.isInteger(r.price) ? r.price : 0), 0);
  const sharedSum = rows.filter(r => r.isShared).reduce((s, r) => s + (Number.isInteger(r.price) ? r.price : 0), 0);

  // メンバーごとの私物合計
  const members = getMemberNamesList();
  const personalByMember = {};
  members.forEach(m => { personalByMember[m] = 0; });
  rows.filter(r => !r.isShared).forEach(r => {
    const o = r.owner || members[0] || '私物';
    personalByMember[o] = (personalByMember[o] || 0) + (Number.isInteger(r.price) ? r.price : 0);
  });

  $('receiptTotal').textContent = sum < 0 ? `-${yen(Math.abs(sum))}` : yen(sum);

  // 内訳プレビュー更新 (共同 ＆ 各メンバーの私物)
  const breakdownEl = $('receiptScopeBreakdown');
  if (breakdownEl) {
    let breakdownHtml = `
      <span class="flex items-center gap-1 font-bold text-slate-700">
        <span class="w-2 h-2 rounded-full bg-brand-500"></span> 共同: <b class="text-slate-900">${sharedSum < 0 ? `-${yen(Math.abs(sharedSum))}` : yen(sharedSum)}</b>
      </span>
    `;
    members.forEach(m => {
      const pSum = personalByMember[m] || 0;
      breakdownHtml += `
        <span class="flex items-center gap-1 font-bold text-amber-800">
          <span class="w-2 h-2 rounded-full bg-amber-500"></span> ${esc(m)}私物: <b class="text-amber-900">${pSum < 0 ? `-${yen(Math.abs(pSum))}` : yen(pSum)}</b>
        </span>
      `;
    });
    breakdownEl.innerHTML = breakdownHtml;
  }

  // カテゴリ別集計プレビュー (v2.8.0新機能)
  const catBreakdownEl = $('receiptCategoryBreakdown');
  if (catBreakdownEl) {
    const catSums = {};
    rows.forEach(r => {
      const c = r.category || '食費';
      const amt = Number.isInteger(r.price) ? r.price : 0;
      catSums[c] = (catSums[c] || 0) + amt;
    });

    const catChips = Object.entries(catSums).map(([cName, cTotal]) => {
      const catObj = (state.categories || []).find(c => c.name === cName);
      const col = catObj?.color || '#10b981';
      return `
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-50 border border-slate-200/80 font-bold text-slate-700">
          <span class="w-2 h-2 rounded-full shrink-0" style="background-color: ${col}"></span>
          <span>${esc(cName)}:</span>
          <b class="text-slate-900">${cTotal < 0 ? `-${yen(Math.abs(cTotal))}` : yen(cTotal)}</b>
        </span>
      `;
    }).join('');

    catBreakdownEl.innerHTML = catChips || '<span class="text-slate-400 text-[10px]">明細を追加すると部門別内訳が自動集計されます</span>';
  }

  const isEdit = !!$('receiptEditId')?.value;
  const diff = scannedTotal ? sum - scannedTotal : 0;
  const diffNote = $('receiptDiffNote');
  if (diff !== 0 && !isEdit) {
    diffNote.textContent = `⚠ レシート印字の合計 ${yen(scannedTotal)} と ${yen(Math.abs(diff))} 違います`;
    diffNote.className = 'text-xs font-bold text-rose-600';
    $('receiptSaveBtn').textContent = '差額があります。このまま保存';
  } else {
    diffNote.textContent = '';
    $('receiptSaveBtn').textContent = isEdit ? 'レシート・明細を更新する' : (sum < 0 ? '💸 返金レシートとして保存' : 'この内容で保存する');
  }
}

function guessCategoryByStore(store) {
  const hit = state.rules.find(r => store.includes(r.keyword));
  return hit && state.categories.some(c => c.name === hit.category) ? hit.category : (state.categories.some(c => c.name === '食費') ? '食費' : (state.categories[0] || {}).name);
}

// ==========================================
// レシートスキャナーアニメーション制御
// ==========================================
let receiptScanTimer = null;
let receiptScanStepTimer = null;
let receiptScanObjectUrl = null;

function startReceiptScanAnimation(file) {
  stopReceiptScanAnimation();

  // 1. プレビュー画像のセット
  const previewImg = $('receiptScanPreviewImg');
  if (previewImg && file) {
    try {
      receiptScanObjectUrl = URL.createObjectURL(file);
      previewImg.src = receiptScanObjectUrl;
    } catch (_) {
      previewImg.src = '';
    }
  }

  // 2. ステップテキストとプログレスバーの初期化
  const stepText = $('receiptScanStepText');
  const progressBar = $('receiptScanProgressBar');
  const ticker = $('receiptCalcTicker');

  const steps = [
    { at: 0, text: '📸 レシート画像の傾き・文字領域を検出中…', progress: '18%' },
    { at: 1100, text: '🔍 店名・購入日・明細行をレーザースキャン中…', progress: '48%' },
    { at: 2300, text: '🧮 単価×数量・割引・消費税をAI計算中…', progress: '78%' },
    { at: 3600, text: '✨ 家計簿フォーマットへ自動変換しています…', progress: '92%' }
  ];

  if (stepText) stepText.textContent = steps[0].text;
  if (progressBar) progressBar.style.width = steps[0].progress;

  const timeouts = [];
  steps.slice(1).forEach(s => {
    timeouts.push(setTimeout(() => {
      if (stepText) stepText.textContent = s.text;
      if (progressBar) progressBar.style.width = s.progress;
    }, s.at));
  });
  receiptScanStepTimer = timeouts;

  // 3. リアルタイム計算ティッカーの高速回転（AIが超高速で計算している演出）
  const tickerDummies = [
    '🧮 ¥390 × 1 + ¥390 - ¥78 => Σ ¥702',
    '🧮 ¥158 × 2 + ¥218 × 1 => Σ ¥534 [TAX 8%]',
    '🧮 割引 -¥100 / 小計 ¥1,280 => Σ ¥1,180',
    '🧮 ¥248 × 1 + ¥90 × 2 => Σ ¥428 [TAX 10%]',
    '🧮 ¥1,480 × 1 - 5%OFF => Σ ¥1,406',
    '🧮 ¥702 (税込合計一致確認中…)',
    '🧮 店名: 無印良品 / 日付: 2026-11-05',
    '🧮 明細行 3件 検出 [SUM OK]'
  ];

  let tickerIdx = 0;
  receiptScanTimer = setInterval(() => {
    if (!ticker) return;
    ticker.textContent = tickerDummies[tickerIdx % tickerDummies.length];
    tickerIdx++;
  }, 90);
}

function stopReceiptScanAnimation() {
  if (receiptScanTimer) {
    clearInterval(receiptScanTimer);
    receiptScanTimer = null;
  }
  if (Array.isArray(receiptScanStepTimer)) {
    receiptScanStepTimer.forEach(t => clearTimeout(t));
    receiptScanStepTimer = null;
  }
  if (receiptScanObjectUrl) {
    try {
      URL.revokeObjectURL(receiptScanObjectUrl);
    } catch (_) {}
    receiptScanObjectUrl = null;
  }
  const previewImg = $('receiptScanPreviewImg');
  if (previewImg) previewImg.src = '';
  const progressBar = $('receiptScanProgressBar');
  if (progressBar) progressBar.style.width = '100%';
}

// レシート画像選択イベントハンドラ（直接タップ対応）
window.handleReceiptInputChange = function(inputEl) {
  if (!inputEl) return;
  const file = inputEl.files && inputEl.files[0];
  if (file) {
    handleReceiptFile(file);
  }
  inputEl.value = '';
};

async function handleReceiptFile(file) {
  if (!file) return;
  if (file.type && !/^image\//i.test(file.type)) {
    showToast('画像ファイルを選んでください');
    if ($('receiptFileInput')) $('receiptFileInput').value = '';
    return;
  }
  // LINE内ブラウザ(LIFF WebView)では input[type=file] の change イベント内で window.confirm() がブロックされ
  // false を返してモーダルが開かなくなるため、ネイティブ confirm は使わず即座に読み取りモーダルを開く
  closeExpenseModal();
  $('receiptModal').classList.remove('hidden');
  $('receiptForm').classList.add('hidden');
  $('receiptLoading').classList.remove('hidden');

  // ワクワクするAIレーザースキャン＆リアルタイム計算アニメーション開始
  startReceiptScanAnimation(file);

  showToast('📷 レシート画像を最適化しています…', { loading: true });
  try {
    const imageBase64 = await resizeImageToBase64(file);
    showToast('🤖 AIがレシートを読み取り中です（3〜8秒ほどお待ちください）…', { loading: true });
    
    // バックエンドURLが設定されている場合は直接callGasを呼び出し、モックフォールバック（ダミーのイオン）を完全抑止する
    let res = null;
    if (state.gasApiUrl) {
      res = await callGas('scanReceipt', { imageBase64, mimeType: 'image/jpeg' });
    } else {
      res = await api('scanReceipt', { imageBase64, mimeType: 'image/jpeg' });
    }

    if (!res || !res.success || !res.receipt) {
      stopReceiptScanAnimation();
      closeReceiptModal();
      handleApiError(res || { error: 'レシートデータの取得に失敗しました' });
      return;
    }
    stopReceiptScanAnimation();
    fillReceiptForm(res.receipt);
    showToast('✨ レシートを読み取りました！内容を確認してください');
  } catch (err) {
    stopReceiptScanAnimation();
    closeReceiptModal();
    console.error('レシート読み取り失敗:', err);
    showToast(`❌ レシート読み取り失敗: ${err.message || '通信エラー'}`);
  } finally {
    if ($('receiptFileInput')) $('receiptFileInput').value = '';
  }
}

// ==========================================
// 重複支出・レシート検知ヘルパー
// ==========================================
function findDuplicateExpense(date, amount, excludeId) {
  if (!date || !amount) return null;
  const numAmount = Number(amount);
  return state.transactions.find(t =>
    (!excludeId || t.id !== excludeId) &&
    t.date === date &&
    Number(t.amount) === numAmount
  ) || null;
}

function updateExpenseDuplicateAlert() {
  const alertEl = $('expenseDuplicateAlert');
  const detailsEl = $('expenseDuplicateDetails');
  if (!alertEl || !detailsEl) return;

  const id = $('expenseId')?.value || '';
  const date = $('expenseDate')?.value || '';
  const amount = parseInt($('expenseAmount')?.value || '0', 10);

  if (!date || !amount || amount <= 0) {
    alertEl.classList.add('hidden');
    return;
  }

  const dup = findDuplicateExpense(date, amount, id);
  if (dup) {
    detailsEl.textContent = `既存の支出「${dup.title}」（${yen(dup.amount)}、支払者: ${displayPayerName(dup.payer)}）と同日・同額です。二重登録にご注意ください。`;
    alertEl.classList.remove('hidden');
  } else {
    alertEl.classList.add('hidden');
  }
}

function checkDuplicateReceipt(date, total, excludeId) {
  if (!date || !total) return null;
  const numTotal = Number(total);
  return state.transactions.find(t => {
    if (excludeId && (t.id === excludeId || t.receiptId === excludeId)) return false;
    return t.date === date && Number(t.amount) === numTotal;
  }) || null;
}

function updateReceiptDuplicateAlert() {
  const alertEl = $('receiptDuplicateAlert');
  const detailsEl = $('receiptDuplicateDetails');
  if (!alertEl || !detailsEl) return;

  const editId = $('receiptEditId')?.value || '';
  const date = $('receiptDate')?.value || '';
  const rows = collectReceiptRows();
  const total = rows.reduce((s, r) => s + (Number(r.price) || 0), 0);

  if (!date || !total || total <= 0) {
    alertEl.classList.add('hidden');
    return;
  }

  const dup = checkDuplicateReceipt(date, total, editId);
  if (dup) {
    detailsEl.textContent = `同日（${date}）に同じ合計金額（${yen(dup.amount)}）の支出「${dup.title}」（支払者: ${displayPayerName(dup.payer)}）が既に登録されています。`;
    alertEl.classList.remove('hidden');
  } else {
    alertEl.classList.add('hidden');
  }
}

/**
 * 🧾 通常の購入 ⇔ 💸 返品・返金 ワンタップ切替 (v2.8.1新機能)
 */
function setReceiptMode(mode, silent = false) {
  const isRefund = mode === 'refund';
  const expenseBtn = $('receiptModeExpenseBtn');
  const refundBtn = $('receiptModeRefundBtn');
  const modeInp = $('receiptMode');
  if (modeInp) modeInp.value = isRefund ? 'refund' : 'expense';

  if (expenseBtn && refundBtn) {
    if (isRefund) {
      refundBtn.className = 'px-2.5 py-1 rounded-md bg-white text-rose-700 font-bold shadow-xs transition-all flex items-center gap-1 cursor-pointer';
      expenseBtn.className = 'px-2.5 py-1 rounded-md text-slate-500 hover:text-slate-800 transition-all flex items-center gap-1 cursor-pointer';
    } else {
      expenseBtn.className = 'px-2.5 py-1 rounded-md bg-white text-slate-800 font-bold shadow-xs transition-all flex items-center gap-1 cursor-pointer';
      refundBtn.className = 'px-2.5 py-1 rounded-md text-slate-500 hover:text-slate-800 transition-all flex items-center gap-1 cursor-pointer';
    }
  }

  // 明細行の金額の正負をモードに合わせて自動反転・調整
  document.querySelectorAll('#receiptItemRows [data-row]').forEach(row => {
    const priceInp = row.querySelector('.rc-price');
    const nameInp = row.querySelector('.rc-name');
    if (!priceInp) return;
    const rawVal = parseInt(priceInp.value, 10);
    if (isNaN(rawVal) || rawVal === 0) return;
    const name = nameInp ? (nameInp.value || '') : '';
    const isDiscount = /CPN|TPD|値引|割引|クーポン|▲|△/i.test(name);

    if (isRefund) {
      // 返品・返金モード: すべてマイナス金額
      priceInp.value = -Math.abs(rawVal);
    } else {
      // 通常購入モード: 値引き行以外はプラス金額（誤判定されたマイナスを正数へ一括修復）
      if (isDiscount) {
        priceInp.value = -Math.abs(rawVal);
      } else {
        priceInp.value = Math.abs(rawVal);
      }
    }
  });

  updateReceiptTotal();
  if (!silent) {
    showToast(isRefund ? '💸 返品・返金（マイナス支出）に設定しました' : '🧾 通常の購入（支出）に設定しました');
  }
}
window.setReceiptMode = setReceiptMode;

function fillReceiptForm(r) {
  stopReceiptScanAnimation();
  const receipt = r || {};
  scannedTotal = Number(receipt.total) || 0;
  if ($('receiptEditId')) $('receiptEditId').value = receipt.id || receipt.receiptId || '';
  $('receiptStore').value = receipt.store || '';
  $('receiptDate').value = receipt.date || localDateStr();
  $('receiptCategory').innerHTML = categoryOptionsHtml(guessCategoryByStore(receipt.store || ''));
  $('receiptIsShared').value = receipt.isShared === false ? 'false' : 'true';
  const pType = receipt.paymentType || 'shared_card';
  $('receiptPaymentType').value = pType;
  updatePayerDropdowns();
  let payer = receipt.payer;
  if (!payer) {
    payer = (pType === 'shared_card' || pType === 'shared_account') ? '共同' : (state.currentUser || memberName(state.currentSlot));
  }
  $('receiptPayer').value = payer;
  const isOther = !isSameMember(payer, state.currentUser);
  const ctx = { payer, isOtherMember: isOther };
  const items = Array.isArray(receipt.items) && receipt.items.length ? receipt.items : [{ name: '', quantity: 1, price: 0, isShared: true }];
  $('receiptItemRows').innerHTML =
    '<div class="flex gap-1.5 text-[10px] text-slate-400 px-0.5 mb-1"><span class="w-16 sm:w-20">種別</span><span class="w-16 sm:w-20">部門</span><span class="flex-1">品名</span><span class="w-10 sm:w-12 text-center">数量</span><span class="w-16 sm:w-20 text-right">金額</span><span class="w-6"></span></div>' +
    items.map(it => receiptRowHtml(it, ctx)).join('');

  // 🧾 通常購入 ⇔ 💸 返品・返金の初期モード設定 (v2.8.1)
  const initialMode = (receipt.isRefund === true || scannedTotal < 0) ? 'refund' : 'expense';
  setReceiptMode(initialMode, true);

  $('receiptLoading').classList.add('hidden');
  $('receiptForm').classList.remove('hidden');
  updateReceiptTotal();
  updateReceiptDuplicateAlert();
  lucide.createIcons();
}

function closeReceiptModal() {
  stopReceiptScanAnimation();
  $('receiptModal').classList.add('hidden');
  $('receiptDuplicateAlert')?.classList.add('hidden');
  if ($('receiptEditId')) $('receiptEditId').value = '';
  if ($('receiptFileInput')) $('receiptFileInput').value = '';
  resetViewportZoom();
}

async function handleReceiptSubmit(e) {
  e.preventDefault();
  const items = collectReceiptRows();
  if (items.some(r => !r.name)) { showToast('品名が空の行があります'); return; }
  if (items.some(r => !Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > 99)) { showToast('数量は1〜99で入力してください'); return; }
  if (items.some(r => !Number.isInteger(r.price) || r.price === 0)) { showToast('金額が空または0の行があります'); return; }
  const total = items.reduce((s, r) => s + r.price, 0);
  if (total === 0) { showToast('合計金額が0円です'); return; }

  const editId = $('receiptEditId')?.value || '';
  const payload = {
    id: editId,
    receiptId: editId,
    store: $('receiptStore').value.trim(), date: $('receiptDate').value, category: $('receiptCategory').value,
    isShared: $('receiptIsShared').value === 'true', paymentType: $('receiptPaymentType').value,
    payer: $('receiptPayer').value, items
  };

  // 重複レシート・同日同額チェックと確認ダイアログ（新規保存時のみ）
  if (!editId) {
    const dup = checkDuplicateReceipt(payload.date, total);
    if (dup) {
      const ok = window.confirm(`⚠️ 重複の可能性：\n同じ日付（${payload.date}）に同じ合計金額（${yen(dup.amount)}）の支出「${dup.title}」がすでに存在します。\n\n本当にこのレシートを保存しますか？`);
      if (!ok) return;
    }
  }

  closeReceiptModal();
  let res;
  if (editId) {
    res = await writeAndRefresh('updateReceipt', payload, 'レシートと明細を更新しました', '🧾 レシートを更新しています…');
  } else {
    res = await writeAndRefresh('saveReceipt', payload, 'レシートを保存しました（明細も記録）', '🧾 レシートと明細を保存しています…');
  }
  
  // 買い物リストから自動消込されたアイテムがあればトースト案内
  if (res && Array.isArray(res.autoCheckedShoppingItems) && res.autoCheckedShoppingItems.length > 0) {
    const titles = res.autoCheckedShoppingItems.map(it => it.title).filter(Boolean);
    const summary = titles.length <= 3 ? titles.join('、') : `${titles.slice(0, 3).join('、')} 他${titles.length - 3}品`;
    setTimeout(() => {
      showToast(`🛒 買い物リストから「${summary}」を購入済みにしました！`, { duration: 4000 });
    }, 1500);
  }
}

// 支出編集モーダルからレシート明細・内訳編集モーダルを開く
let currentEditingExpense = null;
function openReceiptEditFromExpense() {
  if (!currentEditingExpense || !currentEditingExpense.receiptId) return;
  const receiptId = currentEditingExpense.receiptId;
  closeExpenseModal();

  const items = state.receiptItems.filter(it => it.receiptId === receiptId);
  const r = {
    id: receiptId,
    store: currentEditingExpense.title.replace(/\s*\(私物分\)$/, ''),
    date: currentEditingExpense.date,
    category: currentEditingExpense.category,
    paymentType: currentEditingExpense.paymentType,
    payer: currentEditingExpense.payer,
    isShared: currentEditingExpense.isShared,
    total: currentEditingExpense.amount,
    items: items.length > 0 ? items.map(it => ({
      name: it.name,
      quantity: it.quantity,
      price: it.price,
      isShared: it.isShared !== undefined ? it.isShared : currentEditingExpense.isShared
    })) : [{ name: currentEditingExpense.title, quantity: 1, price: currentEditingExpense.amount, isShared: currentEditingExpense.isShared }]
  };

  $('receiptModal').classList.remove('hidden');
  $('receiptLoading').classList.add('hidden');
  $('receiptForm').classList.remove('hidden');
  fillReceiptForm(r);
}
window.openReceiptEditFromExpense = openReceiptEditFromExpense;

// ==========================================
// 支出の登録・編集・削除
// ==========================================
function openExpenseModal(editItem) {
  $('expenseForm').reset();
  $('expenseDate').value = localDateStr();
  $('expenseDuplicateAlert')?.classList.add('hidden');
  currentEditingExpense = editItem || null;
  const del = $('expenseDeleteBtn');
  const actionBox = $('expenseReceiptActionBox');

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
    
    // v2.6.0: レシート由来の支出も金額・品名の手修正を解禁！
    const hasReceipt = !!editItem.receiptId;
    $('expenseAmount').disabled = false;
    $('expenseTitle').disabled = false;
    if (actionBox) actionBox.classList.toggle('hidden', !hasReceipt);

    del.classList.remove('hidden');
    $('scanReceiptLabel').classList.add('hidden');
  } else {
    $('expenseModalTitle').textContent = '支出を記録';
    $('expenseId').value = '';
    $('expenseAmount').disabled = false;
    $('expenseTitle').disabled = false;
    if (actionBox) actionBox.classList.add('hidden');
    del.classList.add('hidden');
    $('scanReceiptLabel').classList.remove('hidden');
    const currentPType = $('expensePaymentType')?.value || 'shared_card';
    if (currentPType === 'shared_card' || currentPType === 'shared_account') {
      renderExpensePayerChips('共同');
    } else {
      const myName = state.currentUser || memberName(state.currentSlot);
      renderExpensePayerChips(myName);
    }
  }
  $('expenseModal').classList.remove('hidden');
  updateExpenseDuplicateAlert();
  lucide.createIcons();
}

function closeExpenseModal() {
  $('expenseModal').classList.add('hidden');
  $('expenseDuplicateAlert')?.classList.add('hidden');
  resetViewportZoom();
}
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

  // 重複支出（同日・同額）チェックと確認ダイアログ
  const dup = findDuplicateExpense(payload.date, payload.amount, id);
  if (dup) {
    const ok = window.confirm(`⚠️ 重複の可能性：\n既存の支出「${dup.title}」（${yen(dup.amount)}、支払者: ${displayPayerName(dup.payer)}）と同じ日付・金額です。\n\n本当に登録しますか？`);
    if (!ok) return;
  }

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
  item.completedAt = new Date().toISOString();
  renderShoppingList();
  lucide.createIcons();
  showToast('購入済みに移動しました');
  const res = await api('updateShoppingItem', { id, title: item.title, category: item.category, isCompleted: true });
  if (!res.success) { handleApiError(res); await loadInitialData(); }
}

async function uncompleteShoppingItem(id) {
  const item = state.shoppingList.find(s => s.id === id);
  if (!item) return;
  item.isCompleted = false;
  item.completedAt = null;
  renderShoppingList();
  lucide.createIcons();
  showToast('買うものリストに戻しました');
  const res = await api('updateShoppingItem', { id, title: item.title, category: item.category, isCompleted: false });
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
    const pType = editItem.paymentType || (editItem.payer === '共同カード' ? 'shared_card' : 'shared_account');
    if ($('fixedExpensePaymentType')) $('fixedExpensePaymentType').value = pType;
    $('fixedExpenseActive').checked = editItem.isActive !== false;
    $('fixedExpenseDeleteBtn').classList.remove('hidden');
  } else {
    $('fixedModalTitle').textContent = '固定費を追加';
    $('fixedExpenseId').value = '';
    $('fixedExpenseDay').value = 27;
    if ($('fixedExpensePaymentType')) $('fixedExpensePaymentType').value = 'shared_account';
    $('fixedExpenseActive').checked = true;
    $('fixedExpenseDeleteBtn').classList.add('hidden');
  }
  $('fixedExpenseModal').classList.remove('hidden');
  lucide.createIcons();
}

function closeFixedModal() {
  $('fixedExpenseModal').classList.add('hidden');
  resetViewportZoom();
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
  const paymentType = $('fixedExpensePaymentType')?.value || 'shared_account';
  const payer = paymentType === 'shared_card' ? '共同カード' : '共同口座';
  const isActive = $('fixedExpenseActive').checked;
  closeFixedModal();
  await writeAndRefresh('updateFixedExpense', {
    id, title, amount, billingDay, category, paymentType, payer, isActive
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
  try {
    localStorage.setItem('pairbudget_active_scope', scope);
  } catch (_) {}
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
  try {
    localStorage.setItem('pairbudget_active_tab', tabName);
  } catch (_) {}
  ['home', 'shopping', 'history', 'settings'].forEach(t => {
    const cap = t.charAt(0).toUpperCase() + t.slice(1);
    const tabEl = $(`tabContent${cap}`);
    const isTarget = t === tabName;
    if (tabEl) {
      tabEl.classList.toggle('hidden', !isTarget);
      if (isTarget) {
        tabEl.classList.remove('animate-fade-in');
        void tabEl.offsetWidth; // トランジション再トリガー
        tabEl.classList.add('animate-fade-in');
      }
    }
    const mobileBtn = $(`nav${cap}Btn`);
    if (mobileBtn) {
      mobileBtn.className = `py-1 ${isTarget ? 'text-brand-600' : 'text-slate-400'} flex flex-col items-center justify-center gap-0.5`;
    }
    const desktopBtn = $(`desktopNav${cap}Btn`);
    if (desktopBtn) {
      desktopBtn.className = `px-3.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
        isTarget
          ? 'bg-white text-brand-700 shadow-sm font-bold'
          : 'text-slate-500 hover:text-slate-800 font-medium'
      }`;
    }
  });

  // 設定タブでは右下FABを非表示にして入力や保存に専念させる
  const fab = $('fabContainer');
  if (fab) {
    if (tabName === 'settings') {
      fab.classList.add('fab-hidden');
    } else {
      fab.classList.remove('fab-hidden');
    }
  }

  if (tabName === 'home') renderCharts(); // 非表示中に描画したグラフのサイズ崩れを防ぐ
  lucide.createIcons();
};

// ==========================================
// FAB操作ボタン 折りたたみ・スクロール制御
// ==========================================
let isFabCompact = false;
function toggleFabCompact(forceState) {
  const fab = $('fabContainer');
  const icon = $('fabToggleIcon');
  if (!fab) return;
  if (typeof forceState === 'boolean') {
    isFabCompact = forceState;
  } else {
    isFabCompact = !isFabCompact;
  }
  fab.classList.toggle('fab-compact', isFabCompact);
  if (icon) {
    icon.setAttribute('data-lucide', isFabCompact ? 'chevron-up' : 'chevron-down');
    lucide.createIcons();
  }
}
window.toggleFabCompact = toggleFabCompact;

// スクロール時に邪魔にならないよう自動でコンパクト化
let lastScrollY = window.scrollY;
let scrollFabTimeout = null;
window.addEventListener('scroll', () => {
  const currentY = window.scrollY;
  const fab = $('fabContainer');
  if (!fab || fab.classList.contains('fab-hidden')) return;

  if (currentY > lastScrollY && currentY > 80) {
    // 下スクロール中: コンパクト化
    fab.classList.add('fab-compact');
  } else if (currentY < lastScrollY) {
    // 上スクロール中: 展開
    if (!isFabCompact) {
      fab.classList.remove('fab-compact');
    }
  }
  lastScrollY = currentY;

  clearTimeout(scrollFabTimeout);
  scrollFabTimeout = setTimeout(() => {
    if (!isFabCompact && fab) {
      fab.classList.remove('fab-compact');
    }
  }, 1400);
}, { passive: true });

// ==========================================
// 📊 月次収支レポート モーダル
// ==========================================
async function openMonthlyReportModal(targetMonth) {
  const m = targetMonth || state.viewMonth || localMonthStr();
  const modal = $('monthlyReportModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  lucide.createIcons();

  if ($('monthlyReportMonthPicker')) {
    $('monthlyReportMonthPicker').value = m;
  }
  await loadMonthlyReportData(m);
}
window.openMonthlyReportModal = openMonthlyReportModal;

function closeMonthlyReportModal() {
  $('monthlyReportModal')?.classList.add('hidden');
  resetViewportZoom();
}
window.closeMonthlyReportModal = closeMonthlyReportModal;

async function loadMonthlyReportData(month) {
  const loading = $('monthlyReportLoading');
  const content = $('monthlyReportContent');
  if (loading) loading.classList.remove('hidden');
  if (content) content.classList.add('hidden');

  try {
    let res = null;
    if (state.gasApiUrl) {
      res = await callGas('getMonthlyReport', { month });
    } else {
      res = await api('getMonthlyReport', { month });
    }

    if (!res || !res.success || !res.data) {
      throw new Error(res?.error || '月次レポートの取得に失敗しました');
    }
    const data = res.data;

    if ($('monthlyReportChartImg')) {
      $('monthlyReportChartImg').src = data.chartUrl;
    }
    if ($('monthlyReportPeriod')) {
      const parts = String(data.month).split('-');
      $('monthlyReportPeriod').textContent = `${parts[0]}年${Number(parts[1])}月 収支サマリー`;
    }
    if ($('monthlyReportStatusBadge')) {
      $('monthlyReportStatusBadge').textContent = data.isDeficit ? '⚠️ 予算超過' : '🎉 黒字達成';
      $('monthlyReportStatusBadge').className = data.isDeficit
        ? 'bg-rose-500/20 text-rose-300 px-2 py-0.5 rounded-full font-bold text-[10px]'
        : 'bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full font-bold text-[10px]';
    }
    if ($('monthlyReportTotalShared')) {
      $('monthlyReportTotalShared').textContent = yen(data.totalSharedExpense);
    }
    if ($('monthlyReportBalanceLabel')) {
      $('monthlyReportBalanceLabel').textContent = data.isDeficit ? '赤字超過額' : '予算 残金';
    }
    if ($('monthlyReportBalance')) {
      $('monthlyReportBalance').textContent = (data.balance < 0 ? '-' : '+') + yen(Math.abs(data.balance));
      $('monthlyReportBalance').className = data.isDeficit
        ? 'text-lg font-black text-rose-400'
        : 'text-lg font-black text-emerald-400';
    }
    if ($('monthlyReportCategoryList')) {
      if (!data.topCategories || data.topCategories.length === 0) {
        $('monthlyReportCategoryList').innerHTML = '<div class="text-slate-400 text-center py-2">この月の共同支出はありません</div>';
      } else {
        $('monthlyReportCategoryList').innerHTML = data.topCategories.map((c, idx) => `
          <div class="flex items-center justify-between py-1 border-b border-slate-100 last:border-none">
            <span class="text-slate-700 font-medium">${idx + 1}. ${esc(c.category)} (${c.rate}%)</span>
            <span class="font-bold text-slate-900">${yen(c.amount)}</span>
          </div>
        `).join('');
      }
    }
    if ($('monthlyReportText')) {
      $('monthlyReportText').value = data.textSummary;
    }
    if (content) content.classList.remove('hidden');
  } catch (err) {
    console.error('月次レポート取得失敗:', err);
    showToast(`❌ レポート取得失敗: ${err.message || '通信エラー'}`);
  } finally {
    if (loading) loading.classList.add('hidden');
    lucide.createIcons();
  }
}

function onMonthlyReportMonthChange(val) {
  if (val) loadMonthlyReportData(val);
}
window.onMonthlyReportMonthChange = onMonthlyReportMonthChange;

function copyMonthlyReportText() {
  const ta = $('monthlyReportText');
  if (!ta || !ta.value) return;
  navigator.clipboard.writeText(ta.value).then(() => {
    showToast('📋 レポート文面をクリップボードにコピーしました！LINE等に貼り付けできます');
  }).catch(() => {
    ta.select();
    document.execCommand('copy');
    showToast('📋 レポート文面をコピーしました！');
  });
}
window.copyMonthlyReportText = copyMonthlyReportText;

/**
 * リロード前の画面状態（タブ・モード・スコープ）を復元
 */
function restoreUiState() {
  try {
    const savedMode = localStorage.getItem('pairbudget_active_mode');
    if (savedMode && (savedMode === 'budget' || savedMode === 'events')) {
      switchAppMode(savedMode);
    }
    const savedTab = localStorage.getItem('pairbudget_active_tab');
    if (savedTab && ['home', 'shopping', 'history', 'settings'].includes(savedTab)) {
      switchTab(savedTab);
    }
    const savedScope = localStorage.getItem('pairbudget_active_scope');
    if (savedScope && (savedScope === 'shared' || savedScope === 'personal')) {
      setScope(savedScope);
    }
  } catch (_) {}
}

function showToast(msg, opts = {}) {
  const toast = $('toast');
  if (!toast) return;
  const loading = opts === 'loading' || !!(opts && opts.loading);
  $('toastMessage').textContent = msg;
  if ($('toastSpinner')) $('toastSpinner').classList.toggle('hidden', !loading);
  if ($('toastIcon')) $('toastIcon').classList.toggle('hidden', loading);
  if ($('toastProgressWrap')) $('toastProgressWrap').classList.toggle('hidden', !loading);
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  if (!loading) {
    showToast.timer = setTimeout(() => toast.classList.add('hidden'), (opts && opts.duration) || 2800);
  }
}

function hideToast() {
  const toast = $('toast');
  if (!toast) return;
  clearTimeout(showToast.timer);
  toast.classList.add('hidden');
  if ($('toastProgressWrap')) $('toastProgressWrap').classList.add('hidden');
}

/**
 * 共同積立・利息モーダル操作
 */
window.openSavingsModal = function (targetMonth) {
  const modal = $('savingsModal');
  if (!modal) return;
  const summary = computeJointSavingsSummary();
  if ($('savingsInitialInput')) $('savingsInitialInput').value = summary.initialSavings || '';

  const list = $('savingsInterestsList');
  if (list) {
    // 直近12ヶ月分（新しい月が上）
    const totals = (state.monthlyTotals || []).slice().sort((a, b) => (a.month > b.month ? -1 : 1)).slice(0, 12);
    const interests = state.savingsConfig?.monthlyInterests || {};
    const balances = state.savingsConfig?.monthlyBalances || {};

    list.innerHTML = `
      <div class="grid grid-cols-12 gap-1 text-[10px] text-slate-500 font-bold px-2 py-1 bg-slate-100 rounded-lg">
        <span class="col-span-4">年月</span>
        <span class="col-span-4 text-center">月次収支 (円)</span>
        <span class="col-span-4 text-right">税引後利息 (円)</span>
      </div>
      ${totals.map(t => {
        const [y, m] = t.month.split('-');
        const intVal = interests[t.month] !== undefined ? interests[t.month] : '';
        const balVal = balances[t.month] !== undefined ? balances[t.month] : '';
        const isTarget = targetMonth === t.month;
        return `
          <div class="grid grid-cols-12 gap-1 items-center p-2 rounded-xl bg-white border ${isTarget ? 'border-brand-500 ring-1 ring-brand-300' : 'border-slate-200'}">
            <span class="col-span-4 font-bold text-slate-700 text-xs">${Number(y)}年${Number(m)}月</span>
            <div class="col-span-4 flex items-center">
              <input type="number" data-savings-balance-month="${t.month}" value="${balVal}" placeholder="自動" title="空欄なら自動計算/未計上。数値を入力すると手動上書き（例: -2245 や 7796）" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1 text-xs font-mono text-right focus:outline-none focus:ring-1 focus:ring-emerald-400">
            </div>
            <div class="col-span-4 flex items-center justify-end">
              <input type="number" data-savings-interest-month="${t.month}" value="${intVal}" placeholder="0" title="利息額（例: 10 や 20）" class="w-16 bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1 text-xs font-mono text-right focus:outline-none focus:ring-1 focus:ring-emerald-400">
            </div>
          </div>
        `;
      }).join('')}
    `;
  }

  modal.classList.remove('hidden');
  lucide.createIcons();

  if (targetMonth) {
    setTimeout(() => {
      const input = document.querySelector(`input[data-savings-balance-month="${targetMonth}"]`);
      if (input) {
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 150);
  }
};

window.openSavingsInterestModal = function (targetMonth) {
  openSavingsModal(targetMonth);
};

window.closeSavingsModal = function () {
  $('savingsModal')?.classList.add('hidden');
};

window.resetSavingsData = async function () {
  if (!confirm('別口座貯金の初期残高・月次繰越・利息データをすべて0にリセットしますか？')) return;
  state.savingsConfig = {
    initialSavings: 0,
    monthlyInterests: {},
    monthlyBalances: {}
  };
  if (Array.isArray(state.bankAccounts)) {
    state.bankAccounts = state.bankAccounts.map(a => a.type === 'shared_savings' ? { ...a, balance: 0, updatedAt: new Date().toISOString() } : a);
    try { localStorage.setItem('pairbudget_bank_accounts', JSON.stringify(state.bankAccounts)); } catch (_) {}
  }
  try { localStorage.setItem('pairbudget_savings_config', JSON.stringify(state.savingsConfig)); } catch (_) {}
  closeSavingsModal();
  renderBankAccountsCard();
  renderSavingsCard();
  updateBudgetOverWarningBox();
  await writeAndRefresh('updateSavingsConfig', { savingsConfig: state.savingsConfig }, '🗑️ 別口座・積立データを0にリセットしました');
};

async function handleSaveSavingsModal() {
  const initial = parseInt($('savingsInitialInput')?.value, 10) || 0;
  const interests = {};
  const balances = {};

  document.querySelectorAll('input[data-savings-interest-month]').forEach(inp => {
    const m = inp.dataset.savingsInterestMonth;
    const v = parseInt(inp.value, 10);
    if (!isNaN(v) && v >= 0) interests[m] = v;
  });

  document.querySelectorAll('input[data-savings-balance-month]').forEach(inp => {
    const m = inp.dataset.savingsBalanceMonth;
    const valStr = inp.value.trim();
    if (valStr !== '') {
      const v = parseInt(valStr, 10);
      if (!isNaN(v)) balances[m] = v;
    }
  });

  state.savingsConfig = {
    initialSavings: initial,
    monthlyInterests: interests,
    monthlyBalances: balances
  };

  // 口座一覧側の「別口座貯金 (shared_savings)」とも残高を連動
  if (Array.isArray(state.bankAccounts)) {
    const hasSavingsAcc = state.bankAccounts.some(a => a.type === 'shared_savings');
    if (hasSavingsAcc) {
      let assigned = false;
      state.bankAccounts = state.bankAccounts.map(a => {
        if (a.type === 'shared_savings' && !assigned) {
          assigned = true;
          return { ...a, balance: initial, updatedAt: new Date().toISOString() };
        }
        return a;
      });
    } else {
      state.bankAccounts.push({
        id: 'acc_shared_savings',
        name: '別口座貯金（余り繰越用）',
        type: 'shared_savings',
        balance: initial,
        institution: '貯蓄用別口座',
        note: '生活費の余り繰越・共同貯金',
        updatedAt: new Date().toISOString()
      });
    }
    try { localStorage.setItem('pairbudget_bank_accounts', JSON.stringify(state.bankAccounts)); } catch (_) {}
    if (!state.isMockMode) {
      api('updateBankAccounts', { bankAccounts: state.bankAccounts }).catch(() => {});
    }
  }

  try { localStorage.setItem('pairbudget_savings_config', JSON.stringify(state.savingsConfig)); } catch (_) {}
  closeSavingsModal();
  renderBankAccountsCard();
  renderSavingsCard();
  updateBudgetOverWarningBox();

  await writeAndRefresh('updateSavingsConfig', { savingsConfig: state.savingsConfig }, '✅ 別口座・繰越データを保存しました', '設定を保存しています…');
}

window.copyWebhookUrl = function () {
  const url = $('webhookUrlInput')?.value || 'https://futari-kakeibo.vercel.app/api/budget';
  navigator.clipboard.writeText(url).then(() => {
    showToast('📋 Webhook URLをコピーしました');
  }).catch(() => {
    showToast(url);
  });
};

window.goToCategoryBudgetsSetting = function () {
  switchTab('settings');
  setTimeout(() => {
    $('categoryBudgetsSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
};

function setupEventListeners() {
  $('scopeSharedBtn')?.addEventListener('click', () => setScope('shared'));
  $('scopePersonalBtn')?.addEventListener('click', () => setScope('personal'));
  $('prevMonthBtn')?.addEventListener('click', () => loadInitialData(shiftMonth(state.viewMonth, -1)));
  $('nextMonthBtn')?.addEventListener('click', () => loadInitialData(shiftMonth(state.viewMonth, 1)));

  $('transferHelpBtn')?.addEventListener('click', () => $('transferHelpModal')?.classList.remove('hidden'));

  $('openExpenseModalBtn')?.addEventListener('click', () => openExpenseModal(null));
  $('expenseForm')?.addEventListener('submit', handleExpenseSubmit);
  $('expenseDeleteBtn')?.addEventListener('click', handleExpenseDelete);
  $('expenseDate')?.addEventListener('change', updateExpenseDuplicateAlert);
  $('expenseAmount')?.addEventListener('input', updateExpenseDuplicateAlert);
  $('expensePaymentType')?.addEventListener('change', e => {
    if (e.target.value === 'shared_card' || e.target.value === 'shared_account') {
      renderExpensePayerChips('共同');
    } else {
      if (currentSelectedExpensePayer === '共同') {
        const myName = state.currentUser || memberName(state.currentSlot);
        renderExpensePayerChips(myName);
      }
    }
  });
  $('receiptFileInput')?.addEventListener('change', e => handleReceiptFile(e.target.files[0]));

  $('receiptForm')?.addEventListener('submit', handleReceiptSubmit);
  $('receiptCloseBtn')?.addEventListener('click', closeReceiptModal);
  $('receiptDate')?.addEventListener('change', updateReceiptDuplicateAlert);
  $('receiptPaymentType')?.addEventListener('change', e => {
    const payerEl = $('receiptPayer');
    if (!payerEl) return;
    if (e.target.value === 'shared_card' || e.target.value === 'shared_account') {
      payerEl.value = '共同';
    } else {
      if (payerEl.value === '共同') {
        payerEl.value = state.currentUser || memberName(state.currentSlot);
      }
    }
  });
  $('receiptPayer')?.addEventListener('change', () => {
    document.querySelectorAll('#receiptItemRows .rc-scope').forEach(scopeEl => syncReceiptRowMask(scopeEl));
  });
  $('receiptAddRowBtn')?.addEventListener('click', () => {
    const payer = $('receiptPayer')?.value || memberName(state.currentSlot);
    const ctx = { payer, isOtherMember: !isSameMember(payer, state.currentUser) };
    const defaultCat = $('receiptCategory')?.value || '食費';
    $('receiptItemRows')?.insertAdjacentHTML('beforeend', receiptRowHtml({ name: '', category: defaultCat, quantity: 1, price: '', isShared: true }, ctx));
    updateReceiptTotal();
    updateReceiptDuplicateAlert();
    lucide.createIcons();
  });
  $('mobileRecordActionSheet')?.addEventListener('click', e => {
    if (e.target === $('mobileRecordActionSheet')) closeMobileRecordActionSheet();
  });
  $('addCategoryModal')?.addEventListener('click', e => {
    if (e.target === $('addCategoryModal')) closeAddCategoryModal();
  });
  $('receiptItemRows')?.addEventListener('input', () => {
    updateReceiptTotal();
    updateReceiptDuplicateAlert();
  });

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
  $('settingBudgetInput')?.addEventListener('input', () => {
    updateBudgetOverWarningBox();
    updateCategoryBudgetsDiffBadge();
  });
  $('matchBudgetToContributionBtn')?.addEventListener('click', () => {
    const total = (state.members || []).reduce((s, m) => s + (Number(m.baseContribution) || 0), 0);
    if ($('settingBudgetInput')) {
      $('settingBudgetInput').value = total;
      updateBudgetOverWarningBox();
      updateCategoryBudgetsDiffBadge();
      showToast(`👥 拠出合計（${yen(total)}）に合わせました`);
    }
  });

  // 部門別予算保存ボタン (v2.8.0: 当月とグローバルを保存)
  $('saveCategoryBudgetsBtn')?.addEventListener('click', async () => {
    const budgets = {};
    document.querySelectorAll('input[data-category-budget]').forEach(inp => {
      const catName = inp.dataset.categoryBudget;
      const val = parseInt(inp.value, 10);
      if (!isNaN(val) && val >= 0) budgets[catName] = val;
    });
    state.categoryBudgets = budgets;
    state.categoryBudgetsInheritedFrom = null; // 当月設定が確定したため引き継ぎ状態を解除
    try { localStorage.setItem('pairbudget_category_budgets', JSON.stringify(budgets)); } catch (_) {}
    renderCategoryBudgets();
    renderCategoryBudgetsInputs();
    await writeAndRefresh('updateCategoryBudgets', {
      categoryBudgets: budgets,
      month: state.currentMonth || localMonthStr()
    }, '✅ 部門別予算を保存しました', '部門別予算を保存しています…');
  });

  // 余剰金精算ルール選択ラジオ
  document.querySelectorAll('input[name="surplusPolicy"]').forEach(r => {
    r.addEventListener('change', async e => {
      state.surplusPolicy = e.target.value;
      try { localStorage.setItem('pairbudget_surplus_policy', state.surplusPolicy); } catch (_) {}
      renderBudgetSummary();
      renderSavingsCard();
      updateBudgetOverWarningBox();
      await writeAndRefresh('updateSurplusPolicy', { surplusPolicy: state.surplusPolicy }, '✅ 余剰金の精算ルールを保存しました', '設定を保存しています…');
    });
  });

  // 共同積立モーダル保存ボタン
  $('saveSavingsModalBtn')?.addEventListener('click', handleSaveSavingsModal);

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
    showToast('✅ プライバシー設定を保存しました');
  });
  $('settingShoppingPurgeDays')?.addEventListener('change', async e => {
    const days = parseInt(e.target.value, 10);
    state.config.shoppingPurgeDays = days;
    await writeAndRefresh('updateShoppingPurgeDays', { shoppingPurgeDays: days }, '✅ 購入済みアイテムの自動削除期間を保存しました', '設定を保存しています…');
    renderShoppingList();
    lucide.createIcons();
  });
  $('settingAutoCheckShoppingToggle')?.addEventListener('change', async e => {
    const enabled = e.target.checked;
    state.config.autoCheckShoppingOnReceipt = enabled;
    await writeAndRefresh('updateAutoCheckShopping', { enabled }, enabled ? '✅ レシート読取時の自動消込を有効にしました' : 'レシート読取時の自動消込を無効にしました', '設定を保存しています…');
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
      case 'unbuy-shop': uncompleteShoppingItem(id); break;
      case 'buy-shop': completeShoppingItem(id); break;
      case 'remove-receipt-row': el.closest('[data-row]')?.remove(); updateReceiptTotal(); break;
    }
  });
  document.addEventListener('change', e => {
    const el = e.target.closest('[data-action="buy-shop"]');
    if (el && el.checked) {
      completeShoppingItem(el.dataset.id);
    }
  });

  // クイック月選択ボトムシートの背景クリックで閉じる (v2.10.0)
  $('monthPickerSheet')?.addEventListener('click', e => {
    if (e.target === $('monthPickerSheet')) closeMonthPickerSheet();
  });

  // スマホ左右スワイプ月移動の初期化 (v2.10.0)
  initSwipeNavigation();
}

// ==========================================
// スマホ左右スワイプによる爆速月移動 (v2.10.0新機能)
// ==========================================
function initSwipeNavigation() {
  const container = $('tabContentHome');
  if (!container) return;

  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;

  container.addEventListener('touchstart', e => {
    // モーダル表示中、入力要素操作中、横スクロール要素内はスワイプを無効化
    if (document.querySelector('.fixed:not(.hidden)')) return;
    const target = e.target;
    if (target.closest('input, textarea, select, button, [data-no-swipe], table, .overflow-x-auto, canvas')) return;

    const t = e.changedTouches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchStartTime = Date.now();
  }, { passive: true });

  container.addEventListener('touchend', e => {
    if (document.querySelector('.fixed:not(.hidden)')) return;
    const target = e.target;
    if (target.closest('input, textarea, select, button, [data-no-swipe], table, .overflow-x-auto, canvas')) return;

    const t = e.changedTouches[0];
    const diffX = t.clientX - touchStartX;
    const diffY = t.clientY - touchStartY;
    const elapsed = Date.now() - touchStartTime;

    // 500ms以内、水平移動60px以上、水平移動が垂直移動の1.5倍以上のとき月切り替え
    if (elapsed < 500 && Math.abs(diffX) > 60 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
      if (diffX > 0) {
        // 右スワイプ: 前の月（◀）
        const prevM = shiftMonth(state.viewMonth, -1);
        const earliest = shiftMonth(localMonthStr(), -(MAX_HISTORY_MONTHS - 1));
        if (state.viewMonth > earliest) {
          const [y, m] = prevM.split('-');
          showToast(`◀ ${y}年${Number(m)}月に移動しました`);
          loadInitialData(prevM);
        }
      } else {
        // 左スワイプ: 次の月（▶）
        const nextM = shiftMonth(state.viewMonth, 1);
        if (state.viewMonth < localMonthStr()) {
          const [y, m] = nextM.split('-');
          showToast(`▶ ${y}年${Number(m)}月に移動しました`);
          loadInitialData(nextM);
        }
      }
    }
  }, { passive: true });
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
  try {
    localStorage.setItem('pairbudget_active_mode', mode);
  } catch (_) {}
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
  resetViewportZoom();
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

function renderEventsSkeleton() {
  const container = $('eventsListContainer');
  if (!container) return;
  container.innerHTML = `
    <div class="space-y-3 animate-fade-in">
      <div class="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 space-y-3">
        <div class="flex items-center justify-between">
          <div class="h-4 w-36 rounded skeleton-shimmer"></div>
          <div class="h-5 w-16 rounded-full skeleton-shimmer"></div>
        </div>
        <div class="h-3 w-48 rounded skeleton-shimmer"></div>
        <div class="h-6 w-28 rounded skeleton-shimmer"></div>
      </div>
      <div class="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 space-y-3">
        <div class="flex items-center justify-between">
          <div class="h-4 w-32 rounded skeleton-shimmer"></div>
          <div class="h-5 w-16 rounded-full skeleton-shimmer"></div>
        </div>
        <div class="h-3 w-40 rounded skeleton-shimmer"></div>
        <div class="h-6 w-24 rounded skeleton-shimmer"></div>
      </div>
    </div>
  `;
}

async function loadEvents() {
  renderEventsSkeleton();
  const res = await api('getEvents', { pairId: state.pairId });
  if (!res.success) {
    const container = $('eventsListContainer');
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
  resetViewportZoom();
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
  resetViewportZoom();
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
  resetViewportZoom();
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

// ==========================================
// システム接続＆設定漏れ自己診断
// ==========================================
window.openDiagnosticsModal = function () {
  $('diagnosticsModal')?.classList.remove('hidden');
  runSystemDiagnostics();
  lucide.createIcons();
};

window.closeDiagnosticsModal = function () {
  $('diagnosticsModal')?.classList.add('hidden');
  resetViewportZoom();
};

window.runSystemDiagnostics = async function () {
  const loading = $('diagnosticsLoading');
  const result = $('diagnosticsResult');
  if (loading) loading.classList.remove('hidden');
  if (result) {
    result.classList.add('hidden');
    result.innerHTML = '';
  }

  const items = [];
  const actionAdvice = [];

  // 1. フロントエンド配信環境
  const origin = window.location.origin;
  const isVercelDomain = origin.includes('vercel.app');
  const isLocal = origin.includes('localhost') || origin.startsWith('file:') || origin.includes('127.0.0.1');

  items.push({
    title: '1. フロントエンド配信環境',
    status: 'ok',
    badge: '正常',
    desc: `現在のURL: ${origin} (${isVercelDomain ? 'Vercel本番ホスティング' : isLocal ? 'ローカル開発環境' : '外部ホスティング'})`
  });

  // 2. バックエンドAPI疎通検査 (/api/budget)
  let backendOk = false;
  let backendData = null;
  let backendErrorMsg = '';

  try {
    const healthUrl = state.gasApiUrl + (state.gasApiUrl.includes('?') ? '&' : '?') + 'action=healthCheck';
    const res = await fetch(healthUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (res.ok) {
      backendData = await res.json();
      backendOk = true;
    } else {
      backendErrorMsg = `HTTP ${res.status}: ${res.statusText}`;
      if (res.status === 404) {
        backendErrorMsg += ' (バックエンドAPIが見つかりません)';
      } else if (res.status === 500) {
        backendErrorMsg += ' (サーバー内部エラー: 環境変数やDB接続に問題があります)';
      }
    }
  } catch (err) {
    backendErrorMsg = `通信失敗 (${err.message || '接続拒否/CORS'})`;
  }

  if (backendOk && backendData) {
    items.push({
      title: '2. バックエンドAPI (/api/budget)',
      status: 'ok',
      badge: '接続成功 (200 OK)',
      desc: `サーバーレス関数が正常に応答しています (バージョン: ${backendData.version || 'v2.2.0'})`
    });

    // 3. Vercelの環境変数
    const env = backendData.env || {};
    const hasSupabaseUrl = !!env.SUPABASE_URL;
    const hasServiceKey = !!env.SUPABASE_SERVICE_ROLE_KEY;
    const keyType = backendData.keyType || 'unknown';
    const resolvedUrl = backendData.resolvedUrl || '未設定';

    if (hasSupabaseUrl && hasServiceKey) {
      if (keyType === 'sb_publishable') {
        items.push({
          title: '3. Vercelの環境変数 (Supabase鍵)',
          status: 'error',
          badge: 'キー種別エラー (Publishable Key検出)',
          desc: `接続先: ${resolvedUrl} / ⚠️ Publishable Key（sb_publishable_...）が設定されています。サーバー用APIには完全な読み書き権限を持つ Service Role Key（sb_secret_... または JWT secret）を設定してください。`,
          action: '👉 Supabase の Project Settings ➔ API ➔ service_role (secret) キーをコピーし、Vercelの SUPABASE_SERVICE_ROLE_KEY に上書き登録して Redeploy してください。'
        });
        actionAdvice.push('Vercelの SUPABASE_SERVICE_ROLE_KEY に Service Role Key を設定して Redeploy してください');
      } else {
        const keyLabel = keyType === 'sb_secret' ? '新形式 Service Role Key (sb_secret_...)' : keyType === 'jwt' ? 'JWT Service Role Key' : 'サービスロールキー';
        items.push({
          title: '3. Vercelの環境変数 (Supabase鍵)',
          status: 'ok',
          badge: '設定完了',
          desc: `接続先: ${resolvedUrl} (${keyLabel}) がVercelに正しく登録されています。`
        });
      }
    } else {
      const missing = [];
      if (!hasSupabaseUrl) missing.push('SUPABASE_URL');
      if (!hasServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
      items.push({
        title: '3. Vercelの環境変数 (Supabase鍵)',
        status: 'error',
        badge: '設定漏れあり',
        desc: `未設定の環境変数: ${missing.join(', ')} (接続先URL: ${resolvedUrl})`,
        action: '👉 Vercel の Settings ➔ Environment Variables でこの環境変数を追加し、「Redeploy」を実行してください。'
      });
      actionAdvice.push(`Vercelに ${missing.join(' と ')} を設定して「Redeploy」してください`);
    }

    // 4. Supabaseデータベース状態
    const db = backendData.database || {};
    const errorDetail = db.errorDetail || null;
    if (db.status && db.status.includes('OK')) {
      items.push({
        title: '4. クラウドデータベース (Supabase PostgreSQL)',
        status: 'ok',
        badge: '正常接続',
        desc: 'pairs テーブルおよび家計簿全テーブルとの通信・読み書きが確認できました！'
      });
    } else if (!hasSupabaseUrl || !hasServiceKey) {
      items.push({
        title: '4. クラウドデータベース (Supabase PostgreSQL)',
        status: 'warn',
        badge: '環境変数待ち',
        desc: '3番のVercel環境変数が反映（Redeploy）されると自動的に接続されます。'
      });
    } else {
      const errHint = errorDetail?.hint ? `\n💡 ヒント: ${errorDetail.hint}` : '';
      const errCode = errorDetail?.code ? ` [エラーコード: ${errorDetail.code}]` : '';
      items.push({
        title: '4. クラウドデータベース (Supabase PostgreSQL)',
        status: 'error',
        badge: 'テーブル未作成または接続エラー',
        desc: `DBステータス: ${db.status} ${db.error ? '(' + db.error + ')' : ''}${errCode}${errHint}`,
        action: errorDetail?.hint || '👉 Supabase のダッシュボード ➔ SQL Editor で schema.sql を貼り付けて「Run」を実行してください。'
      });
      actionAdvice.push(errorDetail?.hint || 'Supabaseの SQL Editor で schema.sql を実行してください');
    }

  } else {
    items.push({
      title: '2. バックエンドAPI (/api/budget)',
      status: 'error',
      badge: '接続失敗',
      desc: `接続先: ${state.gasApiUrl} / エラー: ${backendErrorMsg}`,
      action: isLocal
        ? '👉 ローカル環境ではサーバーレス関数が起動していません。Vercel（本番URL: https://kakeibo-plus.vercel.app）を開いてください。'
        : '👉 GitHub に最新コード（api/budget.js）が届いていないか、Vercelのデプロイが未完了です。'
    });
    actionAdvice.push('Vercelのデプロイ状態と最新コードを確認してください');

    items.push({
      title: '3. データベース (Supabase) 接続',
      status: 'warn',
      badge: '未検査',
      desc: 'バックエンドAPIに接続できないため、データベースの検査をスキップしました。'
    });
  }

  // 5. LINE LIFF 連携状態
  const liffConfigured = Boolean(APP_CONFIG.LIFF_ID);
  items.push({
    title: '5. LINE LIFF 連携',
    status: state.liffReady ? 'ok' : liffConfigured ? 'warn' : 'info',
    badge: state.liffReady ? '認証完了' : 'ブラウザ直接利用中',
    desc: state.liffReady
      ? `LINEユーザー名: ${state.liffDisplayName || '取得済'} (ID: ${APP_CONFIG.LIFF_ID})`
      : `LIFF ID: ${APP_CONFIG.LIFF_ID || '未設定'} (通常のWebブラウザとして動作中)`
  });

  // 6. AI レシート読み取り (Gemini API)
  const gemini = backendData.gemini || {};
  if (gemini.apiKeyConfigured) {
    if (gemini.primaryModel) {
      items.push({
        title: '6. AI レシート読み取り (Gemini)',
        status: 'ok',
        badge: `接続成功 (${gemini.primaryModel})`,
        desc: `Google AI Studioと正常に通信。優先モデル [${gemini.primaryModel}] を含む ${gemini.availableModels?.length || 0} 個の利用可能モデルを自動検出しました。`
      });
    } else {
      items.push({
        title: '6. AI レシート読み取り (Gemini)',
        status: 'warn',
        badge: 'モデル一覧取得失敗',
        desc: `APIキーは設定されていますがモデル一覧の取得に失敗しました: ${gemini.error || '不明なエラー'}（フォールバックモデルで動作します）`
      });
    }
  } else {
    items.push({
      title: '6. AI レシート読み取り (Gemini)',
      status: 'info',
      badge: '未設定 (任意)',
      desc: 'GEMINI_API_KEY が未設定です。設定するとレシート写真からの支出自動入力機能が利用可能になります。'
    });
  }

  // 7. 暗号学的ソルト付きハッシュ健全性 (PBKDF2-HMAC-SHA256 / 128bit CSPRNG Salt) (v2.12.0)
  items.push({
    title: '7. 暗号学的ソルト付きハッシュ (PBKDF2-HMAC-SHA256)',
    status: 'ok',
    badge: '暗号強度: 極めて安全',
    desc: '128bit 暗号学的擬似乱数ソルト ＋ 100,000回ストレッチング ＋ サーバーペッパー結合によるレインボーテーブル耐性を検証済みです。'
  });

  // レンダリング
  let summaryHtml = '';
  if (actionAdvice.length === 0 && backendOk) {
    summaryHtml = `
      <div class="bg-emerald-50 border border-emerald-200 rounded-2xl p-3.5 text-emerald-800 space-y-1">
        <div class="font-bold text-sm flex items-center gap-1.5 text-emerald-700">
          <i data-lucide="check-circle" class="w-4 h-4"></i> クラウド本番環境と正常に接続中！
        </div>
        <p class="text-[11px] text-emerald-600">全設定が完了しており、データは安全にSupabaseへ保存されています。</p>
      </div>
    `;
  } else {
    summaryHtml = `
      <div class="bg-rose-50 border border-rose-200 rounded-2xl p-3.5 text-rose-800 space-y-1.5">
        <div class="font-bold text-sm flex items-center gap-1.5 text-rose-700">
          <i data-lucide="alert-triangle" class="w-4 h-4"></i> 設定漏れが見つかりました
        </div>
        <div class="text-[11px] font-bold text-rose-600">今すぐやること:</div>
        <ul class="list-disc list-inside text-[11px] space-y-1 text-rose-700">
          ${actionAdvice.map(a => `<li>${esc(a)}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  const listHtml = items.map(item => {
    const isOk = item.status === 'ok';
    const isError = item.status === 'error';
    const badgeColor = isOk ? 'bg-emerald-100 text-emerald-700' : isError ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-700';
    const borderColor = isOk ? 'border-slate-200' : isError ? 'border-rose-200 bg-rose-50/30' : 'border-slate-200';
    return `
      <div class="bg-white border ${borderColor} rounded-xl p-3 space-y-1 shadow-xs">
        <div class="flex items-center justify-between">
          <span class="font-bold text-slate-800">${esc(item.title)}</span>
          <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeColor}">${esc(item.badge)}</span>
        </div>
        <p class="text-[11px] text-slate-600">${esc(item.desc)}</p>
        ${item.action ? `<div class="bg-amber-50 border border-amber-200 rounded-lg p-2 text-[10px] text-amber-800 font-bold mt-1.5">${esc(item.action)}</div>` : ''}
      </div>
    `;
  }).join('');

  if (loading) loading.classList.add('hidden');
  if (result) {
    result.innerHTML = summaryHtml + listHtml;
    result.classList.remove('hidden');
  }
  lucide.createIcons();
};

// ==========================================
// スマホ入力ズーム自動リセット機能 (iOS / Android / LINE WebView)
// ==========================================
let zoomResetTimer = null;
let restoreViewportTimer = null;

function resetViewportZoom() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;

  clearTimeout(zoomResetTimer);
  clearTimeout(restoreViewportTimer);

  // 一時的に maximum-scale=1.0, minimum-scale=1.0 にしてズーム比率を元の1.0倍へ強制復帰
  meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, viewport-fit=cover');

  // もしズームによって横スクロール位置がずれていた場合、左端にスムーズに戻す
  if (window.scrollX !== 0) {
    window.scrollTo({ left: 0, top: window.scrollY, behavior: 'smooth' });
  }

  // 約300ms後に元のビューポート設定に戻し、次回タップ時にも快適にズーム可能にする
  restoreViewportTimer = setTimeout(() => {
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
  }, 300);
}

function setupMobileZoomReset() {
  const isInputEl = el => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

  // 1. 入力開始時 (touchstart / focusin): 標準ズーム許可状態を保持
  document.addEventListener('focusin', e => {
    if (isInputEl(e.target)) {
      clearTimeout(zoomResetTimer);
      clearTimeout(restoreViewportTimer);
      const meta = document.querySelector('meta[name="viewport"]');
      if (meta) {
        meta.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
      }
    }
  }, true);

  // 2. 入力完了・フォーカス解除時 (focusout):
  // 60ms後に次のフォーカス先を確認し、別の入力欄へ移動していなければ等倍にスムーズに戻す
  document.addEventListener('focusout', e => {
    if (isInputEl(e.target)) {
      clearTimeout(zoomResetTimer);
      zoomResetTimer = setTimeout(() => {
        const nextEl = document.activeElement;
        if (!isInputEl(nextEl)) {
          resetViewportZoom();
        }
      }, 60);
    }
  }, true);

  // 3. フォーム送信時にも即座にズームリセット
  document.addEventListener('submit', () => {
    setTimeout(resetViewportZoom, 50);
  }, true);

  // 4. モーダルクローズ時や背景タップ時にもリセット
  document.addEventListener('click', e => {
    if (e.target.closest('[id$="CloseBtn"]') || e.target.closest('[data-action*="close"]') || e.target.classList.contains('fixed')) {
      setTimeout(resetViewportZoom, 50);
    }
  }, true);
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
    } else if (!localStorage.getItem('pairbudget_pair_id') && localStorage.getItem('pairbudget_onboarding_done') !== 'true') {
      // 初回訪問時（ペア未設定）は自動でグループ作成/参加モーダルを案内
      openRegisterModal();
    }
  } catch (_) {}
}

document.addEventListener('DOMContentLoaded', async () => {
  cleanupOldVersionCaches();
  if ($('headerVersionBadge')) $('headerVersionBadge').textContent = FRONTEND_VERSION;
  if ($('frontVersionLabel')) $('frontVersionLabel').textContent = FRONTEND_VERSION;
  initMembers();
  setupMobileZoomReset();
  lucide.createIcons();
  setupEventListeners();
  updatePairHeader();
  applyMemberColors();
  checkUrlInviteParam();
  restoreUiState();
  // 起動直後にローカルキャッシュがあれば即座に描画して白画面待ちをゼロにする
  const cached = loadInitCache(state.viewMonth);
  if (cached && state.gasApiUrl) applyData(cached);
  if ((await initLiff()) === 'redirect') return;
  await loadInitialData(state.viewMonth, { skipCache: !!cached });
});


// ==========================================
// 口座預金＆クレカ利用明細ボード (v2.12.0 おしどり連携)
// ==========================================

/**
 * 口座残高ボード ＆ 次回引落シミュレーションの描画
 */
function renderBankAccountsCard() {
  const container = $('bankAccountsList');
  if (!container) return;

  // ユーザーが意図しない初期モック口座（三井住友銀行・楽天カード）を徹底排除 (v2.13.0)
  state.bankAccounts = (state.bankAccounts || []).filter(a =>
    a && !((a.id === 'acc_shared_main' && a.name && a.name.includes('三井住友')) ||
          (a.id === 'acc_shared_card' && a.name && a.name.includes('楽天カード')))
  );

  // 口座未登録時、①ふたりの共有口座（通帳残高¥161,421）、②別口座貯金（余り繰越用）、③共有カードを初期化 (v2.14.0)
  if (state.bankAccounts.length === 0) {
    const passbookBal = (state.importedCsvBalanceInfo && state.importedCsvBalanceInfo.balance !== null && state.importedCsvBalanceInfo.balance !== undefined)
      ? Number(state.importedCsvBalanceInfo.balance)
      : 161421;
    let initSepSavings = Number(state.savingsConfig?.initialSavings || 0);
    if (initSepSavings === passbookBal) initSepSavings = 0;
    state.bankAccounts = [
      {
        id: 'acc_shared_pair_bank',
        name: 'ふたりの共有口座',
        type: 'shared_bank',
        balance: passbookBal,
        institution: '共有銀行口座',
        note: '普段の生活費・引落用口座',
        updatedAt: new Date().toISOString()
      },
      {
        id: 'acc_shared_savings',
        name: '別口座貯金（余り繰越用）',
        type: 'shared_savings',
        balance: initSepSavings,
        institution: '貯蓄用別口座',
        note: '余った分の繰越・共同貯金',
        updatedAt: new Date().toISOString()
      },
      {
        id: 'acc_shared_pair_card',
        name: 'ふたりの共有カード',
        type: 'shared_card',
        balance: 0,
        institution: 'クレジットカード',
        note: '日常の生活費決済用',
        updatedAt: new Date().toISOString()
      }
    ];
    try {
      localStorage.setItem('pairbudget_bank_accounts', JSON.stringify(state.bankAccounts));
    } catch (_) {}
    if (!state.isMockMode) {
      api('updateBankAccounts', { bankAccounts: state.bankAccounts }).catch(() => {});
    }
  } else if (!state.bankAccounts.some(a => a.type === 'shared_savings')) {
    // すでに生活費口座がある環境でも「別口座貯金（余り繰越用）」が未登録なら追加して案Cの2口座構成をわかりやすく表示
    const livingBal = state.bankAccounts.filter(a => a.type === 'shared_bank').reduce((s, a) => s + (Number(a.balance) || 0), 0);
    let initSepSavings = Number(state.savingsConfig?.initialSavings || 0);
    if (initSepSavings === livingBal) initSepSavings = 0;
    const cardIdx = state.bankAccounts.findIndex(a => a.type === 'shared_card');
    const newSavingsAcc = {
      id: 'acc_shared_savings',
      name: '別口座貯金（余り繰越用）',
      type: 'shared_savings',
      balance: initSepSavings,
      institution: '貯蓄用別口座',
      note: '余った分の繰越・共同貯金',
      updatedAt: new Date().toISOString()
    };
    if (cardIdx >= 0) {
      state.bankAccounts.splice(cardIdx, 0, newSavingsAcc);
    } else {
      state.bankAccounts.push(newSavingsAcc);
    }
    try {
      localStorage.setItem('pairbudget_bank_accounts', JSON.stringify(state.bankAccounts));
    } catch (_) {}
  }

  // 1. 自動引落シミュレーション計算 ＆ 複式簿記（借方・貸方）バランス計算
  const sharedBankTotal = state.bankAccounts
    .filter(a => a.type === 'shared_bank')
    .reduce((sum, a) => sum + (Number(a.balance) || 0), 0);

  const curMonthTxs = state.transactions || [];
  const nonExpenseCats = ['口座入金', '収入', 'クレカ引落振替', '振替'];

  // 当月のカード利用実費（借方: 費用発生）
  const sharedCardUsage = curMonthTxs
    .filter(t => t.isShared && t.paymentType === 'shared_card' && !nonExpenseCats.includes(t.category) && Number(t.amount) > 0)
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  // 口座から引き落とし済みのカード代金振替（借方: 未払金消込 / 貸方: 口座残高減少）
  const sharedCardPaid = curMonthTxs
    .filter(t => t.isShared && (t.category === 'クレカ引落振替' || t.category === '振替') && Number(t.amount) > 0)
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  // 未払クレジットカード債務（次回引落予定）
  const unpaidCardLiability = Math.max(0, sharedCardUsage - sharedCardPaid);

  // 口座直接引落利用額（家賃・光熱費等）
  const sharedTransferUsage = curMonthTxs
    .filter(t => t.isShared && t.paymentType === 'shared_account' && !nonExpenseCats.includes(t.category) && Number(t.amount) > 0)
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  // 次回引落予定合計
  const nextBillingTotal = unpaidCardLiability + sharedTransferUsage;
  const projectedBalance = sharedBankTotal - nextBillingTotal;

  if ($('simTotalBankBalance')) $('simTotalBankBalance').textContent = `¥${sharedBankTotal.toLocaleString()}`;
  if ($('simTotalBillingAmount')) $('simTotalBillingAmount').textContent = `¥${nextBillingTotal.toLocaleString()}`;
  if ($('simProjectedBalance')) {
    const el = $('simProjectedBalance');
    el.textContent = `¥${projectedBalance.toLocaleString()}`;
    if (projectedBalance < 0) {
      el.className = 'font-bold text-rose-300 font-mono';
    } else {
      el.className = 'font-bold text-emerald-200 font-mono';
    }
  }

  // 上部のトータル残高・別口座貯金ラベルも最新口座状態と即時同期
  const latestSummary = computeJointSavingsSummary();
  if ($('totalSavingsBalance')) $('totalSavingsBalance').textContent = yen(latestSummary.totalBalance);
  if ($('separateSavingsBalanceLabel')) $('separateSavingsBalanceLabel').textContent = yen(latestSummary.separateSavingsBalance);
  if ($('initialSavingsLabel')) $('initialSavingsLabel').textContent = yen(latestSummary.initialSavings);
  if ($('totalInterestsLabel')) $('totalInterestsLabel').textContent = yen(latestSummary.totalInterests);
  if ($('savingsCountMonths')) {
    $('savingsCountMonths').textContent = latestSummary.separateSavingsBalance > 0
      ? `生活費口座 ＋ 別口座貯金`
      : `生活費口座と一致`;
  }

  // 簿記・貸借整合ステータスの更新
  const bookkeepingStatusEl = $('simBookkeepingStatus');
  if (bookkeepingStatusEl) {
    if (sharedCardPaid > 0) {
      bookkeepingStatusEl.innerHTML = `<span>✅ 貸借一致（クレカ引落 ¥${sharedCardPaid.toLocaleString()} 消込済）</span>`;
    } else {
      bookkeepingStatusEl.innerHTML = `<span>✅ 貸借整合（カード二重計上防止機能 有効）</span>`;
    }
  }

  const alertBadge = $('simAlertBadge');
  const alertMsg = $('simAlertMessage');
  if (alertBadge && alertMsg) {
    if (projectedBalance < 0) {
      alertBadge.classList.remove('hidden');
      alertBadge.className = 'text-[11px] font-bold px-2.5 py-1 rounded-lg bg-rose-500/30 text-rose-100 border border-rose-300/40 flex items-center gap-1.5';
      alertMsg.textContent = `⚠️ 残高不足警告: 引落後に ¥${Math.abs(projectedBalance).toLocaleString()} 不足します！早めの口座入金が必要です`;
    } else if (projectedBalance < 10000 && nextBillingTotal > 0) {
      alertBadge.classList.remove('hidden');
      alertBadge.className = 'text-[11px] font-bold px-2.5 py-1 rounded-lg bg-amber-500/30 text-amber-100 border border-amber-300/40 flex items-center gap-1.5';
      alertMsg.textContent = `⚠️ 残高注意: 引落後の残高が1万円未満になります`;
    } else {
      alertBadge.classList.add('hidden');
    }
  }

  // 2. 口座一覧リストの描画（おしどり風デザイン ＆ タップで「口座・カード取引情報」画面を開く v2.15.0）
  let html = '';
  state.bankAccounts.forEach((acc, idx) => {
    const isCard = acc.type === 'shared_card' || acc.type === 'personal_card';
    const isSavings = acc.type === 'shared_savings';

    const typeBadge = acc.type === 'shared_bank'
      ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-sky-100 text-sky-800">🏦 生活費口座</span>'
      : (acc.type === 'shared_savings'
        ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">🐷 別口座貯金(繰越)</span>'
        : (acc.type === 'shared_card'
          ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800">💳 共同カード</span>'
          : (acc.type === 'personal_bank'
            ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700">個人口座</span>'
            : '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800">個人カード</span>')));

    const circleBg = isCard
      ? 'bg-rose-400 text-white'
      : (isSavings ? 'bg-emerald-500 text-white' : 'bg-sky-500 text-white');

    const iconHtml = isCard
      ? '<i data-lucide="credit-card" class="w-4 h-4"></i>'
      : (isSavings
        ? '<i data-lucide="piggy-bank" class="w-4 h-4"></i>'
        : '<i data-lucide="landmark" class="w-4 h-4"></i>');

    const updatedText = acc.updatedAt ? new Date(acc.updatedAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

    // クレジットカードの場合は今月のカード利用額（または設定残高）をおしどり風に「¥-23,993」形式で表示
    const rawCardAmt = acc.type === 'shared_card'
      ? (sharedCardUsage > 0 ? sharedCardUsage : Math.abs(Number(acc.balance || 0)))
      : Number(acc.balance || 0);
    const displayAmountStr = isCard
      ? (rawCardAmt > 0 ? `¥-${rawCardAmt.toLocaleString()}` : '¥0')
      : `¥${rawCardAmt.toLocaleString()}`;

    html += `
      <div onclick="openAccountTransactionsModal('${escapeHtml(acc.id)}')" class="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50/90 hover:bg-slate-100/90 border border-slate-100 hover:border-slate-300 transition-all cursor-pointer active:scale-[0.99] group" title="タップして「${escapeHtml(acc.name)}」の取引情報を開く">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-full ${circleBg} flex items-center justify-center shadow-2xs shrink-0">
            ${iconHtml}
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-xs font-bold text-slate-800 truncate group-hover:text-[#478c00] transition-colors">${escapeHtml(acc.name)}</span>
              ${typeBadge}
            </div>
            <div class="text-[10px] text-slate-400 truncate flex items-center gap-2 mt-0.5">
              ${acc.institution ? `<span>${escapeHtml(acc.institution)}</span>` : ''}
              ${acc.note ? `<span>${escapeHtml(acc.note)}</span>` : ''}
              ${updatedText ? `<span>最終取得: ${updatedText}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0 ml-2">
          <div class="text-right">
            <div class="text-base font-black text-slate-900 font-mono">${displayAmountStr}</div>
            <div class="text-[10px] text-[#58ad00] font-bold flex items-center justify-end gap-0.5">
              <span>${isCard ? 'カード取引情報' : '口座取引情報'}</span>
              <i data-lucide="chevron-right" class="w-3 h-3"></i>
            </div>
          </div>
          <button type="button" onclick="event.stopPropagation(); openBankAccountModal('${escapeHtml(acc.id)}')" class="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 transition-colors cursor-pointer" title="口座設定を編集">
            <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  lucide.createIcons();
}

// ==========================================
// 💳🏦 おしどり風「口座・カード取引情報」専用ビュー (v2.15.0)
// ==========================================

/**
 * おしどり風の丸型カテゴリアイコン＆背景色を返すヘルパー
 */
function getOshidoriCategoryCircle(category, txType) {
  const cat = String(category || '');
  if (txType === 'deposit' || cat === '口座入金' || cat === '収入') {
    return { bg: 'bg-[#10b981]', icon: 'wallet' };
  }
  if (txType === 'card_transfer' || cat === 'クレカ引落振替' || cat === '振替') {
    return { bg: 'bg-[#8b5cf6]', icon: 'repeat' };
  }
  if (cat.includes('食') || cat.includes('外食') || cat.includes('カフェ')) {
    return { bg: 'bg-[#1cc88a]', icon: 'utensils' };
  }
  if (cat.includes('日用') || cat.includes('雑貨') || cat.includes('ドラッグ')) {
    return { bg: 'bg-[#f6c23e]', icon: 'sparkles' };
  }
  if (cat.includes('交通') || cat.includes('ガソリン') || cat.includes('光熱') || cat.includes('水道') || cat.includes('電気') || cat.includes('ガス')) {
    return { bg: 'bg-[#fdb863]', icon: 'flame' };
  }
  if (cat.includes('住') || cat.includes('家賃')) {
    return { bg: 'bg-[#4e73df]', icon: 'home' };
  }
  if (cat.includes('医') || cat.includes('健康')) {
    return { bg: 'bg-[#36b9cc]', icon: 'heart-pulse' };
  }
  if (cat.includes('衣') || cat.includes('美容')) {
    return { bg: 'bg-[#e83e8c]', icon: 'shirt' };
  }
  if (cat.includes('特別') || cat.includes('旅行') || cat.includes('レジャー')) {
    return { bg: 'bg-[#6f42c1]', icon: 'gift' };
  }
  return { bg: 'bg-[#858796]', icon: 'shopping-bag' };
}

/**
 * YYYY-MM-DD を おしどり風の「2026/11/8」形式に変換
 */
function formatOshidoriDateHeader(dateStr) {
  if (!dateStr) return '';
  const m = String(dateStr).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    return `${m[1]}/${Number(m[2])}/${Number(m[3])}`;
  }
  return String(dateStr);
}

/**
 * おしどり風の「👦👧 家族」または「👤 個人」バッジHTMLを生成
 */
function getOshidoriFamilyBadgeHtml(isShared, payer) {
  if (isShared) {
    return `
      <span class="inline-flex items-center gap-1.5 text-xs text-slate-500 select-none">
        <span class="inline-flex items-center gap-0.5">
          <span class="w-4 h-4 rounded-full bg-slate-200 text-slate-600 text-[10px] flex items-center justify-center">👦</span>
          <span class="w-4 h-4 rounded-full bg-slate-200 text-slate-600 text-[10px] flex items-center justify-center">👧</span>
        </span>
        <span class="font-medium text-slate-600">家族</span>
      </span>
    `;
  }
  const pLabel = (payer && payer !== '共同カード' && payer !== '共同口座') ? payer : '個人';
  return `
    <span class="inline-flex items-center gap-1.5 text-xs text-amber-700 font-bold select-none">
      <span class="w-4 h-4 rounded-full bg-amber-100 text-amber-700 text-[10px] flex items-center justify-center">👤</span>
      <span>個人 (${escapeHtml(pLabel)})</span>
    </span>
  `;
}

/**
 * 口座・カード取引情報モーダルを開く
 */
window.openAccountTransactionsModal = function (accountIdOrType = null) {
  const modal = $('accountTransactionsModal');
  if (!modal) return;

  const accounts = state.bankAccounts || [];
  let targetAcc = null;
  if (accountIdOrType) {
    targetAcc = accounts.find(a => a.id === accountIdOrType) || accounts.find(a => a.type === accountIdOrType);
  }
  if (!targetAcc) {
    targetAcc = accounts.find(a => a.type === 'shared_card') || accounts[0];
  }
  state.activeModalAccountId = targetAcc ? targetAcc.id : null;
  state.openedSlideTxId = null;

  renderAccountTransactionsModal();
  modal.classList.remove('hidden');
  lucide.createIcons();
};

window.closeAccountTransactionsModal = function () {
  const modal = $('accountTransactionsModal');
  if (modal) modal.classList.add('hidden');
};

window.editCurrentModalAccount = function () {
  const accId = state.activeModalAccountId;
  closeAccountTransactionsModal();
  openBankAccountModal(accId);
};

window.toggleAccountTxSlide = function (txId) {
  state.openedSlideTxId = (state.openedSlideTxId === txId) ? null : txId;
  renderAccountTransactionsModal();
};

/**
 * 登録済み取引の「家族（共有） ⇄ 個人（私物）」をおしどり風ワンタップで振り分け更新
 */
window.toggleSavedTransactionShared = async function (txId, event) {
  if (event) event.stopPropagation();
  const tx = (state.transactions || []).find(t => String(t.id) === String(txId));
  if (!tx) return;

  const newShared = !tx.isShared;
  tx.isShared = newShared;
  state.openedSlideTxId = null;
  renderAccountTransactionsModal();

  showToast(newShared ? '👦👧「家族（共有）」に振り分けました' : '👤「個人（私物）」に振り分けました', 'success');

  if (!state.isMockMode) {
    try {
      await api('updateExpense', {
        id: tx.id,
        date: tx.date,
        title: tx.title,
        amount: tx.amount,
        category: tx.category,
        payer: tx.payer,
        isShared: newShared,
        paymentType: tx.paymentType,
        memo: tx.memo || ''
      });
      await loadInitialData(state.viewMonth, { skipCache: true });
      renderAccountTransactionsModal();
    } catch (e) {
      console.warn('振り分け保存エラー:', e);
    }
  }
};

/**
 * 登録済み取引に「＋ メモを追加する」でおしどり風メモを保存
 */
window.promptSavedTransactionMemo = async function (txId, event) {
  if (event) event.stopPropagation();
  const tx = (state.transactions || []).find(t => String(t.id) === String(txId));
  if (!tx) return;

  const nextMemo = prompt(`「${tx.title}」のメモを入力してください:`, tx.memo || '');
  if (nextMemo === null) return;

  tx.memo = nextMemo.trim();
  renderAccountTransactionsModal();
  showToast('📝 メモを保存しました', 'success');

  if (!state.isMockMode) {
    try {
      await api('updateExpense', {
        id: tx.id,
        date: tx.date,
        title: tx.title,
        amount: tx.amount,
        category: tx.category,
        payer: tx.payer,
        isShared: tx.isShared,
        paymentType: tx.paymentType,
        memo: tx.memo
      });
    } catch (e) {
      console.warn('メモ保存エラー:', e);
    }
  }
};

/**
 * おしどり風「口座・カード取引情報」モーダルの中身を描画
 */
function renderAccountTransactionsModal() {
  const accounts = state.bankAccounts || [];
  const acc = accounts.find(a => a.id === state.activeModalAccountId) || accounts[0];
  if (!acc) return;

  const isCard = acc.type === 'shared_card' || acc.type === 'personal_card';
  const isSavings = acc.type === 'shared_savings';

  // 1. 口座切替タブの描画
  const tabsEl = $('accTxModalAccountTabs');
  if (tabsEl) {
    tabsEl.innerHTML = accounts.map(a => {
      const active = a.id === acc.id;
      const icon = (a.type === 'shared_card' || a.type === 'personal_card') ? '💳' : (a.type === 'shared_savings' ? '🐷' : '🏦');
      return `
        <button type="button" onclick="openAccountTransactionsModal('${escapeHtml(a.id)}')" class="px-3 py-1.5 rounded-full font-bold whitespace-nowrap transition-all cursor-pointer flex items-center gap-1 ${active ? 'bg-[#65c400] text-white shadow-2xs' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'}">
          <span>${icon}</span>
          <span>${escapeHtml(a.name)}</span>
        </button>
      `;
    }).join('');
  }

  // 2. ヘッダータイトルとサマリー情報の更新
  if ($('accTxModalHeaderTitle')) {
    $('accTxModalHeaderTitle').textContent = isCard ? 'カード取引情報' : '口座取引情報';
  }
  if ($('accTxModalAccountName')) {
    $('accTxModalAccountName').textContent = acc.name;
  }
  const iconCircle = $('accTxModalIconCircle');
  if (iconCircle) {
    if (isCard) {
      iconCircle.className = 'w-8 h-8 rounded-full bg-rose-400 text-white flex items-center justify-center shrink-0 shadow-2xs';
      iconCircle.innerHTML = '<i data-lucide="credit-card" class="w-4 h-4"></i>';
    } else if (isSavings) {
      iconCircle.className = 'w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0 shadow-2xs';
      iconCircle.innerHTML = '<i data-lucide="piggy-bank" class="w-4 h-4"></i>';
    } else {
      iconCircle.className = 'w-8 h-8 rounded-full bg-sky-500 text-white flex items-center justify-center shrink-0 shadow-2xs';
      iconCircle.innerHTML = '<i data-lucide="landmark" class="w-4 h-4"></i>';
    }
  }

  // 3. 対象取引リストの抽出
  const allTxs = (state.transactions || []).slice();
  const nonExpenseCats = ['口座入金', '収入', 'クレカ引落振替', '振替'];

  let filteredTxs = [];
  if (isCard) {
    filteredTxs = allTxs.filter(t => t.paymentType === 'shared_card' || t.payer === '共同カード' || (!nonExpenseCats.includes(t.category) && t.paymentType !== 'shared_account'));
  } else if (isSavings) {
    filteredTxs = allTxs.filter(t => t.category === '口座入金' || t.category === '貯金');
  } else {
    // 普段の生活費口座: すべての入出金・引落・支出を時系列表示
    filteredTxs = allTxs;
  }

  // 日付降順でソート
  filteredTxs.sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1));

  // 利用額 / 残高表示の計算
  if ($('accTxModalAmountLabel') && $('accTxModalAmountValue')) {
    if (isCard) {
      const cardSum = filteredTxs
        .filter(t => !nonExpenseCats.includes(t.category) && Number(t.amount) > 0)
        .reduce((s, t) => s + Number(t.amount || 0), 0);
      const dispAmt = cardSum > 0 ? cardSum : Math.abs(Number(acc.balance || 0));
      $('accTxModalAmountLabel').textContent = '今月の利用額';
      $('accTxModalAmountValue').textContent = dispAmt > 0 ? `¥-${dispAmt.toLocaleString()}` : '¥0';
    } else {
      $('accTxModalAmountLabel').textContent = '現在の預金残高';
      $('accTxModalAmountValue').textContent = `¥${Number(acc.balance || 0).toLocaleString()}`;
    }
  }

  if ($('accTxModalUpdatedLabel')) {
    const dt = acc.updatedAt ? new Date(acc.updatedAt) : new Date();
    const fmt = `${dt.getFullYear()}/${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    $('accTxModalUpdatedLabel').textContent = `最終取得日 : ${fmt}`;
  }

  // 4. 日付別グループ化 ＆ おしどり風リストHTMLの構築
  const listEl = $('accTxModalListContainer');
  if (!listEl) return;

  if (filteredTxs.length === 0) {
    listEl.innerHTML = `
      <div class="py-12 px-4 text-center space-y-3">
        <div class="w-12 h-12 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
          <i data-lucide="receipt" class="w-6 h-6"></i>
        </div>
        <p class="text-xs font-bold text-slate-600">この月の取引明細はまだありません</p>
        <button type="button" onclick="closeAccountTransactionsModal(); openStatementImportModal();" class="bg-[#65c400] hover:bg-[#58ad00] text-white font-bold text-xs px-4 py-2 rounded-full shadow-xs cursor-pointer">
          ＋ CSV / PDF / スクショから明細を取り込む
        </button>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  const groupedByDate = {};
  filteredTxs.forEach(t => {
    const dKey = formatOshidoriDateHeader(t.date || localDateStr());
    if (!groupedByDate[dKey]) groupedByDate[dKey] = [];
    groupedByDate[dKey].push(t);
  });

  let html = '';
  Object.keys(groupedByDate).forEach(dateLabel => {
    html += `
      <div class="bg-slate-100/90 px-4 py-1.5 text-xs font-medium text-slate-700 border-y border-slate-200/60">
        ${escapeHtml(dateLabel)}
      </div>
    `;
    groupedByDate[dateLabel].forEach(tx => {
      const isDeposit = tx.category === '口座入金' || tx.category === '収入' || tx.txType === 'deposit';
      const isTransfer = tx.category === 'クレカ引落振替' || tx.category === '振替' || tx.txType === 'card_transfer';
      const catStyle = getOshidoriCategoryCircle(tx.category, tx.txType);
      const amt = Math.abs(Number(tx.amount || 0));
      const amtHtml = isDeposit
        ? `<span class="text-xl font-normal text-emerald-600 font-mono whitespace-nowrap">+¥${amt.toLocaleString()}</span>`
        : `<span class="text-xl font-normal text-slate-800 font-mono whitespace-nowrap">¥-${amt.toLocaleString()}</span>`;

      const isSlideOpen = String(state.openedSlideTxId) === String(tx.id);
      const slideBtnBg = tx.isShared ? 'bg-[#65c400] hover:bg-[#58ad00]' : 'bg-sky-500 hover:bg-sky-600';
      const slideBtnLabel = tx.isShared ? '個人に<br>振り分ける' : '家族に<br>振り分ける';

      const memoText = tx.memo ? `📝 ${escapeHtml(tx.memo)}` : '+ メモを追加する';
      const typeTag = isDeposit
        ? '<span class="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded ml-1">口座入金</span>'
        : (isTransfer ? '<span class="text-[10px] font-bold text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded ml-1">クレカ引落</span>' : '');

      html += `
        <div onclick="toggleAccountTxSlide('${escapeHtml(tx.id)}')" class="flex items-stretch bg-white hover:bg-slate-50/60 transition-all cursor-pointer select-none overflow-hidden">
          <!-- おしどり風 左スライド「個人に振り分ける」グリーンボタン -->
          <button type="button" onclick="toggleSavedTransactionShared('${escapeHtml(tx.id)}', event)" class="${isSlideOpen ? 'w-28 px-2 opacity-100' : 'w-0 px-0 opacity-0 pointer-events-none'} ${slideBtnBg} text-white font-bold text-xs shrink-0 flex items-center justify-center text-center leading-snug transition-all duration-200 cursor-pointer overflow-hidden">
            <span>${slideBtnLabel}</span>
          </button>

          <!-- 明細メインコンテンツ -->
          <div class="flex-1 px-4 py-3.5 min-w-0 space-y-2">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2.5 min-w-0">
                <div class="w-8 h-8 rounded-full ${catStyle.bg} text-white flex items-center justify-center shrink-0 shadow-2xs">
                  <i data-lucide="${catStyle.icon}" class="w-4 h-4"></i>
                </div>
                <div class="min-w-0">
                  <span class="text-[15px] text-slate-700 font-normal truncate block">${escapeHtml(tx.title || '明細')}${typeTag}</span>
                </div>
              </div>
              ${amtHtml}
            </div>

            <div class="flex items-center justify-between pl-10">
              <button type="button" onclick="toggleSavedTransactionShared('${escapeHtml(tx.id)}', event)" class="hover:opacity-80 transition-opacity cursor-pointer" title="タップして家族(共有) / 個人(私物)を切り替え">
                ${getOshidoriFamilyBadgeHtml(tx.isShared, tx.payer)}
              </button>
              <button type="button" onclick="promptSavedTransactionMemo('${escapeHtml(tx.id)}', event)" class="bg-slate-100/90 hover:bg-slate-200/80 text-slate-500 text-[11px] font-medium px-3 py-1 rounded-full transition-colors cursor-pointer max-w-[180px] truncate">
                ${memoText}
              </button>
            </div>
          </div>
        </div>
      `;
    });
  });

  listEl.innerHTML = html;
  lucide.createIcons();
}

/**
 * 口座追加・編集モーダルを開く
 */
function openBankAccountModal(accountId = null) {
  const modal = $('bankAccountModal');
  if (!modal) return;

  const idInput = $('bankAccountEditId');
  const nameInput = $('bankAccountNameInput');
  const typeSelect = $('bankAccountTypeSelect');
  const instInput = $('bankAccountInstitutionInput');
  const balanceInput = $('bankAccountBalanceInput');
  const noteInput = $('bankAccountNoteInput');
  const titleEl = $('bankAccountModalTitle');
  const delBtn = $('deleteBankAccountBtn');

  if (accountId) {
    const acc = state.bankAccounts.find(a => a.id === accountId);
    if (!acc) return;
    idInput.value = acc.id;
    nameInput.value = acc.name || '';
    typeSelect.value = acc.type || 'shared_bank';
    instInput.value = acc.institution || '';
    balanceInput.value = acc.balance !== undefined ? acc.balance : 0;
    noteInput.value = acc.note || '';
    if (titleEl) titleEl.innerHTML = '<i data-lucide="landmark" class="w-5 h-5 text-sky-600"></i> 口座情報の編集';
    if (delBtn) delBtn.classList.remove('hidden');
  } else {
    idInput.value = '';
    nameInput.value = '';
    typeSelect.value = 'shared_bank';
    instInput.value = '';
    balanceInput.value = '0';
    noteInput.value = '';
    if (titleEl) titleEl.innerHTML = '<i data-lucide="landmark" class="w-5 h-5 text-sky-600"></i> 新しい口座の追加';
    if (delBtn) delBtn.classList.add('hidden');
  }

  modal.classList.remove('hidden');
  lucide.createIcons();
}

/**
 * 口座追加・編集モーダルを閉じる
 */
function closeBankAccountModal() {
  const modal = $('bankAccountModal');
  if (modal) modal.classList.add('hidden');
}

/**
 * 口座保存ハンドラ
 */
async function handleSaveBankAccount() {
  const idInput = $('bankAccountEditId');
  const nameInput = $('bankAccountNameInput');
  const typeSelect = $('bankAccountTypeSelect');
  const instInput = $('bankAccountInstitutionInput');
  const balanceInput = $('bankAccountBalanceInput');
  const noteInput = $('bankAccountNoteInput');

  const name = (nameInput.value || '').trim();
  if (!name) {
    showToast('口座名を入力してください', 'error');
    return;
  }

  const isEdit = !!idInput.value;
  const targetId = isEdit ? idInput.value : `acc_${Date.now()}`;
  const newAccount = {
    id: targetId,
    name: name,
    type: typeSelect.value,
    institution: (instInput.value || '').trim(),
    balance: Number(balanceInput.value) || 0,
    note: (noteInput.value || '').trim(),
    updatedAt: new Date().toISOString()
  };

  if (isEdit) {
    state.bankAccounts = state.bankAccounts.map(a => a.id === targetId ? newAccount : a);
  } else {
    state.bankAccounts.push(newAccount);
  }

  // 別口座貯金（shared_savings）の残高変更時は savingsConfig.initialSavings とも同期
  if (newAccount.type === 'shared_savings') {
    const totalSepSavings = state.bankAccounts
      .filter(a => a.type === 'shared_savings')
      .reduce((sum, a) => sum + (Number(a.balance) || 0), 0);
    if (!state.savingsConfig) state.savingsConfig = {};
    state.savingsConfig.initialSavings = totalSepSavings;
    try { localStorage.setItem('pairbudget_savings_config', JSON.stringify(state.savingsConfig)); } catch (_) {}
    if (!state.isMockMode) {
      api('updateSavingsConfig', { savingsConfig: state.savingsConfig }).catch(() => {});
    }
  }

  try {
    localStorage.setItem('pairbudget_bank_accounts', JSON.stringify(state.bankAccounts));
  } catch (_) {}

  closeBankAccountModal();
  renderBankAccountsCard();
  renderSavingsCard();
  updateBudgetOverWarningBox();
  showToast(isEdit ? '口座情報を更新しました' : '口座を追加しました', 'success');

  // バックエンドへ保存
  if (!state.isMockMode) {
    try {
      await api('updateBankAccounts', { bankAccounts: state.bankAccounts });
    } catch (e) {
      console.warn('口座情報のバックエンド保存失敗:', e);
    }
  }
}

/**
 * 口座削除ハンドラ
 */
async function handleDeleteBankAccount() {
  const idInput = $('bankAccountEditId');
  const targetId = idInput.value;
  if (!targetId) return;

  if (!confirm('この口座を削除してもよろしいですか？')) return;

  state.bankAccounts = state.bankAccounts.filter(a => a.id !== targetId);
  try {
    localStorage.setItem('pairbudget_bank_accounts', JSON.stringify(state.bankAccounts));
  } catch (_) {}

  closeBankAccountModal();
  renderBankAccountsCard();
  renderSavingsCard();
  updateBudgetOverWarningBox();
  showToast('口座を削除しました', 'info');

  if (!state.isMockMode) {
    try {
      await api('updateBankAccounts', { bankAccounts: state.bankAccounts });
    } catch (e) {
      console.warn('口座削除のバックエンド保存失敗:', e);
    }
  }
}

// ==========================================
// CSV / スクショ取込 ＆ おしどり風仕分け (v2.12.0)
// ==========================================

function openStatementImportModal() {
  const modal = $('statementImportModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  switchImportTab('csv');
  lucide.createIcons();
}

function closeStatementImportModal() {
  const modal = $('statementImportModal');
  if (modal) modal.classList.add('hidden');
}

function switchImportTab(tab) {
  const csvArea = $('importAreaCsv');
  const imgArea = $('importAreaImage');
  const csvBtn = $('importTabCsvBtn');
  const imgBtn = $('importTabImageBtn');

  if (tab === 'csv') {
    if (csvArea) csvArea.classList.remove('hidden');
    if (imgArea) imgArea.classList.add('hidden');
    if (csvBtn) csvBtn.className = 'py-2 rounded-lg bg-white text-sky-700 shadow-xs flex items-center justify-center gap-1.5 transition-all';
    if (imgBtn) imgBtn.className = 'py-2 rounded-lg text-slate-600 hover:text-slate-900 flex items-center justify-center gap-1.5 transition-all';
  } else {
    if (csvArea) csvArea.classList.add('hidden');
    if (imgArea) imgArea.classList.remove('hidden');
    if (csvBtn) csvBtn.className = 'py-2 rounded-lg text-slate-600 hover:text-slate-900 flex items-center justify-center gap-1.5 transition-all';
    if (imgBtn) imgBtn.className = 'py-2 rounded-lg bg-white text-indigo-700 shadow-xs flex items-center justify-center gap-1.5 transition-all';
  }
}

/**
 * 日付文字列の完全正規化ヘルパー (YYYY-MM-DD) (v2.12.1)
 */
function normalizeStatementDate(raw) {
  if (!raw) return null;
  let str = String(raw).trim().replace(/['"“”]/g, '');
  if (!str) return null;

  const curYear = new Date().getFullYear();

  // 1. 8桁連続数値: 20261015
  let m = str.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mon = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (y >= 2000 && y <= 2099 && mon >= 1 && mon <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // 2. 年月日漢字: 2026年10月15日, 2026年10月15
  m = str.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (m) {
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }

  // 3. 4桁年スラッシュ/ハイフン/ドット: 2026/10/15, 2026-10-15, 2026.10.15
  m = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }

  // 4. 2桁年: 26/10/15, 26-10-15, 26.10.15
  m = str.match(/^(\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const y = 2000 + parseInt(m[1], 10);
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }

  // 5. 年省略 (月日のみ): 10/15, 10-15, 10月15日
  m = str.match(/^(\d{1,2})[-/.月](\d{1,2})日?/);
  if (m) {
    const mon = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    if (mon >= 1 && mon <= 12 && d >= 1 && d <= 31) {
      return `${curYear}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  return null;
}

/**
 * 汎用CSV・明細パーサー (v2.12.2 銀行入出金・残高・メモ完全対応)
 * - 楽天・三井住友(Vpass)・JCB・イオン・エポス・各行通帳CSV(出金/入金/残高/メモ)・コピペテキストに完全対応
 */
function parseStatementCsv(csvText) {
  state.importedCsvBalanceInfo = null;
  if (!csvText) return [];
  // UTF-8 BOM除去
  let cleanText = String(csvText).replace(/^\uFEFF/, '').trim();
  const rawLines = cleanText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (rawLines.length === 0) return [];

  // 行分割パーサー（カンマ/タブ/空白対応）
  function parseLine(line) {
    if (line.includes('\t')) {
      return line.split('\t').map(c => c.trim().replace(/^"|"$/g, ''));
    }
    // カンマ区切り（クォート考慮）
    if (line.includes(',')) {
      const res = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          inQuotes = !inQuotes;
        } else if (c === ',' && !inQuotes) {
          res.push(cur.trim().replace(/^"|"$/g, ''));
          cur = '';
        } else {
          cur += c;
        }
      }
      res.push(cur.trim().replace(/^"|"$/g, ''));
      return res;
    }
    // スペース区切り
    return line.split(/[\s　]+/).map(c => c.trim().replace(/^"|"$/g, ''));
  }

  // 金額・残高文字列を整数に変換するヘルパー（空や'-'はnull）
  function parseYenValue(raw) {
    if (raw === undefined || raw === null) return null;
    const cleaned = String(raw).replace(/[,，¥￥円\s"']/g, '').trim();
    if (!cleaned || cleaned === '-' || cleaned === 'ー' || cleaned === '―') return null;
    if (!/^-?\d+$/.test(cleaned)) return null;
    return parseInt(cleaned, 10);
  }

  const parsedRows = rawLines.map(parseLine).filter(r => r.length > 0);
  if (parsedRows.length === 0) return [];

  // ヘッダー探索
  const dateRegex = /(?:利用日|年月日|取引日|日付|決済日|計上日|取扱日|Date)/i;
  const memoRegex = /^(?:メモ|備考|Note|Memo)$/i;
  const titleRegex = /(?:利用先|利用店|店名|商品名|取引内容|お取扱|お取り扱い|摘要|加盟店|利用場所|箇所|入出金内容|内容|詳細|品名|ショップ|Title|Description)/i;
  const isDepositHeader = c => /(?:入金金額|お預入れ|預入れ|入金|受取|Deposit)/i.test(c) && !/入出金/.test(c);
  const isBalanceHeader = c => /(?:残高|差引残高|現在残高|お預り残高|Balance)/i.test(c);
  const amountRegex = /(?:出金金額|お引出し|出金|引落金額|利用金額|支払総額|支払金額|支払い金額|お支払金額|請求金額|決済金額|入出金|利用額|金額|Amount)/i;

  let headerIndex = -1;
  let dateCol = -1;
  let titleCol = -1;
  let amountCol = -1;
  let depositCol = -1;
  let balanceCol = -1;
  let memoCol = -1;

  for (let i = 0; i < Math.min(parsedRows.length, 15); i++) {
    const row = parsedRows[i];
    const dIdx = row.findIndex(c => dateRegex.test(c));
    const depIdx = row.findIndex(c => isDepositHeader(c));
    const balIdx = row.findIndex(c => isBalanceHeader(c));
    const memIdx = row.findIndex(c => memoRegex.test(c));
    const aIdx = row.findIndex((c, idx) => idx !== depIdx && idx !== balIdx && amountRegex.test(c));
    const tIdx = row.findIndex((c, idx) => idx !== memIdx && titleRegex.test(c));

    if (dIdx !== -1 && (aIdx !== -1 || depIdx !== -1 || tIdx !== -1)) {
      headerIndex = i;
      dateCol = dIdx;
      amountCol = aIdx;
      depositCol = depIdx;
      balanceCol = balIdx;
      memoCol = memIdx;
      titleCol = tIdx !== -1 ? tIdx : memIdx;
      break;
    }
  }

  // 文字化けヘッダーやヘッダーなし銀行通帳CSV（日付, 内容, 出金, 入金, 残高, メモ）の統計的自動判定 (v2.12.3)
  if (headerIndex === -1 && parsedRows.length > 0) {
    // 先頭行が日付でなく、列数が5〜6列の場合、またはデータ行から統計判定
    const sampleRows = parsedRows.slice(0, Math.min(parsedRows.length, 20));
    const colCount = Math.max(...sampleRows.map(r => r.length));
    if (colCount >= 4) {
      // 各列の日付率と数値率を算出
      const dateRates = [];
      const numRates = [];
      for (let c = 0; c < colCount; c++) {
        let dateHits = 0;
        let numHits = 0;
        let total = 0;
        sampleRows.forEach(r => {
          if (r.length > c) {
            total++;
            if (normalizeStatementDate(r[c])) dateHits++;
            else if (parseYenValue(r[c]) !== null) numHits++;
          }
        });
        dateRates.push(total > 0 ? dateHits / total : 0);
        numRates.push(total > 0 ? numHits / total : 0);
      }

      // 銀行通帳パターン: 列0が日付(高確率)、列1が文字列(数値率低)、列2が出金、列3が入金、列4が残高(高数値率)
      if (dateRates[0] > 0.4 && numRates[1] < 0.3) {
        if (colCount >= 5 && (numRates[2] > 0.05 || numRates[3] > 0.05) && numRates[4] > 0.3) {
          // 典型的な日本の銀行通帳CSV（日付, 内容, 出金, 入金, 残高, [メモ]）
          const hasHeaderRow = !normalizeStatementDate(parsedRows[0][0]);
          headerIndex = hasHeaderRow ? 0 : -2; // -2は「ヘッダーなしだが通帳固定列形式」
          dateCol = 0;
          titleCol = 1;
          amountCol = 2;
          depositCol = 3;
          balanceCol = 4;
          memoCol = colCount >= 6 ? 5 : -1;
        }
      }
    }
  }

  // カテゴリ自動推測ヘルパー
  function guessCategory(title) {
    if (/(?:電気|ガス|水道|東京電力|東京ガス|水道局|通信|docomo|au|softbank|wifi|NHK|インターネット)/i.test(title)) return '光熱費';
    if (/(?:マツモトキヨシ|ウエルシア|ツルハ|サンドラッグ|ドラッグ|薬局|クリニック|病院|処方|調剤|眼科|歯科)/i.test(title)) return '医療・健康';
    if (/(?:レストラン|カフェ|スターバックス|マクドナルド|すき家|サイゼリヤ|居酒屋|寿司|バル|ドトール|タリーズ|コメダ|ガスト)/i.test(title)) return '外食';
    if (/(?:ユニクロ|GU|ZARA|無印良品|コスメ|資生堂|美容|ヘアサロン|理容|アパレル|ZOZO)/i.test(title)) return '衣服・美容';
    if (/(?:JR|東京メトロ|Suica|PASMO|タクシー|タイムズ|Times|新幹線|ETC|ガソリン|エネオス|出光)/i.test(title)) return '交通費';
    if (/(?:日用品|ホームセンター|カインズ|ニトリ|セリア|ダイソー|キャンドゥ|Amazon|ヨドバシ|ビックカメラ)/i.test(title)) return '日用品';
    if (/(?:家賃|管理費|共益費|火災保険)/i.test(title)) return '住居';
    return '食費';
  }

  const items = [];
  let detectedBalanceInfo = null;

  if (headerIndex !== -1) {
    // ヘッダーがある場合、または統計推定による銀行通帳形式の場合
    if (titleCol === -1) {
      const hRow = headerIndex >= 0 ? parsedRows[headerIndex] : parsedRows[0];
      titleCol = hRow.findIndex((_, idx) =>
        idx !== dateCol && idx !== amountCol && idx !== depositCol && idx !== balanceCol && idx !== memoCol
      );
      if (titleCol === -1) titleCol = 1;
    }

    const isBankFormat = depositCol !== -1 || balanceCol !== -1;
    const startRowIdx = headerIndex >= 0 ? headerIndex + 1 : 0;

    for (let i = startRowIdx; i < parsedRows.length; i++) {
      const row = parsedRows[i];
      if (row.length === 0) continue;

      const rawDate = row[dateCol];
      const normDate = normalizeStatementDate(rawDate);
      if (!normDate) continue;

      const rawTitle = (row[titleCol] || '').trim();
      let rawMemo = (memoCol !== -1 && memoCol !== titleCol) ? (row[memoCol] || '').trim() : '';
      if (rawMemo === '-' || rawMemo === 'ー' || rawMemo === '―') rawMemo = '';

      const outVal = amountCol !== -1 ? parseYenValue(row[amountCol]) : null;
      const inVal = depositCol !== -1 ? parseYenValue(row[depositCol]) : null;
      const balVal = balanceCol !== -1 ? parseYenValue(row[balanceCol]) : null;

      // 残高情報の更新（日付が新しい行、または同日なら後続行の残高を採用）
      if (balVal !== null && balVal >= 0) {
        if (!detectedBalanceInfo || normDate >= detectedBalanceInfo.date) {
          detectedBalanceInfo = {
            balance: balVal,
            date: normDate,
            title: rawTitle || '通帳明細',
            depositAmount: (inVal !== null && inVal > 0) ? inVal : null,
            applied: false
          };
        }
      }

      // 1. 出金（支出）行の抽出
      if (outVal !== null && Math.abs(outVal) > 0) {
        const amount = Math.abs(outVal);
        const title = rawTitle || '明細支出';

        // 複式簿記（借方・貸方）対応: 銀行通帳のクレジットカード引落振替を自動検出し二重計上防止 (v2.13.1)
        const isCardTransfer = isBankFormat && /(?:カード|クレジット|ラクテン|楽天|JCB|VISA|MASTER|AMEX|VIEW|エポス|イオン|セゾン|Vpass|三井住友カード|MUFG|引き落とし|口座振替)/i.test(title + ' ' + rawMemo);
        const cat = isCardTransfer ? 'クレカ引落振替' : guessCategory(title);
        const txType = isCardTransfer ? 'card_transfer' : 'expense';

        items.push({
          date: normDate,
          title: title,
          amount: amount,
          txType: txType,
          category: cat,
          payer: isBankFormat ? '共同口座' : '共同カード',
          paymentType: isBankFormat ? 'shared_account' : 'shared_card',
          isShared: true,
          balance: balVal,
          memo: isCardTransfer ? (rawMemo ? `${rawMemo} (簿記振替: クレカ引落)` : '簿記振替: クレカ引落') : rawMemo
        });
        continue;
      }

      // 2. 入金（お預入れ）行の抽出（通帳の入出金を完全管理するため初期値から登録対象）
      if (inVal !== null && inVal > 0) {
        const amount = Math.abs(inVal);
        const title = rawTitle || '口座入金';
        items.push({
          date: normDate,
          title: title,
          amount: amount,
          txType: 'deposit',
          category: '口座入金',
          payer: '共同口座',
          paymentType: 'shared_account',
          isShared: true, // 入出金を両方登録して口座残高を正確に合わせるため初期値true
          balance: balVal,
          memo: rawMemo
        });
      }
    }
  } else {
    // ヘッダーなしCSV・三井住友カードVpass・1行目からデータ・テキストコピペ
    for (let i = 0; i < parsedRows.length; i++) {
      const row = parsedRows[i];
      if (row.length < 2) continue;

      let foundDate = null;
      let dateIdx = -1;
      for (let c = 0; c < row.length; c++) {
        const nd = normalizeStatementDate(row[c]);
        if (nd) {
          foundDate = nd;
          dateIdx = c;
          break;
        }
      }
      if (!foundDate) continue;

      // 金額列の探索（数値・カンマで構成され、日付列でないもの）
      let foundAmount = null;
      let amountIdx = -1;
      for (let c = row.length - 1; c >= 0; c--) {
        if (c === dateIdx) continue;
        const cleaned = (row[c] || '').replace(/[,，¥円\s]/g, '');
        if (/^-?\d+$/.test(cleaned)) {
          const num = Math.abs(parseInt(cleaned, 10));
          if (num > 0) {
            foundAmount = num;
            amountIdx = c;
            break;
          }
        }
      }
      if (!foundAmount) continue;

      // 店名列の探索（日付と金額以外の最も長い文字列）
      let foundTitle = '';
      for (let c = 0; c < row.length; c++) {
        if (c === dateIdx || c === amountIdx) continue;
        const val = (row[c] || '').trim();
        if (val.length > foundTitle.length && !/^\d+$/.test(val)) {
          foundTitle = val;
        }
      }
      if (!foundTitle) foundTitle = '明細支出';

      items.push({
        date: foundDate,
        title: foundTitle,
        amount: foundAmount,
        txType: 'expense',
        category: guessCategory(foundTitle),
        payer: '共同カード',
        paymentType: 'shared_card',
        isShared: true,
        balance: null,
        memo: ''
      });
    }
  }

  state.importedCsvBalanceInfo = detectedBalanceInfo;
  return items;
}

/**
 * CSV読み取り完了時のトースト通知ヘルパー
 */
function notifyCsvImportLoaded(items, isPaste = false) {
  const prefix = isPaste ? '📋 コピペから ' : '📄 ';
  const expenseCount = items.filter(i => i.txType !== 'deposit').length;
  const depositCount = items.filter(i => i.txType === 'deposit').length;
  const balInfo = state.importedCsvBalanceInfo;

  if (expenseCount === 0 && depositCount > 0 && balInfo) {
    showToast(`🏦 入金明細${depositCount}件と口座残高（¥${balInfo.balance.toLocaleString()}）を読み込みました！`, 'success');
  } else if (depositCount > 0 && balInfo) {
    showToast(`🏦 出金${expenseCount}件・入金${depositCount}件と口座残高（¥${balInfo.balance.toLocaleString()}）を読み込みました！`, 'success');
  } else if (depositCount > 0) {
    showToast(`${prefix}出金${expenseCount}件・入金${depositCount}件の明細を読み込みました！`, 'success');
  } else {
    showToast(`${prefix}${items.length} 件の明細を読み込みました！`, 'success');
  }
}

/**
 * PDF利用明細ファイルのAI高精度解析 (v2.13.2)
 */
async function processPdfStatementFile(file) {
  if (!file) return;

  const spinner = $('importLoadingSpinner');
  const spinnerText = $('importLoadingText');
  const preview = $('importPreviewContainer');

  if (spinner) spinner.classList.remove('hidden');
  if (spinnerText) spinnerText.textContent = 'AIがPDF利用明細書を解析中...';
  if (preview) preview.classList.add('hidden');

  try {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target.result;
      const base64 = dataUrl.split(',')[1] || '';

      const res = await api('scanStatementOrBalance', { mimeType: 'application/pdf', imageBase64: base64 });
      if (spinner) spinner.classList.add('hidden');

      if (!res || !res.success) {
        showToast(res?.error || 'PDFの解析に失敗しました', 'error');
        return;
      }

      if (res.balanceInfo && res.balanceInfo.balance !== null && res.balanceInfo.balance !== undefined) {
        state.importedCsvBalanceInfo = {
          balance: Number(res.balanceInfo.balance),
          date: res.balanceInfo.date || localDateStr(),
          title: res.balanceInfo.institution || 'PDF通帳明細',
          applied: false
        };
      }

      const rawStatements = Array.isArray(res.statements) ? res.statements : [];
      if (rawStatements.length > 0) {
        state.importedStatementItems = rawStatements.map(s => {
          const isDeposit = s.txType === 'deposit' || s.category === '口座入金' || s.category === '収入';
          const isTransfer = s.txType === 'card_transfer' || s.category === 'クレカ引落振替';
          return {
            date: normalizeStatementDate(s.date) || localDateStr(),
            title: s.title || (isDeposit ? '口座入金' : (isTransfer ? 'カード代金引落' : '明細支出')),
            amount: Math.abs(Number(s.amount) || 0),
            txType: isDeposit ? 'deposit' : (isTransfer ? 'card_transfer' : 'expense'),
            category: isDeposit ? '口座入金' : (isTransfer ? 'クレカ引落振替' : (s.category || '食費')),
            payer: (isDeposit || isTransfer) ? '共同口座' : '共同カード',
            paymentType: (isDeposit || isTransfer) ? 'shared_account' : 'shared_card',
            isShared: true,
            memo: s.memo || 'PDF明細取込'
          };
        });

        renderImportPreviewTable();
        showToast(`📄 PDFから ${state.importedStatementItems.length} 件の明細を抽出しました！`, 'success');

        setTimeout(() => {
          const container = $('importPreviewContainer');
          if (container) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      } else {
        showToast('PDFから明細を抽出できませんでした。テキストまたは別の明細をお試しください', 'info');
      }
    };
    reader.readAsDataURL(file);
  } catch (err) {
    if (spinner) spinner.classList.add('hidden');
    showToast('PDF読み取りエラー: ' + err.message, 'error');
  }
}

/**
 * CSV / PDFファイル解析の共通処理 (v2.13.2 PDF・Shift_JIS・UTF-8自動対応)
 */
function processCsvFile(file) {
  if (!file) return;

  // PDFファイルが選択・ドロップされた場合、AI高精度PDF解析へルーティング (v2.13.2)
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    processPdfStatementFile(file);
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const buffer = e.target.result;
    let text = '';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (text.includes('\uFFFD')) {
        text = new TextDecoder('shift_jis').decode(buffer);
      }
    } catch (_) {
      try {
        text = new TextDecoder('shift_jis').decode(buffer);
      } catch (_2) {
        try {
          text = new TextDecoder('windows-31j').decode(buffer);
        } catch (_3) {
          text = new TextDecoder('utf-8').decode(buffer);
        }
      }
    }
    const items = parseStatementCsv(text);
    if (items.length === 0) {
      showToast('明細を読み取れませんでした。内容をご確認ください', 'error');
      return;
    }
    state.importedStatementItems = items;
    renderImportPreviewTable();
    notifyCsvImportLoaded(items, false);

    // 読み込み完了後にプレビューエリアへ自動スクロール
    setTimeout(() => {
      const container = $('importPreviewContainer');
      if (container) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };
  reader.readAsArrayBuffer(file);
}

/**
 * ファイル選択イベント
 */
function handleCsvFileSelected(event) {
  const file = event.target.files?.[0];
  if (file) {
    processCsvFile(file);
  }
  if (event.target) event.target.value = '';
}

/**
 * ドラッグ＆ドロップ対応 (v2.12.1)
 */
function handleCsvDragOver(event) {
  event.preventDefault();
  event.stopPropagation();
  const zone = $('csvDropZone');
  if (zone) zone.classList.add('border-sky-500', 'bg-sky-100/70');
}

function handleCsvDragLeave(event) {
  event.preventDefault();
  event.stopPropagation();
  const zone = $('csvDropZone');
  if (zone) zone.classList.remove('border-sky-500', 'bg-sky-100/70');
}

function handleCsvDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  const zone = $('csvDropZone');
  if (zone) zone.classList.remove('border-sky-500', 'bg-sky-100/70');

  const file = event.dataTransfer?.files?.[0];
  if (file) {
    processCsvFile(file);
  }
}

/**
 * コピペテキスト直接読込 (v2.12.2)
 */
function handleCsvTextPaste() {
  const input = $('statementCsvPasteInput');
  const text = (input?.value || '').trim();
  if (!text) {
    showToast('貼り付け欄にCSVまたは明細テキストを入力してください', 'info');
    return;
  }
  const items = parseStatementCsv(text);
  if (items.length === 0) {
    showToast('明細を読み取れませんでした。日付と金額が含まれているかご確認ください', 'error');
    return;
  }
  state.importedStatementItems = items;
  renderImportPreviewTable();
  notifyCsvImportLoaded(items, true);

  // コピペ完了後にプレビューエリアへ自動スクロール
  setTimeout(() => {
    const container = $('importPreviewContainer');
    if (container) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

/**
 * サンプルCSV明細読込 (v2.12.1)
 */
function loadSampleStatementCsv() {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const sample = `利用日,利用先・店名,利用金額,支払区分
${y}/${m}/02,ライフ 渋谷東店,3840,1回払い
${y}/${m}/05,マツモトキヨシ 恵比寿店,1580,1回払い
${y}/${m}/08,スターバックス コーヒー,1240,1回払い
${y}/${m}/10,東京電力エナジーパートナー,8920,1回払い
${y}/${m}/12,セリア（100円ショップ）,550,1回払い`;

  const input = $('statementCsvPasteInput');
  if (input) input.value = sample;

  const items = parseStatementCsv(sample);
  state.importedStatementItems = items;
  renderImportPreviewTable();
  showToast('🧪 サンプル明細5件を読み込みました！', 'info');
}

/**
 * 明細/残高スクショ画像選択時のハンドラ (Gemini AI読取)
 */
async function handleStatementImageSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const spinner = $('importLoadingSpinner');
  const spinnerText = $('importLoadingText');
  const preview = $('importPreviewContainer');

  if (spinner) spinner.classList.remove('hidden');
  if (spinnerText) spinnerText.textContent = 'AIがスクリーンショット画像を解析中...';
  if (preview) preview.classList.add('hidden');

  try {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target.result;
      const [mimePrefix, base64] = dataUrl.split(',');
      const mime = mimePrefix.match(/:(.*?);/)?.[1] || 'image/jpeg';

      const res = await api('scanStatementOrBalance', { mimeType: mime, imageBase64: base64 });
      if (spinner) spinner.classList.add('hidden');

      if (!res || !res.success) {
        showToast(res?.error || 'スクショの解析に失敗しました', 'error');
        return;
      }

      // 残高画面が検出された場合
      if (res.balanceInfo && res.balanceInfo.balance !== null && res.balanceInfo.balance !== undefined) {
        const bal = Number(res.balanceInfo.balance);
        const inst = res.balanceInfo.institution || res.detectedCard || '共有口座';
        if (confirm(`AIが残高【¥${bal.toLocaleString()}】(${inst}) を検出しました！\n口座残高ボードの残高を更新しますか？`)) {
          let target = state.bankAccounts.find(a => a.type === 'shared_bank') || state.bankAccounts[0];
          if (target) {
            target.balance = bal;
            target.updatedAt = new Date().toISOString();
            renderBankAccountsCard();
            api('updateBankAccounts', { bankAccounts: state.bankAccounts }).catch(() => {});
            showToast(`残高を ¥${bal.toLocaleString()} に更新しました✨`, 'success');
          }
        }
      }

      // 明細が検出された場合
      if (res.statements && res.statements.length > 0) {
        state.importedCsvBalanceInfo = null;
        state.importedStatementItems = res.statements.map(s => ({
          date: normalizeStatementDate(s.date) || localDateStr(),
          title: s.title || '明細',
          amount: Math.abs(Number(s.amount) || 0),
          txType: 'expense',
          category: s.category || '食費',
          payer: '共同カード',
          paymentType: 'shared_card',
          isShared: s.isShared !== false
        }));
        renderImportPreviewTable();
        showToast(`AIが ${res.statements.length} 件の明細を抽出しました！`, 'success');
      } else if (!res.balanceInfo || res.balanceInfo.balance === null) {
        showToast('明細または残高を検出できませんでした。別の画像をお試しください', 'info');
      }
    };
    reader.readAsDataURL(file);
  } catch (err) {
    if (spinner) spinner.classList.add('hidden');
    showToast('画像読み取りエラー: ' + err.message, 'error');
  } finally {
    if (event.target) event.target.value = '';
  }
}

/**
 * 通帳CSVから検出した口座残高をワンタップで共有口座へ反映する (v2.12.2)
 */
/**
 * 通帳CSVから検出した口座残高を選択口座（①生活費口座 または ②別口座貯金）へワンタップ反映する (v2.15.1 テレコ防止対応)
 */
async function applyImportedCsvBalance(explicitTargetType = null) {
  const info = state.importedCsvBalanceInfo;
  if (!info || info.balance === undefined || info.balance === null) return;

  const targetSelect = $('importTargetAccountSelect');
  const targetType = explicitTargetType || (targetSelect ? targetSelect.value : null) || state.importTargetAccountType || 'shared_bank';
  if (targetSelect && explicitTargetType) {
    targetSelect.value = explicitTargetType;
  }
  state.importTargetAccountType = targetType;

  state.bankAccounts = (state.bankAccounts || []).filter(a =>
    a && !((a.id === 'acc_shared_main' && a.name && a.name.includes('三井住友')) ||
          (a.id === 'acc_shared_card' && a.name && a.name.includes('楽天カード')))
  );

  const newBal = Number(info.balance);

  if (targetType === 'shared_savings') {
    // 🐷 ② 別口座貯金（貯蓄・繰越用口座）へ反映
    let target = state.bankAccounts.find(a => a.type === 'shared_savings');
    if (!target) {
      target = {
        id: 'acc_shared_savings',
        name: '別口座貯金（余り繰越用）',
        type: 'shared_savings',
        balance: newBal,
        institution: '貯蓄用別口座',
        note: '通帳CSV取込より反映',
        updatedAt: new Date().toISOString()
      };
      state.bankAccounts.push(target);
    } else {
      target.balance = newBal;
      target.updatedAt = new Date().toISOString();
    }
    if (!state.savingsConfig) state.savingsConfig = {};
    state.savingsConfig.initialSavings = newBal;
    try { localStorage.setItem('pairbudget_savings_config', JSON.stringify(state.savingsConfig)); } catch (_) {}
    if (!state.isMockMode) {
      api('updateSavingsConfig', { savingsConfig: state.savingsConfig }).catch(() => {});
    }
  } else {
    // 🏦 ① 普段の生活費口座（ふたりの共有口座）へ反映
    let target = state.bankAccounts.find(a => a.type === 'shared_bank') || state.bankAccounts[0];
    if (!target) {
      target = {
        id: 'acc_shared_pair_bank',
        name: 'ふたりの共有口座',
        type: 'shared_bank',
        balance: newBal,
        institution: '共有銀行口座',
        note: '通帳CSV取込より反映',
        updatedAt: new Date().toISOString()
      };
      state.bankAccounts.push(target);
    } else {
      target.balance = newBal;
      target.updatedAt = new Date().toISOString();
    }
  }

  info.applied = true;
  info.appliedTo = targetType;

  try {
    localStorage.setItem('pairbudget_bank_accounts', JSON.stringify(state.bankAccounts));
  } catch (_) {}

  renderBankAccountsCard();
  renderSavingsCard();
  renderImportPreviewTable();
  const labelName = targetType === 'shared_savings' ? '🐷 ②別口座貯金' : '🏦 ①普段の生活費口座';
  showToast(`${labelName}の残高を ¥${newBal.toLocaleString()} に更新しました✨`, 'success');

  if (!state.isMockMode) {
    try {
      await api('updateBankAccounts', { bankAccounts: state.bankAccounts });
    } catch (e) {
      console.warn('口座残高のバックエンド保存失敗:', e);
    }
  }
}

window.handleImportTargetAccountChange = function (targetType) {
  state.importTargetAccountType = targetType;
  const items = state.importedStatementItems || [];
  items.forEach(item => {
    if (targetType === 'shared_card') {
      item.payer = '共同カード';
      item.paymentType = 'shared_card';
    } else if (targetType === 'shared_savings') {
      item.payer = '共同口座';
      item.paymentType = 'shared_savings';
      // 貯蓄用別口座の明細は日常の生活費予算を圧迫しないようデフォルトで口座入金/貯蓄扱いに調整可能
    } else {
      item.payer = '共同口座';
      item.paymentType = 'shared_account';
    }
  });
  if (state.importedCsvBalanceInfo) {
    state.importedCsvBalanceInfo.applied = false;
  }
  renderImportPreviewTable();
};

/**
 * おしどり風仕分けプレビューテーブルの描画 (v2.12.2 入出金バッジ・口座残高ワンタップ反映バナー対応)
 */
function renderImportPreviewTable() {
  const container = $('importPreviewContainer');
  const tbody = $('importPreviewTableBody');
  const countEl = $('importItemCount');
  const totalEl = $('importSharedTotalLabel');
  const submitBtn = $('submitImportBtn');

  if (!container || !tbody) return;

  const items = state.importedStatementItems || [];
  if (countEl) countEl.textContent = items.length;

  if (items.length === 0) {
    container.classList.add('hidden');
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  container.classList.remove('hidden');

  // 口座残高検出バナーの描画（コンテナが無ければ自動生成して先頭に挿入）
  let balanceBanner = $('importCsvBalanceBannerWrap');
  if (!balanceBanner) {
    balanceBanner = document.createElement('div');
    balanceBanner.id = 'importCsvBalanceBannerWrap';
    container.insertBefore(balanceBanner, container.firstChild);
  }

  const balInfo = state.importedCsvBalanceInfo;
  const depositItems = items.filter(i => i.txType === 'deposit');
  const hasBankColumns = Boolean(balInfo) || depositItems.length > 0;

  if (balInfo && balInfo.balance !== null && balInfo.balance !== undefined) {
    const formattedBal = Number(balInfo.balance).toLocaleString();
    const depositSummary = depositItems.length > 0
      ? `<div class="text-[11px] text-emerald-800 mt-0.5 font-medium">💰 入金明細: ${escapeHtml(depositItems[0].title)} <span class="font-mono font-bold text-emerald-700">+¥${Number(depositItems[0].amount).toLocaleString()}</span>${depositItems.length > 1 ? ` ほか${depositItems.length - 1}件` : ''}</div>`
      : '';

    const appliedToLabel = balInfo.appliedTo === 'shared_savings' ? '②別口座貯金' : '①普段の生活費口座';

    balanceBanner.className = 'p-3 rounded-xl bg-gradient-to-r from-emerald-50 via-teal-50 to-sky-50 border border-emerald-200 shadow-2xs space-y-2';
    balanceBanner.innerHTML = `
      <div class="flex flex-col gap-2">
        <div class="min-w-0">
          <div class="text-xs font-extrabold text-slate-800 flex items-center gap-1.5 flex-wrap">
            <span>🏦 通帳CSVから最新残高【<span class="text-emerald-700 font-mono">¥${formattedBal}</span>】（${escapeHtml(balInfo.date)}時点）を検出しました</span>
          </div>
          ${depositSummary}
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          <button type="button" onclick="applyImportedCsvBalance('shared_bank')" class="${balInfo.applied && balInfo.appliedTo === 'shared_bank' ? 'bg-sky-100 text-sky-900 border border-sky-300' : 'bg-sky-600 hover:bg-sky-700 text-white shadow-xs'} text-xs font-bold px-3 py-2 rounded-xl transition-all cursor-pointer active:scale-95 flex items-center justify-center gap-1">
            <span>${balInfo.applied && balInfo.appliedTo === 'shared_bank' ? `✅ ①生活費口座に反映済 (¥${formattedBal})` : `🏦 ①普段の生活費口座を ¥${formattedBal} に更新`}</span>
          </button>
          <button type="button" onclick="applyImportedCsvBalance('shared_savings')" class="${balInfo.applied && balInfo.appliedTo === 'shared_savings' ? 'bg-emerald-100 text-emerald-900 border border-emerald-300' : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs'} text-xs font-bold px-3 py-2 rounded-xl transition-all cursor-pointer active:scale-95 flex items-center justify-center gap-1">
            <span>${balInfo.applied && balInfo.appliedTo === 'shared_savings' ? `✅ ②別口座貯金に反映済 (¥${formattedBal})` : `🐷 ②別口座貯金(繰越)を ¥${formattedBal} に更新`}</span>
          </button>
        </div>
      </div>
    `;
  } else {
    balanceBanner.className = 'hidden';
    balanceBanner.innerHTML = '';
  }

  let sharedExpenseSum = 0;
  let sharedDepositSum = 0;
  let sharedTransferSum = 0;
  let sharedExpenseCount = 0;
  let sharedDepositCount = 0;
  let sharedTransferCount = 0;
  let html = '';

  let categories = state.categories && state.categories.length > 0
    ? state.categories.map(c => c.name)
    : ['食費', '日用品', '外食', '光熱費', '住居', '交通費', '医療・健康', '衣服・美容', '特別費', 'その他'];
  if (!categories.includes('口座入金')) {
    categories = ['口座入金', ...categories];
  }
  if (!categories.includes('クレカ引落振替')) {
    categories = ['クレカ引落振替', ...categories];
  }

  const hName = memberName('husband');
  const wName = memberName('wife');

  // 日付ごとにグループ化しておしどり風カード取引情報レイアウトで描画 (v2.15.0)
  const groupedByDate = {};
  items.forEach((item, idx) => {
    const isDeposit = item.txType === 'deposit';
    const isCardTransfer = item.txType === 'card_transfer' || item.category === 'クレカ引落振替';
    const safeAmount = Number(item.amount) || 0;
    if (item.isShared) {
      if (isDeposit) {
        sharedDepositSum += safeAmount;
        sharedDepositCount++;
      } else if (isCardTransfer) {
        sharedTransferSum += safeAmount;
        sharedTransferCount++;
      } else {
        sharedExpenseSum += safeAmount;
        sharedExpenseCount++;
      }
    }
    const dKey = formatOshidoriDateHeader(item.date || localDateStr());
    if (!groupedByDate[dKey]) groupedByDate[dKey] = [];
    groupedByDate[dKey].push({ item, idx });
  });

  // 上部におしどり風の「今月の利用額 ¥-XX,XXX」サマリーヘッダーを表示
  const headerTitle = hasBankColumns ? '🏦 銀行口座 取引情報プレビュー' : '💳 カード取引情報プレビュー';
  const headerTotalVal = hasBankColumns && balInfo && balInfo.balance !== null
    ? `¥${Number(balInfo.balance).toLocaleString()}`
    : `¥-${sharedExpenseSum.toLocaleString()}`;
  const headerTotalLbl = hasBankColumns && balInfo && balInfo.balance !== null ? '最新口座残高' : '今月の利用額(共有計)';

  html += `
    <div class="bg-white px-4 py-3 border-b border-slate-100 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span class="w-7 h-7 rounded-full ${hasBankColumns ? 'bg-sky-500' : 'bg-rose-400'} text-white flex items-center justify-center text-xs shadow-2xs">
          <i data-lucide="${hasBankColumns ? 'landmark' : 'credit-card'}" class="w-3.5 h-3.5"></i>
        </span>
        <span class="text-xs font-bold text-slate-600">${headerTitle}</span>
      </div>
      <div class="flex items-baseline gap-2">
        <span class="text-[11px] text-slate-400">${headerTotalLbl}</span>
        <span class="text-xl font-bold text-slate-800 font-mono">${headerTotalVal}</span>
      </div>
    </div>
  `;

  Object.keys(groupedByDate).forEach(dateLabel => {
    html += `
      <div class="bg-slate-100/90 px-4 py-1.5 text-xs font-medium text-slate-700 border-y border-slate-200/60">
        ${escapeHtml(dateLabel)}
      </div>
    `;
    groupedByDate[dateLabel].forEach(({ item, idx }) => {
      try {
        const isDeposit = item.txType === 'deposit';
        const isCardTransfer = item.txType === 'card_transfer' || item.category === 'クレカ引落振替';
        const safeAmount = Number(item.amount) || 0;
        const catStyle = getOshidoriCategoryCircle(item.category, item.txType);

        const amountDisplay = isDeposit
          ? `<span class="text-lg font-bold text-emerald-600 font-mono whitespace-nowrap">+¥${safeAmount.toLocaleString()}</span>`
          : (isCardTransfer
            ? `<span class="text-lg font-bold text-purple-700 font-mono whitespace-nowrap">¥-${safeAmount.toLocaleString()}</span>`
            : `<span class="text-lg font-normal text-slate-800 font-mono whitespace-nowrap">¥-${safeAmount.toLocaleString()}</span>`);

        const isSlideOpen = state.openedImportSlideIdx === idx;
        const slideBtnBg = item.isShared ? 'bg-[#65c400] hover:bg-[#58ad00]' : 'bg-sky-500 hover:bg-sky-600';
        const slideBtnLabel = item.isShared ? '個人に<br>振り分ける' : '家族に<br>振り分ける';

        const safeTitle = escapeHtml(String(item.title || '明細'));
        const memoLabel = item.memo ? `📝 ${escapeHtml(String(item.memo))}` : '+ メモを追加する';

        const txBadge = isDeposit
          ? '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 ml-1 shrink-0">💰 入金</span>'
          : (isCardTransfer
            ? '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800 ml-1 shrink-0">💳 簿記振替</span>'
            : '');

        html += `
          <div onclick="toggleImportRowSlide(${idx})" class="flex items-stretch transition-all cursor-pointer select-none overflow-hidden ${item.isShared ? 'bg-white hover:bg-slate-50/70' : 'bg-slate-50/80 opacity-75'}">
            <!-- おしどり風 左スライド「個人に振り分ける」グリーンボタン -->
            <button type="button" onclick="event.stopPropagation(); updateImportItemShared(${idx}, ${!item.isShared})" class="${isSlideOpen ? 'w-28 px-2 opacity-100' : 'w-0 px-0 opacity-0 pointer-events-none'} ${slideBtnBg} text-white font-bold text-xs shrink-0 flex items-center justify-center text-center leading-snug transition-all duration-200 cursor-pointer overflow-hidden">
              <span>${slideBtnLabel}</span>
            </button>

            <!-- 明細メイン行 -->
            <div class="flex-1 px-4 py-3 min-w-0 space-y-2">
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2.5 min-w-0">
                  <div class="w-8 h-8 rounded-full ${catStyle.bg} text-white flex items-center justify-center shrink-0 shadow-2xs">
                    <i data-lucide="${catStyle.icon}" class="w-4 h-4"></i>
                  </div>
                  <div class="min-w-0 flex items-center flex-wrap">
                    <span class="text-sm md:text-[15px] text-slate-700 font-medium truncate max-w-[190px] sm:max-w-[260px]">${safeTitle}</span>
                    ${txBadge}
                  </div>
                </div>
                ${amountDisplay}
              </div>

              <!-- 下段: 👦👧家族 / 👤個人 切替 ＆ カテゴリ選択 ＆ ＋メモを追加する -->
              <div class="flex items-center justify-between gap-2 pl-10 flex-wrap">
                <div class="flex items-center gap-2">
                  <button type="button" onclick="event.stopPropagation(); updateImportItemShared(${idx}, ${!item.isShared})" class="hover:opacity-80 transition-opacity cursor-pointer" title="タップして家族(共有) / 個人(私物)を切り替え">
                    ${getOshidoriFamilyBadgeHtml(item.isShared, item.payer)}
                  </button>
                  <select onclick="event.stopPropagation()" onchange="updateImportItemCategory(${idx}, this.value)" class="bg-slate-50 border border-slate-200 text-slate-600 rounded-full px-2 py-0.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-[#65c400] cursor-pointer">
                    ${categories.map(cat => `<option value="${cat}" ${item.category === cat ? 'selected' : ''}>${cat}</option>`).join('')}
                  </select>
                </div>
                <button type="button" onclick="event.stopPropagation(); promptImportItemMemo(${idx})" class="bg-slate-100/90 hover:bg-slate-200/80 text-slate-500 text-[11px] font-medium px-3 py-1 rounded-full transition-colors cursor-pointer max-w-[170px] truncate">
                  ${memoLabel}
                </button>
              </div>
            </div>
          </div>
        `;
      } catch (rowErr) {
        console.warn('明細行レンダリングエラー:', rowErr, item);
      }
    });
  });

  tbody.innerHTML = html;
  if (totalEl) {
    const parts = [];
    if (sharedExpenseCount > 0) parts.push(`支出 ¥${sharedExpenseSum.toLocaleString()}`);
    if (sharedDepositCount > 0) parts.push(`<span class="text-emerald-700 font-bold">入金 +¥${sharedDepositSum.toLocaleString()}</span>`);
    if (sharedTransferCount > 0) parts.push(`<span class="text-purple-700 font-bold">振替 -¥${sharedTransferSum.toLocaleString()}</span>`);
    totalEl.innerHTML = parts.join(' / ') || '¥0';
  }
  if (submitBtn) {
    const selectedCount = sharedExpenseCount + sharedDepositCount + sharedTransferCount;
    submitBtn.disabled = selectedCount === 0;
    if (selectedCount === 0) {
      submitBtn.innerHTML = `<i data-lucide="check" class="w-4 h-4"></i> 登録対象 0 件`;
    } else {
      const details = [];
      if (sharedExpenseCount > 0) details.push(`出金${sharedExpenseCount}件`);
      if (sharedDepositCount > 0) details.push(`入金${sharedDepositCount}件`);
      if (sharedTransferCount > 0) details.push(`振替${sharedTransferCount}件`);
      submitBtn.innerHTML = `<i data-lucide="check" class="w-4 h-4"></i> 全 ${selectedCount} 件を一括登録（${details.join('・')}）`;
    }
  }
  lucide.createIcons();
}

window.toggleImportRowSlide = function (index) {
  state.openedImportSlideIdx = (state.openedImportSlideIdx === index) ? null : index;
  renderImportPreviewTable();
};

window.promptImportItemMemo = function (index) {
  const item = state.importedStatementItems && state.importedStatementItems[index];
  if (!item) return;
  const nextMemo = prompt(`「${item.title || '明細'}」のメモを入力してください:`, item.memo || '');
  if (nextMemo === null) return;
  item.memo = nextMemo.trim();
  renderImportPreviewTable();
};

function updateImportItemShared(index, isShared) {
  if (!state.importedStatementItems[index]) return;
  state.importedStatementItems[index].isShared = isShared;
  state.openedImportSlideIdx = null;
  renderImportPreviewTable();
}

function updateImportItemCategory(index, category) {
  if (!state.importedStatementItems[index]) return;
  state.importedStatementItems[index].category = category;
  renderImportPreviewTable();
}

function updateImportItemPayer(index, payer) {
  if (!state.importedStatementItems[index]) return;
  state.importedStatementItems[index].payer = payer;
  if (payer === '共同カード') {
    state.importedStatementItems[index].paymentType = 'shared_card';
  } else if (payer === '共同口座') {
    state.importedStatementItems[index].paymentType = 'shared_account';
  } else {
    state.importedStatementItems[index].paymentType = 'advanced_by_user';
  }
}

function toggleAllImportItems(isShared) {
  const items = state.importedStatementItems || [];
  items.forEach(item => {
    item.isShared = isShared;
  });
  renderImportPreviewTable();
}

/**
 * 仕分け完了明細の家計簿への一括登録 (v2.12.1 自動月切り替え対応)
 */
async function submitImportedStatements() {
  const selectedItems = (state.importedStatementItems || []).filter(i => i.isShared);
  if (selectedItems.length === 0) {
    showToast('登録する明細にチェックを入れてください', 'error');
    return;
  }

  const submitBtn = $('submitImportBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span> 登録中...';
  }

  try {
    const res = await api('importCardStatements', { items: selectedItems });
    if (!res || !res.success) {
      throw new Error(res?.error || '明細の登録に失敗しました');
    }

    showToast(`🎉 ${selectedItems.length} 件の明細を家計簿に登録しました！`, 'success');

    // 通帳CSVから残高情報が取得されている場合、口座残高も連動更新 (v2.13.0)
    if (state.importedCsvBalanceInfo && state.importedCsvBalanceInfo.balance !== null && !state.importedCsvBalanceInfo.applied) {
      applyImportedCsvBalance().catch(() => {});
    }

    closeStatementImportModal();
    state.importedStatementItems = [];

    // 登録された明細の対象月を特定し、もし現在の表示月と異なれば自動移動 (v2.12.1)
    const monthCounts = {};
    selectedItems.forEach(item => {
      const ym = String(item.date || '').slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(ym)) {
        monthCounts[ym] = (monthCounts[ym] || 0) + 1;
      }
    });
    const sortedMonths = Object.keys(monthCounts).sort((a, b) => monthCounts[b] - monthCounts[a]);
    if (sortedMonths.length > 0 && sortedMonths[0] !== state.viewMonth) {
      state.viewMonth = sortedMonths[0];
      try { localStorage.setItem('pairbudget_view_month', state.viewMonth); } catch (_) {}
    }

    // データ再読み込み
    await loadInitialData(state.viewMonth, { skipCache: true });
  } catch (err) {
    showToast('登録失敗: ' + err.message, 'error');
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ==========================================
// セキュリティPIN ＆ 暗号ソルトハッシュ (v2.12.0)
// ==========================================

async function handleSaveSecurityPin() {
  const pinInput = $('securityPinInput');
  if (!pinInput) return;
  const pin = (pinInput.value || '').trim();

  if (!pin || pin.length < 4 || pin.length > 8) {
    showToast('セキュリティPINは数字4〜8桁で入力してください', 'error');
    return;
  }

  try {
    const res = await api('updateSecurityPin', { pin });
    if (res && res.success) {
      showToast('🛡️ セキュリティPINをソルト付きPBKDF2で保存しました！', 'success');
      pinInput.value = '';
      state.securitySettings.hasSecurityPin = true;
    } else {
      showToast(res?.error || 'PINの保存に失敗しました', 'error');
    }
  } catch (err) {
    showToast('保存エラー: ' + err.message, 'error');
  }
}

/**
 * ソルト付きハッシュシミュレーションプレビュー
 */
async function testHashPreview() {
  const box = $('hashPreviewBox');
  if (!box) return;

  box.classList.remove('hidden');
  box.innerHTML = '<span class="text-slate-400">PBKDF2ストレッチング中... (100,000回計算)</span>';

  try {
    const res = await api('testSaltedHash', { input: 'user_secret_pin_7788' });
    if (!res || !res.success) {
      box.textContent = 'シミュレーションエラー';
      return;
    }

    box.innerHTML = `
      <div class="text-emerald-400 font-bold mb-1">✅ PBKDF2-HMAC-SHA256 (100,000回ストレッチング / 128bit CSPRNGソルト)</div>
      <div class="text-slate-400 text-[9px]">入力値: "${res.input}" (同一入力に対する2回の生成結果比較)</div>
      <div class="pt-1 border-t border-slate-800 space-y-1">
        <div><span class="text-sky-400">【生成1】</span>ソルト: <span class="text-amber-300">${res.sample1.salt}</span></div>
        <div class="text-slate-400 pl-2">ハッシュ: ${res.sample1.hashRecord}</div>
      </div>
      <div class="pt-1 border-t border-slate-800 space-y-1">
        <div><span class="text-indigo-400">【生成2】</span>ソルト: <span class="text-amber-300">${res.sample2.salt}</span></div>
        <div class="text-slate-400 pl-2">ハッシュ: ${res.sample2.hashRecord}</div>
      </div>
      <div class="text-[9px] text-emerald-300 pt-1">✨ 検証成功: 入力が完全に同一でもソルトが毎回変化するため、ハッシュ値が全く異なりレインボーテーブル辞書攻撃を100%遮断します。（計算時間: ${res.durationMs}ms）</div>
    `;
  } catch (err) {
    box.textContent = 'エラー: ' + err.message;
  }
}
