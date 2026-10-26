
/**
 * PC等から直接LINE公式ログイン画面を開く
 */
function triggerDirectLineLogin() {
  if (typeof liff !== 'undefined' && liff.init) {
    if (liff.isLoggedIn()) {
      showToast('すでにLINEログイン済みです！');
      return;
    }
    try {
      liff.login({ redirectUri: window.location.href.split('?')[0].split('#')[0] });
    } catch (e) {
      console.warn('liff.login fallback:', e);
      window.location.href = 'https://liff.line.me/' + LIFF_ID;
    }
  } else {
    window.location.href = 'https://liff.line.me/' + LIFF_ID;
  }
}
window.triggerDirectLineLogin = triggerDirectLineLogin;


/**
 * LINE認証状態をUIに反映
 */
// ================= GAS ネイティブブリッジ (google.script.run 自動通信) =================
const _nativeFetch = typeof window !== 'undefined' && typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
if (typeof window !== 'undefined') {
  window.fetch = function(url, options) {
    const isGasBridge = typeof url === 'string' && (
      url.indexOf('__GAS_BRIDGE__') !== -1 ||
      (typeof google !== 'undefined' && google.script && google.script.run && state && state.gasApiUrl && url.indexOf(state.gasApiUrl) === 0)
    );
    if (isGasBridge && typeof google !== 'undefined' && google.script && google.script.run) {
      return new Promise(function(resolve) {
        let payloadStr = (options && options.body) ? String(options.body) : JSON.stringify({ action: 'getAll' });
        google.script.run
          .withSuccessHandler(function(resJson) {
            let parsed = resJson;
            if (typeof resJson === 'string') {
              try { parsed = JSON.parse(resJson); } catch (e) { parsed = { success: false }; }
            }
            resolve({
              ok: true,
              status: 200,
              json: function() { return Promise.resolve(parsed); },
              text: function() { return Promise.resolve(typeof resJson === 'string' ? resJson : JSON.stringify(parsed)); }
            });
          })
          .withFailureHandler(function(err) {
            resolve({
              ok: false,
              status: 500,
              json: function() { return Promise.resolve({ success: false, error: String(err) }); },
              text: function() { return Promise.resolve(String(err)); }
            });
          })
          .gasBridge(payloadStr);
      });
    }
    return _nativeFetch ? _nativeFetch(url, options) : Promise.reject(new Error('fetch unavailable'));
  };
}

/**
 * LINEプロフィール情報をアプリ全体に適用・引き継ぎ
 */
function applyLineProfile(profile, saveToServer) {
  if (!profile || !profile.userId) return;
  const oldUserId = state.currentUserId;
  state.lineProfile = {
    userId: String(profile.userId),
    displayName: String(profile.displayName || 'LINEユーザー'),
    pictureUrl: String(profile.pictureUrl || '')
  };
  state.currentUserId = state.lineProfile.userId;
  state.groupSettings.myName = state.lineProfile.displayName;

  const avatarHtml = state.lineProfile.pictureUrl
    ? '<img src="' + state.lineProfile.pictureUrl + '" class="line-avatar-img" alt="avatar" style="width:20px;height:20px;border-radius:50%;object-fit:cover;vertical-align:middle;">'
    : '🟢';

  TEST_USERS[state.lineProfile.userId] = {
    id: state.lineProfile.userId,
    name: state.lineProfile.displayName,
    avatar: avatarHtml
  };
  TEST_USERS.user_a.name = state.lineProfile.displayName;

  // 初期ゲスト('user_a')で作った明細やグループがあれば自分のLINE IDへ自動引き継ぎ
  let migrated = false;
  if (Array.isArray(state.transactions)) {
    state.transactions.forEach(function(t) {
      if (!t.userId || t.userId === 'user_a' || t.userId === oldUserId) {
        t.userId = state.lineProfile.userId;
        t.userName = state.lineProfile.displayName;
        migrated = true;
      }
    });
    if (migrated) saveTransactionsLocal();
  }

  if (Array.isArray(state.groups)) {
    state.groups.forEach(function(g) {
      if (g.ownerId === 'user_a') g.ownerId = state.lineProfile.userId;
      let found = false;
      g.members.forEach(function(m) {
        if (m.userId === 'user_a' || m.userId === state.lineProfile.userId) {
          m.userId = state.lineProfile.userId;
          m.name = state.lineProfile.displayName;
          found = true;
        }
      });
      if (!found) {
        g.members.push({
          userId: state.lineProfile.userId,
          name: state.lineProfile.displayName,
          role: g.ownerId === state.lineProfile.userId ? 'owner' : 'member',
          status: 'approved',
          joinedAt: new Date().toISOString()
        });
      }
    });
    saveGroupsLocal();
  }

  if (!state.savedLineProfiles) state.savedLineProfiles = {};
  state.savedLineProfiles[state.lineProfile.userId] = state.lineProfile;

  safeStorage.setItem('kakeibo_current_user', state.lineProfile.userId);
  safeStorage.setItem('kakeibo_my_name', state.lineProfile.displayName);
  safeStorage.setItem('kakeibo_line_profile', JSON.stringify(state.lineProfile));

  updateLineAuthUI();
  updateGroupConfigInputs();
  updateUserSwitcherUI();
  updateGroupDropdownUI();
  renderApp();

  if (saveToServer && state.gasApiUrl) {
    fetch(state.gasApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'saveLineProfile', payload: state.lineProfile })
    }).catch(function() {});
  }
}

/**
 * LINE認証状態をヘッダーUIに反映
 */
function updateLineAuthUI() {
  const lineBtn = document.getElementById('btnLineLoginHeader');
  if (!lineBtn) return;

  if (state.lineProfile && state.lineProfile.userId) {
    lineBtn.classList.add('logged-in');
    const name = state.lineProfile.displayName || 'LINE連携中';
    const avatar = state.lineProfile.pictureUrl
      ? '<img src="' + state.lineProfile.pictureUrl + '" style="width:18px;height:18px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:4px;">'
      : '<span class="line-logo-badge">LINE</span> ';
    lineBtn.innerHTML = avatar + '<span>' + escapeHtml(name) + '</span>';
    lineBtn.title = 'LINEユーザー連携中（クリックで引き継ぎ・設定）';
  } else {
    lineBtn.classList.remove('logged-in');
    lineBtn.innerHTML = '<span class="line-logo-badge">LINE</span><span id="lineLoginBtnText">LINE連携・引き継ぎ</span>';
    lineBtn.title = 'LINEユーザー情報の連携・引き継ぎ';
  }
}

/**
 * LINE連携・引き継ぎモーダルを開く
 */
function handleLineLoginClick() {
  openLineAuthModal();
}

function openLineAuthModal() {
  const overlay = document.getElementById('lineAuthModalOverlay');
  if (!overlay) return;
  renderLineAuthModal();
  overlay.classList.add('open');
}

function closeLineAuthModal() {
  const overlay = document.getElementById('lineAuthModalOverlay');
  if (overlay) overlay.classList.remove('open');
}

function renderLineAuthModal() {
  const currentBox = document.getElementById('lineModalCurrentProfile');
  if (currentBox) {
    if (state.lineProfile && state.lineProfile.userId) {
      const av = state.lineProfile.pictureUrl
        ? '<img src="' + state.lineProfile.pictureUrl + '" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">'
        : '<span style="font-size:22px;">🟢</span>';
      currentBox.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;">' +
          av +
          '<div>' +
            '<div style="font-weight:700;font-size:15px;color:#0f172a;">' + escapeHtml(state.lineProfile.displayName) + ' <span style="font-size:11px;background:#dcfce7;color:#15803d;padding:2px 6px;border-radius:8px;">連携中</span></div>' +
            '<div style="font-size:11px;color:#64748b;">ID: ' + escapeHtml(state.lineProfile.userId) + '</div>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="outline-btn" style="padding:5px 10px;font-size:12px;" onclick="handleDisconnectLineProfile()">解除</button>';
    } else {
      currentBox.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<span style="font-size:20px;">👤</span>' +
          '<div>' +
            '<div style="font-weight:700;font-size:14px;color:#334155;">' + escapeHtml(state.groupSettings.myName || '自分') + ' (未連携)</div>' +
            '<div style="font-size:11px;color:#64748b;">下の方法1〜3のいずれかでLINEユーザー情報を引き継げます</div>' +
          '</div>' +
        '</div>';
    }
  }

  // 保存済みLINEアカウント一覧
  const listEl = document.getElementById('savedLineProfilesList');
  if (listEl) {
    const profiles = Object.values(state.savedLineProfiles || {});
    if (profiles.length === 0) {
      listEl.innerHTML = '<div style="font-size:12px; color:#94a3b8; text-align:center; padding:8px;">まだスプレッドシートに保存されたLINEアカウントはありません。<br>スマホのLINEで開くか、下の「方法3」で登録するとここに表示されます。</div>';
    } else {
      listEl.innerHTML = profiles.map(function(p) {
        const isCurrent = state.lineProfile && state.lineProfile.userId === p.userId;
        const av = p.pictureUrl
          ? '<img src="' + p.pictureUrl + '" style="width:28px;height:28px;border-radius:50%;object-fit:cover;">'
          : '<span style="font-size:20px;">🟢</span>';
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:10px;">' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            av +
            '<div>' +
              '<div style="font-weight:700;font-size:13.5px;color:#1e293b;">' + escapeHtml(p.displayName) + '</div>' +
              '<div style="font-size:11px;color:#64748b;">ID: ' + escapeHtml(p.userId) + '</div>' +
            '</div>' +
          '</div>' +
          (isCurrent
            ? '<span style="font-size:12px;font-weight:700;color:#15803d;">✓ 適用中</span>'
            : '<button type="button" class="primary-btn" style="padding:5px 12px;font-size:12px;background:#06C755;" data-uid="' + escapeHtml(p.userId) + '" onclick="handleSelectSavedLineProfile(this.dataset.uid)">このユーザーで引き継ぐ</button>') +
        '</div>';
      }).join('');
    }
  }

  const nameInput = document.getElementById('manualLineDisplayName');
  const idInput = document.getElementById('manualLineUserId');
  if (nameInput) nameInput.value = (state.lineProfile && state.lineProfile.displayName) || state.groupSettings.myName || '';
  if (idInput) idInput.value = (state.lineProfile && state.lineProfile.userId) || '';
}

function handleSelectSavedLineProfile(userId) {
  const p = (state.savedLineProfiles || {})[userId];
  if (!p) return;
  applyLineProfile(p, false);
  renderLineAuthModal();
  closeLineAuthModal();
  showToast('🟢 LINEユーザー「' + p.displayName + '」を引き継ぎました！');
}

function handleSaveManualLineProfile() {
  const nameInput = document.getElementById('manualLineDisplayName');
  const idInput = document.getElementById('manualLineUserId');
  const displayName = (nameInput ? nameInput.value : '').trim();
  if (!displayName) {
    alert('あなたの表示名を入力してください');
    return;
  }
  let userId = (idInput ? idInput.value : '').trim();
  if (!userId) {
    userId = 'line_' + displayName.replace(/\s+/g, '_').toLowerCase();
  }
  const profile = {
    userId: userId,
    displayName: displayName,
    pictureUrl: (state.lineProfile && state.lineProfile.pictureUrl) || ''
  };
  applyLineProfile(profile, true);
  renderLineAuthModal();
  closeLineAuthModal();
  showToast('🟢 ユーザー情報「' + displayName + '」を保存・同期しました！');
}

function handleDisconnectLineProfile() {
  if (typeof liff !== 'undefined' && liff.isLoggedIn && liff.isLoggedIn()) {
    try { liff.logout(); } catch (e) {}
  }
  state.lineProfile = null;
  state.currentUserId = 'user_a';
  safeStorage.removeItem('kakeibo_line_profile');
  safeStorage.setItem('kakeibo_current_user', 'user_a');
  updateLineAuthUI();
  renderLineAuthModal();
  renderApp();
  showToast('連携を解除しました');
}

function copyLiffUrl() {
  const url = 'https://liff.line.me/' + LIFF_ID;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function() {
      showToast('📋 LIFF URLをコピーしました！LINEのトークやKeepメモに貼り付けて開いてください');
    });
  } else {
    prompt('以下のURLをコピーしてLINEで開いてください:', url);
  }
}

window.handleLineLoginClick = handleLineLoginClick;
window.openLineAuthModal = openLineAuthModal;
window.closeLineAuthModal = closeLineAuthModal;
window.handleSelectSavedLineProfile = handleSelectSavedLineProfile;
window.handleSaveManualLineProfile = handleSaveManualLineProfile;
window.handleDisconnectLineProfile = handleDisconnectLineProfile;
window.copyLiffUrl = copyLiffUrl;
window.updateLineAuthUI = updateLineAuthUI;

/**
 * 家計簿Plus - Web Application Core Logic
 * Google Apps Script (GAS) 連携 & LocalStorage ハイブリッド
 */

// ================= 安全なストレージラッパー (GAS iframe / 3rd-party cookie制限環境でも100%安全に動作) =================
const safeStorage = {
  _mem: {},
  _canUseStorage: null,
  _check: function() {
    if (this._canUseStorage !== null) return this._canUseStorage;
    try {
      if (typeof window !== 'undefined' && 'localStorage' in window && window.localStorage) {
        const testKey = '__storage_test__';
        window.localStorage.setItem(testKey, '1');
        window.localStorage.removeItem(testKey);
        this._canUseStorage = true;
        return true;
      }
    } catch (e) {}
    this._canUseStorage = false;
    return false;
  },
  getItem: function(key) {
    if (this._check()) {
      try {
        const val = window.localStorage.getItem(key);
        if (val !== null) return val;
      } catch (e) {}
    }
    return this._mem[key] !== undefined ? this._mem[key] : null;
  },
  setItem: function(key, val) {
    if (this._check()) {
      try {
        window.localStorage.setItem(key, String(val));
      } catch (e) {}
    }
    this._mem[key] = String(val);
  },
  removeItem: function(key) {
    if (this._check()) {
      try {
        window.localStorage.removeItem(key);
      } catch (e) {}
    }
    delete this._mem[key];
  }
};

// 既定カテゴリ定義
const DEFAULT_CATEGORIES = {
  expense: [
    { name: '食費', icon: '🛒' },
    { name: '外食', icon: '🍽️' },
    { name: '日用品', icon: '🧴' },
    { name: '交通費', icon: '🚃' },
    { name: '水道光熱費', icon: '💡' },
    { name: '住居費', icon: '🏠' },
    { name: '衣服・美容', icon: '👕' },
    { name: '医療', icon: '🏥' },
    { name: '通信', icon: '📱' },
    { name: '趣味・娯楽', icon: '🎮' },
    { name: 'その他', icon: '📦' }
  ],
  income: [
    { name: '給料', icon: '💰' },
    { name: 'お小遣い', icon: '🎁' },
    { name: '副業', icon: '💻' },
    { name: '臨時収入', icon: '💎' },
    { name: 'その他', icon: '📦' }
  ]
};

// カスタムカテゴリ読み込み
function loadCustomCategories() {
  const saved = safeStorage.getItem('kakeibo_custom_categories');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed && Array.isArray(parsed.expense) && Array.isArray(parsed.income)) {
        return {
          expense: parsed.expense.map(c => ({ ...c })),
          income: parsed.income.map(c => ({ ...c }))
        };
      }
    } catch (e) {}
  }
  return {
    expense: DEFAULT_CATEGORIES.expense.map(c => ({ ...c })),
    income: DEFAULT_CATEGORIES.income.map(c => ({ ...c }))
  };
}

// カテゴリ定義（カスタム編集とリアルタイム連動）
const CATEGORIES = loadCustomCategories();
window.CATEGORIES = CATEGORIES;

// 既定カテゴリルール定義 (コメダ、コストコ、セブン等)
const DEFAULT_CATEGORY_RULES = [
  { id: 'rule_1', keyword: 'コメダ', category: '食費' },
  { id: 'rule_2', keyword: 'コストコ', category: '食費' },
  { id: 'rule_3', keyword: 'セブン', category: '食費' },
  { id: 'rule_4', keyword: 'ローソン', category: '食費' },
  { id: 'rule_5', keyword: 'ファミリーマート', category: '食費' },
  { id: 'rule_6', keyword: 'Netflix', category: '通信' },
  { id: 'rule_7', keyword: 'ENEOS', category: '交通費' },
  { id: 'rule_8', keyword: 'Amazon', category: '日用品' }
];

// 既定固定費定義 (家賃、サブスク等)
const DEFAULT_FIXED_COSTS = [
  {
    id: 'fc_1',
    type: 'expense',
    category: '住居費',
    amount: 85000,
    day: 27,
    memo: '家賃',
    scope: 'group',
    paidBy: 'me'
  },
  {
    id: 'fc_2',
    type: 'expense',
    category: '通信',
    amount: 1490,
    day: 15,
    memo: 'Netflix',
    scope: 'personal',
    paidBy: 'me'
  }
];

// 曜日表示
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// 予算設定のロード関数
function loadBudgetSettings() {
  const defaultBudgets = {
    personal: {
      monthly: 150000,
      yearly: 1800000,
      categories: {
        '食費': 35000,
        '外食': 15000,
        '日用品': 10000,
        '水道光熱費': 15000,
        '住居費': 80000,
        '趣味・娯楽': 10000
      }
    },
    group: {
      monthly: 250000,
      yearly: 3000000,
      categories: {
        '食費': 60000,
        '外食': 30000,
        '日用品': 15000,
        '水道光熱費': 25000,
        '住居費': 110000,
        '趣味・娯楽': 10000
      }
    }
  };
  const saved = safeStorage.getItem('kakeibo_budget_settings');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      return {
        personal: { ...defaultBudgets.personal, ...(parsed.personal || {}) },
        group: { ...defaultBudgets.group, ...(parsed.group || {}) }
      };
    } catch (e) {}
  }
  // 旧設定からのマイグレーション
  const oldBudget = safeStorage.getItem('kakeibo_budget');
  if (oldBudget && Number(oldBudget) > 0) {
    const val = Number(oldBudget);
    defaultBudgets.personal.monthly = val;
    defaultBudgets.personal.yearly = val * 12;
  }
  return defaultBudgets;
}

// テストユーザー定義 (ユーザーAとユーザーBでプライバシー検証)
const TEST_USERS = {
  user_a: { id: 'user_a', name: '自分', avatar: '👤' }
};

// グループ初期化・保存関数
function loadGroups() {
  const saved = safeStorage.getItem('kakeibo_groups');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {}
  }
  return getDefaultGroups();
}

function saveGroupsLocal() {
  safeStorage.setItem('kakeibo_groups', JSON.stringify(state.groups));
}

function getDefaultGroups() {
  return [
    {
      id: 'grp_default',
      name: '同棲・カップル家計簿',
      passcode: 'LOVE2026',
      ownerId: 'user_a',
      createdAt: '2026-10-24T10:00:00.000Z',
      members: [
        { userId: 'user_a', name: '自分', role: 'owner', status: 'approved' }
        // ※作成者1名のみ！勝手に2名にしない
      ]
    }
  ];
}

// アプリ全体の状態
const state = {
  currentUserId: safeStorage.getItem('kakeibo_current_user') || 'user_a',
  groups: loadGroups(),
  currentGroupId: safeStorage.getItem('kakeibo_current_group_id') || 'grp_default',
  currentYear: 2026,
  currentMonth: 10, // 10月 (1-indexed)
  activeTab: 'details', // 'details' | 'analysis'
  detailsSubView: 'list', // 'list' | 'calendar'
  activeScope: 'personal', // 'personal' | 'group'
  selectedDate: '2026-10-24',
  gasApiUrl: safeStorage.getItem('kakeibo_gas_url') || '',
  geminiApiKey: safeStorage.getItem('kakeibo_gemini_key') || '',
  settings: {
    monthlyBudget: safeStorage.getItem('kakeibo_budget') || ''
  },
  // グループ・個人別、月間・年間・カテゴリ別の詳細予算
  budgetSettings: loadBudgetSettings(),
  groupSettings: {
    myName: safeStorage.getItem('kakeibo_my_name') || '自分',
    partnerName: safeStorage.getItem('kakeibo_partner_name') || 'パートナー',
    splitRatio: parseFloat(safeStorage.getItem('kakeibo_split_ratio')) || 0.5 // 折半
  },
  modalScope: 'personal',
  modalPaidBy: 'me',
  modalSelectedPhoto: null, // 明細追加時の添付写真 (Base64)
  editModalSelectedPhoto: null, // 明細編集時の添付写真 (Base64)
  // 詳細予算モーダル用状態
  budgetModalScope: 'personal',
  // レシートモーダル用状態
  receiptModalState: {
    base64Data: null,
    mimeType: 'image/jpeg',
    scope: 'personal',
    paidBy: 'me'
  },
  transactions: [],
  shoppingList: [],
  charts: {
    cumulative: null,
    recentMonths: null,
    weekday: null
  },
  lineProfile: null
};

// ================= LINE LIFF アカウント認証 (ID: 2012210633-iHf6ozQs) =================
const LIFF_ID = '2012210633-iHf6ozQs';

async function initLiffAuth() {
  if (typeof liff === 'undefined') {
    return;
  }

  try {
    await liff.init({ liffId: LIFF_ID });

    updateLineAuthUI();

    if (!liff.isLoggedIn()) {
      if (liff.isInClient()) {
        liff.login();
      }
      return;
    }

    const profile = await liff.getProfile();
    if (profile && profile.userId) {
      applyLineProfile(profile, true);
      showToast('🟢 LINE: ' + profile.displayName + ' さんとして自動連携しました！');
      return;
    }
    if (false) {

      const avatarHtml = profile.pictureUrl
        ? ("<img src=\"" + (profile.pictureUrl) + "\" class=\"line-avatar-img\" alt=\"avatar\" style=\"width:24px;height:24px;border-radius:50%;object-fit:cover;vertical-align:middle;\">")
        : '👤';

      TEST_USERS[profile.userId] = {
        id: profile.userId,
        name: profile.displayName || 'LINEユーザー',
        avatar: avatarHtml
      };

      state.groupSettings.myName = profile.displayName || state.groupSettings.myName;

      // 所属グループに自動反映
      state.groups.forEach(g => {
        const member = g.members.find(m => m.userId === profile.userId);
        if (!member) {
          g.members.push({
            userId: profile.userId,
            name: profile.displayName,
            role: g.ownerId === profile.userId ? 'owner' : 'member',
            status: 'approved',
            joinedAt: new Date().toISOString()
          });
        }
      });
      saveGroupsLocal();

      safeStorage.setItem('kakeibo_current_user', profile.userId);
      safeStorage.setItem('kakeibo_line_profile', JSON.stringify(profile));

      updateUserSwitcherUI();
      updateGroupDropdownUI();
      renderApp();

      showToast(("🟢 LINE: " + (profile.displayName) + " さんとして認証完了！"));
      updateLineAuthUI();
    }
  } catch (err) {
    console.warn('LIFF 初期化エラー:', err);
  }
}

// ================= 初期化処理 (即時実行 & DOMContentLoaded両対応・例外ガード) =================
let isAppInitialized = false;
function initApp() {
  if (isAppInitialized) return;
  isAppInitialized = true;

  try {
    initClock();
  } catch (e) {
    console.warn('Clock init error:', e);
  }

  try {
    loadData();
  } catch (e) {
    console.warn('LoadData error:', e);
  }

  try {
    setupEventListeners();
  } catch (e) {
    console.error('SetupEventListeners error:', e);
  }

  try {
    renderApp();
  } catch (e) {
    console.error('RenderApp error:', e);
  }

  // LIFF LINE認証の初期化
  try {
    initLiffAuth();
  } catch (e) {
    console.warn('LIFF Auth error:', e);
  }

  // GAS URLがあれば起動時にバックグラウンド同期
  if (state.gasApiUrl) {
    try {
      syncWithGas(false);
    } catch (e) {}
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  // すでにDOMが読み込み完了している場合は即時実行！
  initApp();
}
window.addEventListener('load', initApp);

// 時計の初期化
function initClock() {
  const clockEl = document.getElementById('currentTime');
  function updateTime() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    if (clockEl) clockEl.textContent = ((h) + ":" + (m));
  }
  updateTime();
  if (typeof setInterval !== "undefined") setInterval(updateTime, 30000);
}

// データ読み込み（LocalStorage または デモシードデータ）
function loadData() {
  const savedTx = safeStorage.getItem('kakeibo_transactions');
  const savedShop = safeStorage.getItem('kakeibo_shopping');
  
  if (savedTx) {
    try {
      state.transactions = JSON.parse(savedTx);
    } catch (e) {
      state.transactions = getDefaultTransactions();
    }
  } else {
    state.transactions = getDefaultTransactions();
    saveTransactionsLocal();
  }

  if (savedShop) {
    try {
      state.shoppingList = JSON.parse(savedShop);
    } catch (e) {
      state.shoppingList = [];
    }
  } else {
    state.shoppingList = [];
  }

  // カテゴリルールと固定費のロード
  loadCategoryRules();
  loadFixedCosts();
  initTestUserBarVisibility();
  
  // 保存済みLINEプロフィールの復元
  const savedLineProf = safeStorage.getItem('kakeibo_line_profile');
  if (savedLineProf) {
    try {
      const parsedProf = JSON.parse(savedLineProf);
      if (parsedProf && parsedProf.userId) {
        applyLineProfile(parsedProf, false);
      }
    } catch (e) {}
  }

  // GAS Web App 配信環境における自動認識 (google.script.run 直通ブリッジ対応)
  if (typeof google !== 'undefined' && google.script && google.script.run && !state.gasApiUrl) {
    state.gasApiUrl = '__GAS_BRIDGE__';
  } else if (typeof GAS_DEPLOY_URL !== 'undefined' && GAS_DEPLOY_URL && GAS_DEPLOY_URL.startsWith('https://script.google.com')) {
    state.gasApiUrl = GAS_DEPLOY_URL;
    safeStorage.setItem('kakeibo_gas_url', GAS_DEPLOY_URL);
  }

  updateSyncIndicator();
  updateGroupConfigInputs();
  updateUserSwitcherUI();
  updateGroupDropdownUI();
}

function getDefaultTransactions() {
  return [
    {
      id: 'tx_demo_personal_1',
      date: '2026-10-24',
      type: 'expense',
      category: '食費',
      memo: 'カフェ・コーヒー',
      amount: 450,
      scope: 'personal',
      userId: 'user_a',
      userName: '自分',
      createdAt: '2026-10-24T15:00:00.000Z'
    },
    {
      id: 'tx_demo_group_lunch',
      date: '2026-10-24',
      type: 'expense',
      category: '外食',
      memo: '週末ランチ',
      amount: 1800,
      scope: 'group',
      groupId: 'grp_default',
      userId: 'user_a',
      userName: '自分',
      paidBy: 'me',
      createdAt: '2026-10-24T12:30:00.000Z'
    }
  ];
}

function saveTransactionsLocal() {
  safeStorage.setItem('kakeibo_transactions', JSON.stringify(state.transactions));
}

function saveShoppingLocal() {
  safeStorage.setItem('kakeibo_shopping', JSON.stringify(state.shoppingList));
}

// 安全なイベントリスナー登録ヘルパー
function safeListen(id, event, callback) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener(event, callback);
  }
}

// ================= イベントリスナー設定 =================
function setupEventListeners() {
  // テストユーザー切り替えボタン
  safeListen('btnToggleTestUser', 'click', handleToggleTestUser);

  // 個人 / グループ 切替
  safeListen('scopePersonalBtn', 'click', () => switchScope('personal'));
  safeListen('scopeGroupBtn', 'click', () => switchScope('group'));

  // グループ選択ドロップダウン
  safeListen('activeGroupSelect', 'change', (e) => {
    switchActiveGroup(e.target.value);
  });

  // グループ操作ボタン
  safeListen('btnOpenCreateGroup', 'click', openCreateGroupModal);
  safeListen('btnOpenJoinGroup', 'click', openJoinGroupModal);
  safeListen('btnOpenGroupManage', 'click', openGroupManageModal);
  safeListen('btnOpenPendingApprovals', 'click', openGroupManageModal);

  // グループモーダル閉じる・キャンセル
  safeListen('closeCreateGroupModalBtn', 'click', closeCreateGroupModal);
  safeListen('cancelCreateGroupBtn', 'click', closeCreateGroupModal);
  safeListen('closeJoinGroupModalBtn', 'click', closeJoinGroupModal);
  safeListen('cancelJoinGroupBtn', 'click', closeJoinGroupModal);
  safeListen('closeGroupManageModalBtn', 'click', closeGroupManageModal);
  safeListen('btnGeneratePasscode', 'click', handleGenerateNewPasscode);
  safeListen('btnConfirmCreateGroup', 'click', handleConfirmCreateGroup);
  safeListen('btnConfirmJoinGroup', 'click', handleConfirmJoinGroup);
  safeListen('btnCopyGroupPasscode', 'click', handleCopyGroupPasscode);
  safeListen('btnLeaveGroup', 'click', handleLeaveCurrentGroup);

  // メインタブ切替 (明細 / 分析)
  safeListen('tabDetailsBtn', 'click', () => switchTab('details'));
  safeListen('tabAnalysisBtn', 'click', () => switchTab('analysis'));

  // 明細サブビュー切替 (リスト / カレンダー)
  safeListen('toggleListBtn', 'click', () => switchSubView('list'));
  safeListen('toggleCalendarBtn', 'click', () => switchSubView('calendar'));

  // 年月ナビゲーション
  safeListen('prevMonthBtn', 'click', () => changeMonth(-1));
  safeListen('nextMonthBtn', 'click', () => changeMonth(1));
  safeListen('monthPickerBtn', 'click', promptMonthChange);

  // 精算結果コピーボタン
  safeListen('copySettlementBtn', 'click', handleCopySettlementText);

  // 予算設定リンク (詳細予算モーダルを開く)
  safeListen('budgetSettingLink', 'click', () => {
    openBudgetModal();
  });

  // FAB: 買い物メモ
  safeListen('openShoppingFab', 'click', () => {
    openSlideScreen('shoppingScreen');
    renderShoppingList();
  });
  safeListen('closeShoppingBtn', 'click', () => closeSlideScreen('shoppingScreen'));

  // FAB: 明細追加
  safeListen('openAddModalFab', 'click', openAddModal);
  safeListen('cancelAddModalBtn', 'click', closeAddModal);
  const addOverlay = document.getElementById('addModalOverlay');
  if (addOverlay) {
    addOverlay.addEventListener('click', (e) => {
      if (e.target === addOverlay) closeAddModal();
    });
  }

  // 明細追加フォーム & 支出/収入切替 (確実なイベント登録)
  safeListen('transactionForm', 'submit', handleAddTransaction);
  safeListen('typeExpenseBtn', 'click', (e) => {
    e.preventDefault();
    switchAddModalType('expense');
  });
  safeListen('typeIncomeBtn', 'click', (e) => {
    e.preventDefault();
    switchAddModalType('income');
  });

  // 写真添付 (明細追加)
  safeListen('btnAttachPhoto', 'click', () => {
    const fileInput = document.getElementById('inputPhotoFile');
    if (fileInput) fileInput.click();
  });
  safeListen('inputPhotoFile', 'change', (e) => handlePhotoFileSelect(e, 'add'));
  safeListen('btnRemovePhoto', 'click', () => handleRemovePhoto('add'));

  // モーダル内のスコープ選択
  safeListen('modalScopePersonal', 'click', () => setModalScope('personal'));
  safeListen('modalScopeGroup', 'click', () => setModalScope('group'));

  // モーダル内の支払者選択
  safeListen('modalPaidByMe', 'click', () => setModalPaidBy('me'));
  safeListen('modalPaidByPartner', 'click', () => setModalPaidBy('partner'));

  // 明細追加モーダル内の「📷 レシートを撮影してGeminiで自動入力」バナー
  safeListen('btnOpenReceiptFromModal', 'click', () => {
    closeAddModal();
    openReceiptModal();
  });

  // 明細編集モーダル関連
  safeListen('closeEditModalBtn', 'click', closeEditModal);
  safeListen('editTypeExpenseBtn', 'click', (e) => {
    e.preventDefault();
    switchEditModalType('expense');
  });
  safeListen('editTypeIncomeBtn', 'click', (e) => {
    e.preventDefault();
    switchEditModalType('income');
  });
  safeListen('editScopePersonal', 'click', () => setEditModalScope('personal'));
  safeListen('editScopeGroup', 'click', () => setEditModalScope('group'));
  safeListen('btnEditAttachPhoto', 'click', () => {
    const fileInput = document.getElementById('editInputPhotoFile');
    if (fileInput) fileInput.click();
  });
  safeListen('editInputPhotoFile', 'change', (e) => handlePhotoFileSelect(e, 'edit'));
  safeListen('btnEditRemovePhoto', 'click', () => handleRemovePhoto('edit'));
  safeListen('editTransactionForm', 'submit', handleSaveEditedTx);
  safeListen('btnDeleteTransaction', 'click', handleDeleteTransaction);
  const editOverlay = document.getElementById('editModalOverlay');
  if (editOverlay) {
    editOverlay.addEventListener('click', (e) => {
      if (e.target === editOverlay) closeEditModal();
    });
  }

  // 写真拡大ライトボックス
  safeListen('closeLightboxBtn', 'click', closePhotoLightbox);
  const lightboxOverlay = document.getElementById('photoLightboxOverlay');
  if (lightboxOverlay) {
    lightboxOverlay.addEventListener('click', (e) => {
      if (e.target === lightboxOverlay) closePhotoLightbox();
    });
  }

  // 買い物メモ追加
  safeListen('addShoppingBtn', 'click', handleAddShoppingItem);
  const shoppingInput = document.getElementById('shoppingInput');
  if (shoppingInput) {
    shoppingInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAddShoppingItem();
    });
  }
  safeListen('clearCompletedShoppingBtn', 'click', clearCompletedShopping);

  // 設定画面 (エラー原因を完全解消し安全に開閉)
  safeListen('openSettingsBtn', 'click', () => {
    updateGroupConfigInputs();
    updateGeminiKeyStatusUI();
    openSlideScreen('settingsScreen');
  });
  safeListen('closeSettingsBtn', 'click', () => closeSlideScreen('settingsScreen'));
  safeListen('saveGroupConfigBtn', 'click', handleSaveGroupConfig);

  // 詳細予算設定モーダル
  safeListen('openBudgetModalBtn', 'click', openBudgetModal);
  safeListen('closeBudgetModalBtn', 'click', closeBudgetModal);
  safeListen('cancelBudgetModalBtn', 'click', closeBudgetModal);
  const budgetOverlay = document.getElementById('budgetModalOverlay');
  if (budgetOverlay) {
    budgetOverlay.addEventListener('click', (e) => {
      if (e.target === budgetOverlay) closeBudgetModal();
    });
  }
  safeListen('budgetScopePersonalBtn', 'click', () => switchBudgetModalScope('personal'));
  safeListen('budgetScopeGroupBtn', 'click', () => switchBudgetModalScope('group'));
  safeListen('btnAutoCalcYearlyBudget', 'click', handleAutoCalcYearlyBudget);
  safeListen('toggleCategoryBudgetsBtn', 'click', handleToggleCategoryBudgets);
  safeListen('saveDetailedBudgetBtn', 'click', handleSaveDetailedBudget);

  // Gemini API 設定
  safeListen('saveGeminiApiKeyBtn', 'click', handleSaveGeminiApiKey);

  // レシートAIモーダル (FAB, アップロード, 解析, 登録)
  safeListen('openReceiptFab', 'click', openReceiptModal);
  safeListen('closeReceiptModalBtn', 'click', closeReceiptModal);
  const receiptOverlay = document.getElementById('receiptModalOverlay');
  if (receiptOverlay) {
    receiptOverlay.addEventListener('click', (e) => {
      if (e.target === receiptOverlay) closeReceiptModal();
    });
  }
  safeListen('receiptDropZone', 'click', () => {
    const fileInput = document.getElementById('receiptFileInput');
    if (fileInput) fileInput.click();
  });
  safeListen('btnChangeImage', 'click', (e) => {
    e.stopPropagation();
    const fileInput = document.getElementById('receiptFileInput');
    if (fileInput) fileInput.click();
  });
  safeListen('receiptFileInput', 'change', handleReceiptFileChange);
  safeListen('btnAnalyzeReceipt', 'click', handleAnalyzeReceiptClick);
  safeListen('btnDemoReceipt', 'click', handleDemoReceiptClick);

  // レシート結果内のスコープ・支払者切替
  safeListen('receiptScopePersonal', 'click', () => setReceiptScope('personal'));
  safeListen('receiptScopeGroup', 'click', () => setReceiptScope('group'));
  safeListen('receiptPaidByMe', 'click', () => setReceiptPaidBy('me'));
  safeListen('receiptPaidByPartner', 'click', () => setReceiptPaidBy('partner'));

  // レシート家計簿登録ボタン
  safeListen('btnRegisterReceipt', 'click', handleRegisterReceipt);

  // GAS設定モーダル
  safeListen('openGasModalBtn', 'click', openGasModal);
  safeListen('closeGasModalBtn', 'click', closeGasModal);
  safeListen('btnGasStatus', 'click', openGasModal);
  safeListen('testGasConnectionBtn', 'click', handleTestGasConnection);
  safeListen('clearGasUrlBtn', 'click', handleClearGasUrl);

  // CSVエクスポート
  safeListen('btnExportCsv', 'click', exportToCsv);

  // 要望送信
  safeListen('sendFeedbackBtn', 'click', handleSendFeedback);

  // テストユーザーバー表示切り替えボタン (ヘッダーの🧪ボタン)
  safeListen('btnToggleTestBar', 'click', toggleTestUserBar);

  // 検索＆フィルター
  safeListen('searchTxInput', 'input', (e) => handleSearchFilterChange(e.target.value));
  safeListen('btnClearSearch', 'click', clearSearchFilter);

  // メモ入力時の自動仕訳ルール連動
  safeListen('inputMemo', 'input', (e) => handleMemoInputAutoRule(e.target.value, 'add'));
  safeListen('editInputMemo', 'input', (e) => handleMemoInputAutoRule(e.target.value, 'edit'));

  // メニュー・閉じるボタン
  safeListen('btnCloseApp', 'click', () => {
    showToast('アプリをホーム画面に追加すると便利に使えます！');
  });
  safeListen('btnMoreMenu', 'click', () => {
    openSlideScreen('settingsScreen');
  });

  // 設定画面内の各機能スクリーン起動
  safeListen('btnHistory', 'click', openHistoryScreen);
  safeListen('btnFixedCosts', 'click', openFixedCostsScreen);
  safeListen('btnEditCategories', 'click', openEditCategoriesScreen);
  safeListen('btnCategoryRules', 'click', openCategoryRulesScreen);
  safeListen('btnSmartInput', 'click', openSmartInputScreen);

  // 各機能スクリーンのイベントリスナー (HTML側のIDとJS側のID両方に対応)
  safeListen('closeSmartInputBtn', 'click', closeSmartInputScreen);
  safeListen('btnCloseSmartInput', 'click', closeSmartInputScreen);
  safeListen('smartScopePersonalBtn', 'click', () => setSmartImportScope('personal'));
  safeListen('smartScopeGroupBtn', 'click', () => setSmartImportScope('group'));
  safeListen('smartImportFileInput', 'change', handleSmartImportFileSelect);
  safeListen('btnDemoSmartImport', 'click', handleLoadDemoSmartImport);
  safeListen('btnToggleAllImport', 'click', toggleAllSmartImportChecks);
  safeListen('btnExecuteImport', 'click', handleExecuteSmartImport);
  safeListen('btnConfirmSmartImport', 'click', handleExecuteSmartImport);

  safeListen('closeCategoryRulesBtn', 'click', closeCategoryRulesScreen);
  safeListen('btnCloseCategoryRules', 'click', closeCategoryRulesScreen);
  safeListen('btnAddCategoryRule', 'click', handleAddCategoryRule);
  safeListen('btnSaveCategoryRules', 'click', handleSaveCategoryRules);

  safeListen('closeEditCategoriesBtn', 'click', closeEditCategoriesScreen);
  safeListen('btnCloseEditCategories', 'click', closeEditCategoriesScreen);
  safeListen('editCatTypeExpenseBtn', 'click', () => switchEditCategoryType('expense'));
  safeListen('btnEditCatTypeExpense', 'click', () => switchEditCategoryType('expense'));
  safeListen('editCatTypeIncomeBtn', 'click', () => switchEditCategoryType('income'));
  safeListen('btnEditCatTypeIncome', 'click', () => switchEditCategoryType('income'));
  safeListen('btnAddCustomCat', 'click', handleAddCustomCategory);
  safeListen('btnAddCustomCategory', 'click', handleAddCustomCategory);
  safeListen('btnResetCustomCats', 'click', handleResetCustomCategories);
  safeListen('btnResetCustomCategories', 'click', handleResetCustomCategories);
  safeListen('btnSaveCustomCats', 'click', handleSaveCustomCategories);
  safeListen('btnSaveCustomCategories', 'click', handleSaveCustomCategories);

  // カテゴリ追加入力でのEnterキー押下ハンドラー
  const newCatInput = document.getElementById('inputNewCatName') || document.getElementById('inputNewCategoryName');
  if (newCatInput) {
    newCatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAddCustomCategory();
      }
    });
  }

  safeListen('closeFixedCostsBtn', 'click', closeFixedCostsScreen);
  safeListen('btnCloseFixedCosts', 'click', closeFixedCostsScreen);
  safeListen('fixedCostTypeExpense', 'click', () => switchFixedCostType('expense'));
  safeListen('btnFixedCostExpense', 'click', () => switchFixedCostType('expense'));
  safeListen('fixedCostTypeIncome', 'click', () => switchFixedCostType('income'));
  safeListen('btnFixedCostIncome', 'click', () => switchFixedCostType('income'));
  safeListen('btnSubmitFixedCost', 'click', handleAddFixedCost);
  safeListen('btnAddFixedCost', 'click', handleAddFixedCost);

  safeListen('closeHistoryBtn', 'click', closeHistoryScreen);
  safeListen('btnCloseHistory', 'click', closeHistoryScreen);

  safeListen('openPlanModalBtn', 'click', () => {
    showToast('✨ すべての機能が無料で解放されています！');
  });
  safeListen('btnTerms', 'click', () => {
    showToast('利用規約: 個人およびグループで安心してご利用いただけます');
  });
  safeListen('btnPrivacy', 'click', () => {
    showToast('プライバシーポリシー: 個人データは端末およびご自身のGASにのみ保存されます');
  });
}

// ================= タブ・画面切り替え =================
function switchTab(tab) {
  state.activeTab = tab;
  const isDetails = tab === 'details';

  document.getElementById('tabDetailsBtn').classList.toggle('active', isDetails);
  document.getElementById('tabAnalysisBtn').classList.toggle('active', !isDetails);

  document.getElementById('viewDetails').style.display = isDetails ? 'block' : 'none';
  document.getElementById('viewAnalysis').style.display = !isDetails ? 'block' : 'none';

  if (!isDetails) {
    renderAnalysisView();
  }
}

function switchSubView(subView) {
  state.detailsSubView = subView;
  const isList = subView === 'list';

  document.getElementById('toggleListBtn').classList.toggle('active', isList);
  document.getElementById('toggleCalendarBtn').classList.toggle('active', !isList);

  document.getElementById('modeListView').style.display = isList ? 'block' : 'none';
  document.getElementById('modeCalendarView').style.display = !isList ? 'block' : 'none';

  if (!isList) {
    renderCalendar();
  }
}

function openSlideScreen(screenId) {
  const el = document.getElementById(screenId);
  if (el) {
    el.classList.add('open');
    el.style.visibility = 'visible';
    el.style.pointerEvents = 'auto';
  }
}

function closeSlideScreen(screenId) {
  const el = document.getElementById(screenId);
  if (el) {
    el.classList.remove('open');
    setTimeout(() => {
      if (!el.classList.contains('open')) {
        el.style.visibility = 'hidden';
        el.style.pointerEvents = 'none';
      }
    }, 280);
  }
}

// 設定画面の開閉
function openSettingsScreen() {
  try {
    updateGroupConfigInputs();
    updateGeminiKeyStatusUI();
  } catch (e) {
    console.warn('Settings UI update warning:', e);
  }
  openSlideScreen('settingsScreen');
}

function closeSettingsScreen() {
  closeSlideScreen('settingsScreen');
}

// 買い物メモ画面の開閉
function openShoppingScreen() {
  openSlideScreen('shoppingScreen');
  try {
    renderShoppingList();
  } catch (e) {
    console.warn('Shopping list render warning:', e);
  }
}

function closeShoppingScreen() {
  closeSlideScreen('shoppingScreen');
}

// 年月ナビゲーション処理
function changeMonth(delta) {
  state.currentMonth += delta;
  if (state.currentMonth > 12) {
    state.currentMonth = 1;
    state.currentYear += 1;
  } else if (state.currentMonth < 1) {
    state.currentMonth = 12;
    state.currentYear -= 1;
  }
  renderApp();
}

function promptMonthChange() {
  const currentStr = ((state.currentYear) + "-" + (String(state.currentMonth).padStart(2, '0')));
  const input = prompt('移動したい年月を「YYYY-MM」形式で入力してください (例: 2026-10):', currentStr);
  if (!input) return;
  const match = input.match(/^(\d{4})-(\d{1,2})$/);
  if (match) {
    state.currentYear = parseInt(match[1], 10);
    state.currentMonth = parseInt(match[2], 10);
    renderApp();
  } else {
    alert('入力形式が正しくありません (例: 2026-10)');
  }
}

// ================= ユーザー表示更新 =================
function handleToggleTestUser() {
  openLineAuthModal();
}

function updateUserSwitcherUI() {
  updateLineAuthUI();
}

// グループ選択ドロップダウンの更新
function updateGroupDropdownUI() {
  const select = document.getElementById('activeGroupSelect');
  const targetGroupSelect = document.getElementById('modalTargetGroupSelect');
  const editTargetGroupSelect = document.getElementById('editTargetGroupSelect');
  if (!select) return;

  // 全グループ一覧（所属中・未所属含む）
  select.innerHTML = state.groups.map(g => {
    const isOwner = g.ownerId === state.currentUserId;
    const member = g.members.find(m => m.userId === state.currentUserId);
    let statusText = '';
    if (isOwner) statusText = ' 👑(作成者)';
    else if (member && member.status === 'pending') statusText = ' ⏳(承認待ち)';
    else if (member) statusText = ' (参加中)';
    else statusText = ' (未参加)';

    return ("<option value=\"" + (g.id) + "\" " + (g.id === state.currentGroupId ? 'selected' : '') + ">" + (escapeHtml(g.name)) + (statusText) + "</option>");
  }).join('');

  const approvedGroups = state.groups.filter(g => {
    const m = g.members.find(mem => mem.userId === state.currentUserId);
    return m && m.status === 'approved';
  });

  const groupOptionsHtml = approvedGroups.map(g => 
    ("<option value=\"" + (g.id) + "\">" + (escapeHtml(g.name)) + "</option>")
  ).join('');

  if (targetGroupSelect) targetGroupSelect.innerHTML = groupOptionsHtml || '<option value="">グループなし</option>';
  if (editTargetGroupSelect) editTargetGroupSelect.innerHTML = groupOptionsHtml || '<option value="">グループなし</option>';
}

function switchActiveGroup(groupId) {
  state.currentGroupId = groupId;
  safeStorage.setItem('kakeibo_current_group_id', groupId);
  renderApp();
}

// ================= 個人 / グループ 切替 =================
function switchScope(scope) {
  state.activeScope = scope;
  const isPersonal = scope === 'personal';

  document.getElementById('scopePersonalBtn').classList.toggle('active', isPersonal);
  document.getElementById('scopeGroupBtn').classList.toggle('active', !isPersonal);

  const groupSelectRow = document.getElementById('groupSelectRow');
  if (groupSelectRow) {
    groupSelectRow.style.display = isPersonal ? 'none' : 'flex';
  }

  const currentGroup = state.groups.find(g => g.id === state.currentGroupId) || state.groups[0];
  const heroLabel = document.getElementById('heroSummaryLabel');
  if (heroLabel) {
    heroLabel.textContent = isPersonal
      ? ("支出合計 (" + ((TEST_USERS[state.currentUserId] || {}).name || '個人') + ")")
      : ((currentGroup ? currentGroup.name : 'グループ') + " 支出合計");
  }

  const settlementCard = document.getElementById('groupSettlementCard');
  if (settlementCard) {
    settlementCard.style.display = isPersonal ? 'none' : 'block';
  }

  renderApp();
}

// スコープ対応トランザクション取得（個人／グループ、承認ステータスを厳密に判定）
function getScopedTransactions(forMonth = true) {
  const currentGroup = state.groups.find(g => g.id === state.currentGroupId);
  const myMembership = currentGroup ? currentGroup.members.find(m => m.userId === state.currentUserId) : null;
  const isApprovedMember = myMembership && myMembership.status === 'approved';

  let list = state.transactions;

  if (state.activeScope === 'personal') {
    // 個人モード: ログイン中ユーザー本人の個人明細のみ！他人の個人明細は絶対に返さない
    list = list.filter(t => t.scope === 'personal' && (t.userId === state.currentUserId || (!t.userId && state.currentUserId === 'user_a')));
  } else {
    // グループモード:
    // 承認されていない（pendingまたは未所属）場合は空配列（0件）！閲覧権限なし
    if (!currentGroup || !isApprovedMember) {
      return [];
    }
    // 承認済みメンバーのみ、そのグループに紐づく明細を表示
    list = list.filter(t => t.scope === 'group' && (t.groupId === currentGroup.id || (!t.groupId && currentGroup.id === 'grp_default')));
  }

  if (forMonth) {
    const monthPrefix = ((state.currentYear) + "-" + (String(state.currentMonth).padStart(2, '0')));
    list = list.filter(t => t.date && t.date.startsWith(monthPrefix));
  }

  return list;
}

// ================= メイン描画処理 =================
function renderApp() {
  // 年月ラベル更新
  const labelEl = document.getElementById('currentMonthLabel');
  if (labelEl) {
    labelEl.textContent = ((state.currentYear) + "年" + (state.currentMonth) + "月");
  }

  updateUserSwitcherUI();
  updateGroupDropdownUI();

  // 現在のグループとステータスを判定
  const currentGroup = state.groups.find(g => g.id === state.currentGroupId) || state.groups[0];
  const myMembership = currentGroup ? currentGroup.members.find(m => m.userId === state.currentUserId) : null;
  const isPending = currentGroup && myMembership && myMembership.status === 'pending';

  // 承認待ちバナーの制御
  const pendingBanner = document.getElementById('pendingGroupBanner');
  const pendingNameEl = document.getElementById('pendingBannerGroupName');
  if (pendingBanner) {
    if (state.activeScope === 'group' && isPending) {
      pendingBanner.style.display = 'block';
      if (pendingNameEl) pendingNameEl.textContent = ("【" + (currentGroup.name) + "】");
    } else {
      pendingBanner.style.display = 'none';
    }
  }

  // オーナー向け「参加申請が届いています」要請バナーの制御
  const ownerNoticeBanner = document.getElementById('ownerApprovalNoticeBanner');
  if (ownerNoticeBanner) {
    const hasPendingInAnyGroup = state.groups.some(g => {
      const isMember = g.members.some(m => m.userId === state.currentUserId && m.status === 'approved');
      const hasPending = g.members.some(m => m.status === 'pending');
      return isMember && hasPending;
    });
    ownerNoticeBanner.style.display = hasPendingInAnyGroup ? 'flex' : 'none';
  }

  // 固定費の自動記録チェック（指定日が到来している当月分を自動生成）
  if (typeof processAutoFixedCosts === 'function') {
    processAutoFixedCosts();
  }

  // スコープに応じた明細を取得 (厳密に個人/グループを分離)
  const displayTx = getScopedTransactions(true);

  // 合計支出の計算
  const totalExpense = displayTx
    .filter(t => t.type === 'expense')
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  // Hero Card 表示更新
  const heroAmountEl = document.getElementById('totalExpenseHero');
  if (heroAmountEl) heroAmountEl.textContent = totalExpense.toLocaleString('ja-JP');

  const heroLabel = document.getElementById('heroSummaryLabel');
  if (heroLabel) {
    const isPersonal = state.activeScope === 'personal';
    heroLabel.textContent = isPersonal
      ? ("支出合計 (" + ((TEST_USERS[state.currentUserId] || {}).name || '個人') + ")")
      : ((currentGroup ? currentGroup.name : 'グループ') + " 支出合計");
  }

  // グループモード時はグループ精算サマリーを計算・表示
  if (state.activeScope === 'group') {
    renderSettlementCard(displayTx, currentGroup);
  }

  // 予算プログレスの更新
  renderBudgetProgress(totalExpense);

  // カテゴリ絞り込みピルの描画と検索・カテゴリフィルタ適用
  if (typeof renderCategoryFilterPills === 'function') {
    renderCategoryFilterPills(displayTx);
  }
  const filteredTx = typeof getFilteredTransactions === 'function'
    ? getFilteredTransactions(displayTx)
    : displayTx;

  // 件数バッジ更新
  const badgeEl = document.getElementById('itemsCountBadge');
  if (badgeEl) {
    badgeEl.textContent = filteredTx.length !== displayTx.length
      ? ((filteredTx.length) + "件 (全" + (displayTx.length) + "件)")
      : ((displayTx.length) + "件");
  }

  // リスト描画
  renderTransactionsList(filteredTx);

  // カレンダーモードがアクティブならカレンダーも更新
  if (state.detailsSubView === 'calendar') {
    renderCalendar(displayTx);
  }

  // 分析タブがアクティブなら分析も更新
  if (state.activeTab === 'analysis') {
    renderAnalysisView(displayTx);
  }
}

// ================= グループ精算サマリー描画 =================
function renderSettlementCard(groupTransactions, currentGroup) {
  const card = document.getElementById('groupSettlementCard');
  if (!card) return;

  const expenses = groupTransactions.filter(t => t.type === 'expense');
  const myName = (state.lineProfile && state.lineProfile.displayName) || state.groupSettings.myName || (TEST_USERS[state.currentUserId] || {}).name || '自分';
  const partnerName = state.groupSettings.partnerName || 'パートナー';
  const splitRatio = parseFloat(state.groupSettings.splitRatio) || 0.5;

  const labelMyName = document.getElementById('labelMyName');
  const labelPartnerName = document.getElementById('labelPartnerName');
  if (labelMyName) labelMyName.textContent = myName;
  if (labelPartnerName) labelPartnerName.textContent = partnerName;

  const myPaid = expenses
    .filter(t => t.userId === state.currentUserId)
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  const partnerPaid = expenses
    .filter(t => t.userId !== state.currentUserId)
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  const statMy = document.getElementById('statMyPaid');
  const statPartner = document.getElementById('statPartnerPaid');
  if (statMy) statMy.textContent = ("¥" + (myPaid.toLocaleString('ja-JP')));
  if (statPartner) statPartner.textContent = ("¥" + (partnerPaid.toLocaleString('ja-JP')));

  const totalPaid = myPaid + partnerPaid;
  const myExpectedShare = Math.round(totalPaid * splitRatio);
  const diff = myPaid - myExpectedShare;

  const resultTextEl = document.getElementById('settlementResultText');
  if (resultTextEl) {
    if (totalPaid === 0) {
      resultTextEl.textContent = '現在、グループ支出はありません';
    } else if (diff > 0) {
      resultTextEl.textContent = ((partnerName) + " → " + (myName) + "へ ¥" + (Math.round(diff).toLocaleString('ja-JP')));
    } else if (diff < 0) {
      resultTextEl.textContent = ((myName) + " → " + (partnerName) + "へ ¥" + (Math.round(Math.abs(diff)).toLocaleString('ja-JP')));
    } else {
      resultTextEl.textContent = 'きれいに折半済みです (精算なし)';
    }
  }
}

// ================= 明細リスト描画 (写真サムネイル・編集クリック対応) =================
function renderTransactionsList(transactions) {
  const container = document.getElementById('transactionsList');
  if (!container) return;

  const currentGroup = state.groups.find(g => g.id === state.currentGroupId);
  const myMembership = currentGroup ? currentGroup.members.find(m => m.userId === state.currentUserId) : null;
  const isPending = currentGroup && myMembership && myMembership.status === 'pending';

  if (state.activeScope === 'group' && isPending) {
    container.innerHTML = ("\n" +
"      <div class=\"card empty-card\">\n" +
"        <p style=\"font-size: 16px; font-weight: 700; color: #92400e;\">⏳ グループ参加 承認待ちです</p>\n" +
"        <p style=\"font-size: 12.5px; color: var(--text-secondary); margin-top: 8px; line-height: 1.5;\">\n" +
"          グループ作成者（または参加メンバー）があなたを承認すると、このグループの家計簿明細・分析・精算が閲覧できるようになります。\n" +
"        </p>\n" +
"      </div>\n" +
"    ");
    return;
  }

  if (transactions.length === 0) {
    const isPersonal = state.activeScope === 'personal';
    container.innerHTML = ("\n" +
"      <div class=\"card empty-card\">\n" +
"        <p>" + (isPersonal ? '個人用の明細はありません。' : 'このグループで共有された明細はありません。') + "</p>\n" +
"        <p style=\"font-size: 12px; color: var(--text-muted); margin-top: 6px;\">\n" +
"          " + (isPersonal ? '右下の「＋」ボタンから追加してください。' : '「個人」タブの明細で「👥 グループへ」を押すか、右下の「＋」からグループ宛てに追加してください。') + "\n" +
"        </p>\n" +
"      </div>\n" +
"    ");
    return;
  }

  // 日付順（新しい順）に並び替え
  const sorted = [...transactions].sort((a, b) => new Date(b.date) - new Date(a.date));

  // 日付ごとにグルーピング
  const grouped = {};
  sorted.forEach(t => {
    if (!grouped[t.date]) grouped[t.date] = [];
    grouped[t.date].push(t);
  });

  let html = '';
  for (const [dateStr, items] of Object.entries(grouped)) {
    const d = new Date(dateStr);
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const weekday = WEEKDAYS[d.getDay()];

    const dayExpense = items
      .filter(i => i.type === 'expense')
      .reduce((sum, i) => sum + (Number(i.amount) || 0), 0);

    html += ("\n" +
"      <div class=\"date-group\">\n" +
"        <div class=\"date-group-header\">\n" +
"          <span class=\"date-group-day\">" + (m) + "/" + (day) + "(" + (weekday) + ")</span>\n" +
"          <span class=\"date-group-sum\">支出 ¥" + (dayExpense.toLocaleString('ja-JP')) + "</span>\n" +
"        </div>\n" +
"        " + (items.map(item => {
          const isIncome = item.type === 'income';
          const isGroup = item.scope === 'group';
          const isMyItem = item.userId === state.currentUserId || (!item.userId && state.currentUserId === 'user_a');
          const catObj = [...CATEGORIES.expense, ...CATEGORIES.income].find(c => c.name === item.category);
          const icon = catObj ? catObj.icon : (isIncome ? '💰' : '📦');

          // 写真サムネイル (添付されている場合)
          const photoThumbHtml = item.photo 
            ? ("<img src=\"" + (item.photo) + "\" alt=\"添付写真\" class=\"item-photo-thumb\" onclick=\"event.stopPropagation(); openPhotoLightbox('" + (item.photo) + "')\" title=\"写真を拡大表示\">")
            : '';

          // 登録者/支払者バッジテキスト
          const payerName = item.userName || (isMyItem ? '自分' : 'メンバー');
          const payerBadge = isGroup 
            ? ("<span class=\"item-payer-badge " + (isMyItem ? 'me' : 'partner') + "\">" + (escapeHtml(payerName)) + "</span>") 
            : '';

          // ワン操作で個人 ⇄ グループを切り替えるボタン
          let toggleScopeBtnHtml = '';
          if (state.activeScope === 'personal') {
            toggleScopeBtnHtml = isGroup
              ? ("<button class=\"btn-scope-toggle is-group\" onclick=\"event.stopPropagation(); toggleItemScope('" + (item.id) + "')\" title=\"個人専用に戻す\">👥 共有中 (戻す)</button>")
              : ("<button class=\"btn-scope-toggle is-personal\" onclick=\"event.stopPropagation(); toggleItemScope('" + (item.id) + "')\" title=\"グループに共有する\">👥 グループへ</button>");
          } else {
            // グループモード時: 自分が登録したものであれば個人へ戻せる
            toggleScopeBtnHtml = isMyItem
              ? ("<button class=\"btn-scope-toggle is-group\" onclick=\"event.stopPropagation(); toggleItemScope('" + (item.id) + "')\" title=\"個人用に戻す\">👤 個人に戻す</button>")
              : '';
          }

          return ("\n" +
"            <div class=\"transaction-item card item-clickable\" onclick=\"openEditModal('" + (item.id) + "')\" title=\"タップして編集\">\n" +
"              <div class=\"item-icon-box\">" + (icon) + "</div>\n" +
"              " + (photoThumbHtml) + "\n" +
"              <div class=\"item-info\">\n" +
"                <span class=\"item-title\">" + (escapeHtml(item.memo || item.category)) + "</span>\n" +
"                <div class=\"item-meta-row\">\n" +
"                  <span class=\"item-category-tag\">" + (escapeHtml(item.category)) + "</span>\n" +
"                  " + (payerBadge) + "\n" +
"                </div>\n" +
"              </div>\n" +
"              <div class=\"item-right-col\">\n" +
"                <div class=\"item-amount " + (isIncome ? 'income' : '') + "\">\n" +
"                  " + (isIncome ? '+' : '') + "¥" + (Number(item.amount).toLocaleString('ja-JP')) + "\n" +
"                </div>\n" +
"                " + (toggleScopeBtnHtml) + "\n" +
"              </div>\n" +
"            </div>\n" +
"          ");
        }).join('')) + "\n" +
"      </div>\n" +
"    ");
  }

  container.innerHTML = html;
}

// ================= ワン操作で個人 ⇄ グループを切り替える =================
window.toggleItemScope = async function(id) {
  const item = state.transactions.find(t => t.id === id);
  if (!item) return;

  const nextScope = item.scope === 'group' ? 'personal' : 'group';
  item.scope = nextScope;
  saveTransactionsLocal();
  renderApp();

  if (nextScope === 'group') {
    showToast('👥 グループに共有しました (同棲精算に追加)');
  } else {
    showToast('👤 個人用に戻しました (非公開になりました)');
  }

  if (state.gasApiUrl) {
    try {
      await fetch(state.gasApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'toggleScope', id: id, scope: nextScope })
      });
    } catch (e) {
      console.warn('GASスコープ更新エラー (ローカルは更新済):', e);
    }
  }
};

// 明細クリック時の削除/詳細
window.handleItemClick = function(id) {
  const item = state.transactions.find(t => t.id === id);
  if (!item) return;

  const confirmDelete = confirm(("「" + (item.memo || item.category) + " (¥" + (item.amount.toLocaleString('ja-JP')) + ")」を削除しますか？"));
  if (confirmDelete) {
    deleteTransaction(id);
  }
};

async function deleteTransaction(id) {
  state.transactions = state.transactions.filter(t => t.id !== id);
  saveTransactionsLocal();
  renderApp();
  showToast('明細を削除しました');

  if (state.gasApiUrl) {
    try {
      await fetch(state.gasApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'deleteTransaction', id: id })
      });
    } catch (e) {
      console.warn('GAS削除失敗 (次回同期時に反映):', e);
    }
  }
}

// ================= カレンダー描画 =================
function renderCalendar(scopedTx) {
  const gridCells = document.getElementById('calendarGridCells');
  if (!gridCells) return;

  const year = state.currentYear;
  const month = state.currentMonth; // 1-indexed

  const firstDay = new Date(year, month - 1, 1).getDay(); // 0(日) ~ 6(土)
  const daysInMonth = new Date(year, month, 0).getDate();
  const prevMonthDays = new Date(year, month - 1, 0).getDate();

  // 月内の日毎の支出を集計 (スコープでフィルタ)
  const expenseMap = {};
  const txList = scopedTx || getScopedTransactions();
  txList
    .filter(t => t.type === 'expense')
    .forEach(t => {
      expenseMap[t.date] = (expenseMap[t.date] || 0) + (Number(t.amount) || 0);
    });

  let html = '';

  // 前月のはみ出しセル
  for (let i = firstDay - 1; i >= 0; i--) {
    const dayNum = prevMonthDays - i;
    html += ("<div class=\"cal-cell other-month\"><span class=\"cal-date\">" + (dayNum) + "</span></div>");
  }

  // 当月のセル
  const today = new Date();
  const isThisMonth = today.getFullYear() === year && (today.getMonth() + 1) === month;
  const todayDateNum = today.getDate();

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = ((year) + "-" + (String(month).padStart(2, '0')) + "-" + (String(d).padStart(2, '0')));
    const isToday = isThisMonth && d === todayDateNum;
    const isSelected = state.selectedDate === dateStr;
    const dayExpense = expenseMap[dateStr];

    html += ("\n" +
"      <div class=\"cal-cell " + (isToday ? 'today' : '') + " " + (isSelected ? 'selected' : '') + "\" \n" +
"           onclick=\"selectCalendarDate('" + (dateStr) + "')\">\n" +
"        <span class=\"cal-date\">" + (d) + "</span>\n" +
"        " + (dayExpense ? ("<span class=\"cal-expense\">¥" + (dayExpense.toLocaleString('ja-JP')) + "</span>") : '') + "\n" +
"      </div>\n" +
"    ");
  }

  // 次月のはみ出しセル（7の倍数まで埋める）
  const totalCells = firstDay + daysInMonth;
  const nextMonthCells = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= nextMonthCells; i++) {
    html += ("<div class=\"cal-cell other-month\"><span class=\"cal-date\">" + (i) + "</span></div>");
  }

  gridCells.innerHTML = html;
  renderSelectedDayDetails();
}

window.selectCalendarDate = function(dateStr) {
  state.selectedDate = dateStr;
  renderCalendar();
  renderSelectedDayDetails();
};

function renderSelectedDayDetails() {
  const container = document.getElementById('selectedDayList');
  const title = document.getElementById('selectedDayTitle');
  if (!container || !title) return;

  const d = new Date(state.selectedDate);
  title.textContent = ((d.getMonth() + 1) + "月" + (d.getDate()) + "日(" + (WEEKDAYS[d.getDay()]) + ") の明細");

  const scopedTx = getScopedTransactions();
  const items = scopedTx.filter(t => t.date === state.selectedDate);
  if (items.length === 0) {
    container.innerHTML = ("<p style=\"font-size: 13px; color: var(--text-muted); padding: 8px 4px;\">明細はありません</p>");
    return;
  }

  container.innerHTML = items.map(item => {
    const isIncome = item.type === 'income';
    const isGroup = item.scope === 'group';
    const isMe = item.paidBy === 'me' || !item.paidBy;
    const catObj = [...CATEGORIES.expense, ...CATEGORIES.income].find(c => c.name === item.category);
    const icon = catObj ? catObj.icon : '📦';

    let toggleBtn = '';
    if (state.activeScope === 'personal') {
      toggleBtn = isGroup
        ? ("<button class=\"btn-scope-toggle is-group\" onclick=\"event.stopPropagation(); toggleItemScope('" + (item.id) + "')\">👥 共有中 (戻す)</button>")
        : ("<button class=\"btn-scope-toggle is-personal\" onclick=\"event.stopPropagation(); toggleItemScope('" + (item.id) + "')\">👥 グループへ</button>");
    } else if (isMe) {
      toggleBtn = ("<button class=\"btn-scope-toggle is-group\" onclick=\"event.stopPropagation(); toggleItemScope('" + (item.id) + "')\">👤 個人に戻す</button>");
    }

    return ("\n" +
"      <div class=\"transaction-item card\" onclick=\"handleItemClick('" + (item.id) + "')\">\n" +
"        <div class=\"item-icon-box\">" + (icon) + "</div>\n" +
"        <div class=\"item-info\">\n" +
"          <span class=\"item-title\">" + (escapeHtml(item.memo || item.category)) + "</span>\n" +
"          <div class=\"item-meta-row\">\n" +
"            <span class=\"item-category-tag\">" + (escapeHtml(item.category)) + "</span>\n" +
"            " + (isGroup ? ("<span class=\"item-payer-badge " + (isMe ? 'me' : 'partner') + "\">" + (isMe ? state.groupSettings.myName : state.groupSettings.partnerName) + "</span>") : '') + "\n" +
"          </div>\n" +
"        </div>\n" +
"        <div class=\"item-right-col\">\n" +
"          <div class=\"item-amount " + (isIncome ? 'income' : '') + "\">\n" +
"            " + (isIncome ? '+' : '') + "¥" + (Number(item.amount).toLocaleString('ja-JP')) + "\n" +
"          </div>\n" +
"          " + (toggleBtn) + "\n" +
"        </div>\n" +
"      </div>\n" +
"    ");
  }).join('');
}

// ================= 分析タブ描画 (IMG_6046, 6047 再現) =================
function renderAnalysisView(scopedTx) {
  const currentMonthTx = scopedTx || getScopedTransactions();

  const expenses = currentMonthTx.filter(t => t.type === 'expense');
  const incomes = currentMonthTx.filter(t => t.type === 'income');

  const totalExpense = expenses.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  const totalIncome = incomes.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  const netBalance = totalIncome - totalExpense;

  // 1. 今月の収支カード
  document.getElementById('balanceIncome').textContent = ("¥" + (totalIncome.toLocaleString('ja-JP')));
  document.getElementById('balanceExpense').textContent = ("¥" + (totalExpense.toLocaleString('ja-JP')));
  const netEl = document.getElementById('balanceNet');
  netEl.textContent = ((netBalance >= 0 ? '+' : '') + "¥" + (netBalance.toLocaleString('ja-JP')));
  netEl.className = ("col-val " + (netBalance < 0 ? 'text-red' : 'text-blue'));

  // 2. 4分割サマリーカード
  // a. 最高額の支出
  let maxExpense = null;
  if (expenses.length > 0) {
    maxExpense = expenses.reduce((max, t) => (Number(t.amount) > Number(max.amount) ? t : max), expenses[0]);
  }
  document.getElementById('statMaxExpense').textContent = maxExpense ? ("¥" + (Number(maxExpense.amount).toLocaleString('ja-JP'))) : '¥0';
  document.getElementById('statMaxCategory').textContent = maxExpense ? maxExpense.category : 'なし';

  // b. 最も使ったカテゴリ
  const catSums = {};
  expenses.forEach(t => {
    catSums[t.category] = (catSums[t.category] || 0) + Number(t.amount);
  });
  let topCat = null;
  let topCatAmount = 0;
  for (const [cat, amt] of Object.entries(catSums)) {
    if (amt > topCatAmount) {
      topCat = cat;
      topCatAmount = amt;
    }
  }
  const topCatObj = CATEGORIES.expense.find(c => c.name === topCat);
  document.getElementById('statTopCatEmoji').textContent = topCatObj ? topCatObj.icon : '🍽️';
  document.getElementById('statTopCatName').textContent = topCat || '外食';
  document.getElementById('statTopCatAmount').textContent = ("¥" + (topCatAmount.toLocaleString('ja-JP')));

  // c. 最も使った日
  const daySums = {};
  expenses.forEach(t => {
    daySums[t.date] = (daySums[t.date] || 0) + Number(t.amount);
  });
  let topDay = null;
  let topDayAmount = 0;
  for (const [d, amt] of Object.entries(daySums)) {
    if (amt > topDayAmount) {
      topDay = d;
      topDayAmount = amt;
    }
  }
  let topDayLabel = '10/24(土)';
  if (topDay) {
    const d = new Date(topDay);
    topDayLabel = ((d.getMonth() + 1) + "/" + (d.getDate()) + "(" + (WEEKDAYS[d.getDay()]) + ")");
  }
  document.getElementById('statTopDayAmount').textContent = ("¥" + (topDayAmount.toLocaleString('ja-JP')));
  document.getElementById('statTopDayDate').textContent = topDayLabel;

  // d. 1日の平均
  // 当月の日数（今日が該当月なら今日までの日数、過去月なら月末日数）
  const daysInMonth = new Date(state.currentYear, state.currentMonth, 0).getDate();
  const today = new Date();
  const isCurrentMonthNow = today.getFullYear() === state.currentYear && (today.getMonth() + 1) === state.currentMonth;
  const elapsedDays = isCurrentMonthNow ? Math.max(1, today.getDate()) : daysInMonth;
  const avg = totalExpense > 0 ? Math.round(totalExpense / elapsedDays) : 0;
  document.getElementById('statDailyAverage').textContent = ("¥" + (avg.toLocaleString('ja-JP')));
  document.getElementById('statActiveDays').textContent = ((elapsedDays) + "日間");

  // 3. 前月比バー
  renderCategoryDiffBars(catSums, totalExpense);

  // 4. チャート描画 (Chart.js)
  renderCumulativeChart(expenses, daysInMonth);
  renderRecentMonthsChart();
  renderWeekdayChart(expenses);
}

// 前月比バー
function renderCategoryDiffBars(catSums, totalExpense) {
  const container = document.getElementById('categoryDiffList');
  if (!container) return;

  const entries = Object.entries(catSums);
  if (entries.length === 0) {
    container.innerHTML = ("\n" +
"      <div class=\"category-bar-item\">\n" +
"        <div class=\"cat-bar-left\"><span class=\"cat-icon\">🍽️</span><span class=\"cat-name\">外食</span></div>\n" +
"        <div class=\"cat-bar-track\"><div class=\"cat-bar-fill\" style=\"width: 0%; background-color: #ef4444;\"></div></div>\n" +
"        <div class=\"cat-bar-diff text-red\">¥0</div>\n" +
"      </div>\n" +
"    ");
    return;
  }

  container.innerHTML = entries.map(([cat, amount]) => {
    const catObj = CATEGORIES.expense.find(c => c.name === cat);
    const icon = catObj ? catObj.icon : '📦';
    const pct = totalExpense > 0 ? Math.round((amount / totalExpense) * 100) : 0;
    return ("\n" +
"      <div class=\"category-bar-item\">\n" +
"        <div class=\"cat-bar-left\">\n" +
"          <span class=\"cat-icon\">" + (icon) + "</span>\n" +
"          <span class=\"cat-name\">" + (escapeHtml(cat)) + "</span>\n" +
"        </div>\n" +
"        <div class=\"cat-bar-track\">\n" +
"          <div class=\"cat-bar-fill\" style=\"width: " + (Math.max(8, pct)) + "%; background-color: #ef4444;\"></div>\n" +
"        </div>\n" +
"        <div class=\"cat-bar-diff text-red\">+¥" + (amount.toLocaleString('ja-JP')) + "</div>\n" +
"      </div>\n" +
"    ");
  }).join('');
}

// Chart 1: 支出の累計(前月と比較)
function renderCumulativeChart(expenses, daysInMonth) {
  const canvas = document.getElementById('chartCumulative');
  if (!canvas || typeof Chart === 'undefined') return;

  if (state.charts.cumulative) {
    state.charts.cumulative.destroy();
  }

  // 1日〜月末までの累計を計算
  const labels = [];
  const cumulativeData = [];
  let currentSum = 0;

  // 日付ごとの支出マップ
  const dayMap = {};
  expenses.forEach(t => {
    const day = parseInt(t.date.split('-')[2], 10);
    dayMap[day] = (dayMap[day] || 0) + Number(t.amount);
  });

  const today = new Date();
  const isCurrentMonthNow = today.getFullYear() === state.currentYear && (today.getMonth() + 1) === state.currentMonth;
  const maxDay = isCurrentMonthNow ? Math.min(daysInMonth, today.getDate()) : daysInMonth;

  for (let d = 1; d <= daysInMonth; d++) {
    labels.push(d === 1 || d === 10 || d === 20 || d === daysInMonth ? ((d) + "日") : '');
    if (d <= maxDay) {
      currentSum += (dayMap[d] || 0);
      cumulativeData.push(currentSum);
    } else {
      cumulativeData.push(null);
    }
  }

  // グラフ上限の計算
  const maxVal = Math.max(1000, Math.ceil((currentSum * 1.2) / 250) * 250);

  state.charts.cumulative = new Chart(canvas, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: '今月の累計',
        data: cumulativeData,
        borderColor: '#2563eb',
        borderWidth: 2.5,
        pointBackgroundColor: '#2563eb',
        pointRadius: (ctx) => (ctx.dataIndex === maxDay - 1 ? 5 : 0),
        pointHoverRadius: 6,
        fill: true,
        backgroundColor: 'rgba(37, 99, 235, 0.06)',
        tension: 0.1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ("累計: ¥" + ((ctx.parsed.y || 0).toLocaleString('ja-JP')))
          }
        }
      },
      scales: {
        x: {
          grid: { display: false }
        },
        y: {
          min: 0,
          max: maxVal,
          grid: {
            borderDash: [4, 4],
            color: '#e2e8f0'
          },
          ticks: {
            stepSize: maxVal / 4,
            callback: (v) => v.toLocaleString('ja-JP')
          }
        }
      }
    }
  });
}

// Chart 2: 直近6か月棒グラフ (IMG_6047再現)
function renderRecentMonthsChart() {
  const canvas = document.getElementById('chartRecentMonths');
  if (!canvas || typeof Chart === 'undefined') return;

  if (state.charts.recentMonths) {
    state.charts.recentMonths.destroy();
  }

  // 直近6か月のラベル
  const labels = [];
  const amounts = [];
  const bgColors = [];

  for (let i = 5; i >= 0; i--) {
    let m = state.currentMonth - i;
    let y = state.currentYear;
    if (m <= 0) {
      m += 12;
      y -= 1;
    }
    const prefix = ((y) + "-" + (String(m).padStart(2, '0')));
    let scopedList = state.transactions.filter(t => t.date && t.date.startsWith(prefix) && t.type === 'expense');

    if (state.activeScope === 'personal') {
      // 個人モード: ログイン中ユーザー本人の個人明細のみ
      scopedList = scopedList.filter(t => t.scope === 'personal' && (t.userId === state.currentUserId || (!t.userId && state.currentUserId === 'user_a')));
    } else {
      // グループモード: 承認済みメンバーのみ、該当グループの明細を集計
      const currentGroup = state.groups.find(g => g.id === state.currentGroupId);
      const isApproved = currentGroup && currentGroup.members.some(mem => mem.userId === state.currentUserId && mem.status === 'approved');
      if (!isApproved) {
        scopedList = [];
      } else {
        scopedList = scopedList.filter(t => t.scope === 'group' && (t.groupId === currentGroup.id || (!t.groupId && currentGroup.id === 'grp_default')));
      }
    }

    const mTotal = scopedList.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

    // 全6か月をロックなしで表示
    labels.push(((m) + "月"));
    amounts.push(mTotal);
    bgColors.push(i === 0 ? '#f97316' : '#3b82f6');
  }

  const maxVal = Math.max(1000, Math.ceil((Math.max(...amounts, 850) * 1.2) / 250) * 250);

  state.charts.recentMonths = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        data: amounts,
        backgroundColor: bgColors,
        borderRadius: 4,
        barPercentage: 0.55
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { display: false }
        },
        y: {
          min: 0,
          max: maxVal,
          grid: {
            borderDash: [4, 4],
            color: '#e2e8f0'
          },
          ticks: {
            stepSize: maxVal / 4,
            callback: (v) => v.toLocaleString('ja-JP')
          }
        }
      }
    }
  });
}

// Chart 3: 曜日別の支出 (IMG_6047再現)
function renderWeekdayChart(expenses) {
  const canvas = document.getElementById('chartWeekday');
  if (!canvas || typeof Chart === 'undefined') return;

  if (state.charts.weekday) {
    state.charts.weekday.destroy();
  }

  const weekdaySums = [0, 0, 0, 0, 0, 0, 0];
  expenses.forEach(t => {
    const d = new Date(t.date);
    const dayOfWeek = d.getDay();
    weekdaySums[dayOfWeek] += Number(t.amount) || 0;
  });

  const maxVal = Math.max(1000, Math.ceil((Math.max(...weekdaySums, 850) * 1.2) / 250) * 250);

  state.charts.weekday = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: WEEKDAYS, // 日 月 火 水 木 金 土
      datasets: [{
        data: weekdaySums,
        backgroundColor: (ctx) => (ctx.raw > 0 ? '#2563eb' : '#e2e8f0'),
        borderRadius: 4,
        barPercentage: 0.55
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { display: false }
        },
        y: {
          min: 0,
          max: maxVal,
          grid: {
            borderDash: [4, 4],
            color: '#e2e8f0'
          },
          ticks: {
            stepSize: maxVal / 4,
            callback: (v) => v.toLocaleString('ja-JP')
          }
        }
      }
    }
  });
}

// ================= 写真添付・圧縮処理 =================
function handlePhotoFileSelect(e, mode = 'add') {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (loadEvt) => {
    const img = new Image();
    img.onload = () => {
      // Canvasで最大800pxにリサイズ圧縮（ローカルストレージ容量対策）
      const maxDim = 800;
      let w = img.width;
      let h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) {
          h = Math.round((h * maxDim) / w);
          w = maxDim;
        } else {
          w = Math.round((w * maxDim) / h);
          h = maxDim;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);

      const compressedBase64 = canvas.toDataURL('image/jpeg', 0.7);

      if (mode === 'add') {
        state.modalSelectedPhoto = compressedBase64;
        const wrap = document.getElementById('photoPreviewWrap');
        const previewImg = document.getElementById('photoPreviewImg');
        const attachBtn = document.getElementById('btnAttachPhoto');
        if (wrap) wrap.style.display = 'flex';
        if (previewImg) previewImg.src = compressedBase64;
        if (attachBtn) attachBtn.style.display = 'none';
      } else {
        state.editModalSelectedPhoto = compressedBase64;
        const wrap = document.getElementById('editPhotoPreviewWrap');
        const previewImg = document.getElementById('editPhotoPreviewImg');
        const attachBtn = document.getElementById('btnEditAttachPhoto');
        if (wrap) wrap.style.display = 'flex';
        if (previewImg) previewImg.src = compressedBase64;
        if (attachBtn) attachBtn.style.display = 'none';
      }
    };
    img.src = loadEvt.target.result;
  };
  reader.readAsDataURL(file);
}

function handleRemovePhoto(mode = 'add') {
  if (mode === 'add') {
    state.modalSelectedPhoto = null;
    const wrap = document.getElementById('photoPreviewWrap');
    const previewImg = document.getElementById('photoPreviewImg');
    const attachBtn = document.getElementById('btnAttachPhoto');
    const fileInput = document.getElementById('inputPhotoFile');
    if (wrap) wrap.style.display = 'none';
    if (previewImg) previewImg.src = '';
    if (attachBtn) attachBtn.style.display = 'flex';
    if (fileInput) fileInput.value = '';
  } else {
    state.editModalSelectedPhoto = null;
    const wrap = document.getElementById('editPhotoPreviewWrap');
    const previewImg = document.getElementById('editPhotoPreviewImg');
    const attachBtn = document.getElementById('btnEditAttachPhoto');
    const fileInput = document.getElementById('editInputPhotoFile');
    if (wrap) wrap.style.display = 'none';
    if (previewImg) previewImg.src = '';
    if (attachBtn) attachBtn.style.display = 'flex';
    if (fileInput) fileInput.value = '';
  }
}

// 写真拡大ライトボックス
function openPhotoLightbox(photoUrl) {
  const overlay = document.getElementById('photoLightboxOverlay');
  const img = document.getElementById('lightboxImg');
  if (!overlay || !img) return;
  img.src = photoUrl;
  overlay.style.display = 'flex';
}

function closePhotoLightbox() {
  const overlay = document.getElementById('photoLightboxOverlay');
  if (overlay) overlay.style.display = 'none';
}

// ================= 明細追加モーダル (支出/収入切替 & 写真 & グループ対応) =================
let modalActiveType = 'expense';
let modalSelectedCat = '外食';

function openAddModal() {
  modalActiveType = 'expense';
  modalSelectedCat = '外食';
  switchAddModalType('expense');

  // 現在の画面モードに合わせて初期スコープを設定
  setModalScope(state.activeScope);
  setModalPaidBy('me');

  document.getElementById('inputAmount').value = '';
  document.getElementById('inputMemo').value = '';
  document.getElementById('inputDate').value = state.selectedDate || '2026-10-24';

  // 添付写真をリセット
  handleRemovePhoto('add');

  // グループ選択肢更新
  updateGroupDropdownUI();

  // 支払者名のラベルを最新に更新
  const myName = (state.lineProfile && state.lineProfile.displayName) || state.groupSettings.myName || (TEST_USERS[state.currentUserId] || {}).name || '自分';
  const partnerName = state.groupSettings.partnerName || 'パートナー';
  const meTextEl = document.getElementById('modalPaidByMeText');
  const partnerTextEl = document.getElementById('modalPaidByPartnerText');
  if (meTextEl) meTextEl.textContent = myName;
  if (partnerTextEl) partnerTextEl.textContent = partnerName;

  document.getElementById('addModalOverlay').classList.add('open');
  setTimeout(() => document.getElementById('inputAmount').focus(), 150);
}

function closeAddModal() {
  document.getElementById('addModalOverlay').classList.remove('open');
}

function setModalScope(scope) {
  state.modalScope = scope;
  const isPersonal = scope === 'personal';
  document.getElementById('modalScopePersonal').classList.toggle('active', isPersonal);
  document.getElementById('modalScopeGroup').classList.toggle('active', !isPersonal);

  // グループ選択時のみ対象グループと支払者を表示
  const targetGroupRow = document.getElementById('targetGroupFormGroup');
  const payerGroup = document.getElementById('paidByFormGroup');
  if (targetGroupRow) {
    targetGroupRow.style.display = !isPersonal ? 'block' : 'none';
  }
  if (payerGroup) {
    payerGroup.style.display = !isPersonal ? 'block' : 'none';
  }
}

function setModalPaidBy(payer) {
  state.modalPaidBy = payer;
  const isMe = payer === 'me';
  document.getElementById('modalPaidByMe').classList.toggle('active', isMe);
  document.getElementById('modalPaidByPartner').classList.toggle('active', !isMe);
}

function switchAddModalType(type) {
  modalActiveType = type;
  const isExpense = type === 'expense';

  const btnExpense = document.getElementById('typeExpenseBtn');
  const btnIncome = document.getElementById('typeIncomeBtn');
  if (btnExpense) btnExpense.classList.toggle('active', isExpense);
  if (btnIncome) btnIncome.classList.toggle('active', !isExpense);

  const grid = document.getElementById('categoriesGrid');
  const catList = CATEGORIES[type] || CATEGORIES.expense;
  modalSelectedCat = catList[0].name;

  if (grid) {
    grid.innerHTML = catList.map((cat, idx) => ("\n" +
"      <button type=\"button\" class=\"cat-select-btn " + (idx === 0 ? 'selected' : '') + "\" \n" +
"              data-cat=\"" + (cat.name) + "\" data-icon=\"" + (cat.icon) + "\" onclick=\"selectModalCategory('" + (cat.name) + "')\">\n" +
"        <span class=\"cat-icon-lg\">" + (cat.icon) + "</span>\n" +
"        <span class=\"cat-name-sm\">" + (escapeHtml(cat.name)) + "</span>\n" +
"      </button>\n" +
"    ")).join('');
  }

  if (isExpense) {
    modalSelectedCat = '外食';
    const defaultBtn = grid ? grid.querySelector('[data-cat="外食"]') : null;
    if (defaultBtn) {
      grid.querySelectorAll('.cat-select-btn').forEach(b => b.classList.remove('selected'));
      defaultBtn.classList.add('selected');
    }
  }
}

window.selectModalCategory = function(catName) {
  modalSelectedCat = catName;
  document.querySelectorAll('#categoriesGrid .cat-select-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.getAttribute('data-cat') === catName);
  });
};

async function handleAddTransaction(e) {
  e.preventDefault();
  const amountVal = document.getElementById('inputAmount').value;
  const amount = parseFloat(amountVal);

  if (!amount || isNaN(amount) || amount <= 0) {
    alert('有効な金額を入力してください');
    return;
  }

  const memo = document.getElementById('inputMemo').value.trim();
  const date = document.getElementById('inputDate').value || '2026-10-24';
  const itemScope = state.modalScope || 'personal';
  const itemPaidBy = itemScope === 'group' ? (state.modalPaidBy || 'me') : 'me';

  // 対象グループの取得
  const targetGroupSelect = document.getElementById('modalTargetGroupSelect');
  const targetGroupId = (targetGroupSelect && targetGroupSelect.value) ? targetGroupSelect.value : state.currentGroupId;

  const currentUser = TEST_USERS[state.currentUserId] || TEST_USERS.user_a;

  const newTx = {
    id: 'tx_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    date: date,
    type: modalActiveType,
    category: modalSelectedCat,
    memo: memo || modalSelectedCat,
    amount: amount,
    scope: itemScope,
    groupId: itemScope === 'group' ? targetGroupId : null,
    userId: state.currentUserId,
    userName: currentUser.name,
    paidBy: itemPaidBy,
    photo: state.modalSelectedPhoto || null,
    createdAt: new Date().toISOString()
  };

  // ローカル追加
  state.transactions.unshift(newTx);
  saveTransactionsLocal();

  // 年月を新規アイテムの月に切り替える
  const [itemY, itemM] = date.split('-').map(Number);
  state.currentYear = itemY;
  state.currentMonth = itemM;
  state.selectedDate = date;

  renderApp();
  closeAddModal();

  const scopeMsg = itemScope === 'group' ? '（👥 グループ共有）' : '（👤 個人用・非公開）';
  showToast(((modalActiveType === 'expense' ? '支出' : '収入') + "を記録しました " + (scopeMsg)));

  // GASに送信
  if (state.gasApiUrl) {
    postTransactionToGas(newTx);
  }
}

// ================= 同棲・グループ設定の同期と保存 =================
function updateGroupConfigInputs() {
  const myNameInput = document.getElementById('configMyName');
  const partnerNameInput = document.getElementById('configPartnerName');
  const splitRatioSelect = document.getElementById('configSplitRatio');
  const groupScopeLabel = document.getElementById('groupScopeLabel');

  if (myNameInput) myNameInput.value = state.groupSettings.myName || '自分';
  if (partnerNameInput) partnerNameInput.value = state.groupSettings.partnerName || 'パートナー';
  if (splitRatioSelect) splitRatioSelect.value = String(state.groupSettings.splitRatio || 0.5);
  if (groupScopeLabel) groupScopeLabel.textContent = ("同棲グループ (" + (state.groupSettings.partnerName || 'パートナー') + ")");
}

function handleSaveGroupConfig() {
  const myName = document.getElementById('configMyName').value.trim() || '自分';
  const partnerName = document.getElementById('configPartnerName').value.trim() || 'パートナー';
  const splitRatio = parseFloat(document.getElementById('configSplitRatio').value) || 0.5;

  state.groupSettings.myName = myName;
  state.groupSettings.partnerName = partnerName;
  state.groupSettings.splitRatio = splitRatio;

  safeStorage.setItem('kakeibo_my_name', myName);
  safeStorage.setItem('kakeibo_partner_name', partnerName);
  safeStorage.setItem('kakeibo_split_ratio', String(splitRatio));

  updateGroupConfigInputs();
  renderApp();
  showToast('同棲・グループ共有設定を保存しました');

  // GASの設定シートにも反映
  if (state.gasApiUrl) {
    try {
      fetch(state.gasApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          action: 'saveSettings',
          settings: {
            userName: myName,
            partnerName: partnerName,
            splitRatio: String(splitRatio)
          }
        })
      });
    } catch (e) {}
  }
}

// ================= LINE等に送る精算テキストコピー =================
function handleCopySettlementText() {
  const monthStr = ((state.currentYear) + "年" + (state.currentMonth) + "月");
  const resultText = document.getElementById('settlementResultText').textContent;
  const myName = state.groupSettings.myName;
  const partnerName = state.groupSettings.partnerName;
  const myPaid = document.getElementById('statMyPaid').textContent;
  const partnerPaid = document.getElementById('statPartnerPaid').textContent;

  const text = ("【" + (monthStr) + " 同棲家計簿の精算結果】\n") +
               ("・" + (myName) + "の支払合計: " + (myPaid) + "\n") +
               ("・" + (partnerName) + "の支払合計: " + (partnerPaid) + "\n") +
               ("------------------\n") +
               ("👉 " + (resultText) + "\n") +
               ("------------------\n") +
               ("ご確認よろしくお願いします！");

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('精算メッセージをコピーしました！LINE等に貼付できます');
    }).catch(() => {
      prompt('以下のテキストをコピーして共有してください:', text);
    });
  } else {
    prompt('以下のテキストをコピーして共有してください:', text);
  }
}

async function postTransactionToGas(tx) {
  try {
    await fetch(state.gasApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'addTransaction', data: tx })
    });
  } catch (err) {
    console.warn('GAS送信エラー (ローカルには保存済):', err);
  }
}

// ================= 買い物メモ機能 (IMG_6048再現) =================
function renderShoppingList() {
  const container = document.getElementById('shoppingItemsWrap');
  const countLabel = document.getElementById('shoppingCountLabel');
  const clearBtn = document.getElementById('clearCompletedShoppingBtn');
  if (!container) return;

  const list = state.shoppingList;
  countLabel.textContent = ("買うもの " + (list.length) + "件");

  const hasCompleted = list.some(item => item.completed);
  clearBtn.style.display = hasCompleted ? 'inline-block' : 'none';

  if (list.length === 0) {
    container.innerHTML = ("\n" +
"      <div class=\"card empty-card\" id=\"emptyShoppingCard\">\n" +
"        <p>買うものはありません。</p>\n" +
"      </div>\n" +
"    ");
    return;
  }

  container.innerHTML = list.map(item => ("\n" +
"    <div class=\"shopping-item-card\">\n" +
"      <div class=\"shopping-item-left\">\n" +
"        <input type=\"checkbox\" class=\"shopping-checkbox\" " + (item.completed ? 'checked' : '') + " \n" +
"               onchange=\"toggleShoppingItem('" + (item.id) + "', this.checked)\">\n" +
"        <span class=\"shopping-text " + (item.completed ? 'done' : '') + "\">" + (escapeHtml(item.text)) + "</span>\n" +
"      </div>\n" +
"      <button class=\"btn-delete-shop\" onclick=\"deleteShoppingItem('" + (item.id) + "')\" title=\"削除\">✕</button>\n" +
"    </div>\n" +
"  ")).join('');
}

async function handleAddShoppingItem() {
  const input = document.getElementById('shoppingInput');
  const val = input.value.trim();
  if (!val) return;

  // スペース区切りで複数項目を分割
  const items = val.split(/\s+/).filter(t => t.length > 0);
  const createdItems = [];

  items.forEach(text => {
    const item = {
      id: 'shop_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      text: text,
      completed: false,
      createdAt: new Date().toISOString()
    };
    state.shoppingList.push(item);
    createdItems.push(item);
  });

  saveShoppingLocal();
  input.value = '';
  renderShoppingList();
  showToast(((createdItems.length) + "件のメモを追加しました"));

  if (state.gasApiUrl) {
    try {
      await fetch(state.gasApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'addShoppingItem', items: createdItems })
      });
    } catch (e) {
      console.warn('GAS買い物メモ保存失敗:', e);
    }
  }
}

window.toggleShoppingItem = async function(id, completed) {
  const item = state.shoppingList.find(i => i.id === id);
  if (item) {
    item.completed = completed;
    saveShoppingLocal();
    renderShoppingList();

    if (state.gasApiUrl) {
      try {
        await fetch(state.gasApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ action: 'toggleShoppingItem', id, completed })
        });
      } catch (e) {}
    }
  }
};

window.deleteShoppingItem = async function(id) {
  state.shoppingList = state.shoppingList.filter(i => i.id !== id);
  saveShoppingLocal();
  renderShoppingList();

  if (state.gasApiUrl) {
    try {
      await fetch(state.gasApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'deleteShoppingItem', id })
      });
    } catch (e) {}
  }
};

function clearCompletedShopping() {
  state.shoppingList = state.shoppingList.filter(i => !i.completed);
  saveShoppingLocal();
  renderShoppingList();
  showToast('完了済みのメモを削除しました');
}

// ================= 設定・GAS連携 =================
function handleSaveBudget() {
  const budgetInput = document.getElementById('settingBudgetInput');
  const budgetVal = budgetInput ? budgetInput.value.trim() : '';
  if (!budgetVal) return;

  state.settings.monthlyBudget = budgetVal;
  safeStorage.setItem('kakeibo_budget', budgetVal);
  renderApp();
  showToast('月間予算を保存しました');

  if (state.gasApiUrl) {
    try {
      fetch(state.gasApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'saveSettings', settings: { monthlyBudget: budgetVal } })
      });
    } catch (e) {}
  }
}

function openGasModal() {
  document.getElementById('gasApiUrlInput').value = state.gasApiUrl;
  document.getElementById('gasConnectionStatus').style.display = 'none';
  document.getElementById('gasModalOverlay').classList.add('open');
}

function closeGasModal() {
  document.getElementById('gasModalOverlay').classList.remove('open');
}

async function handleTestGasConnection() {
  const input = document.getElementById('gasApiUrlInput');
  const url = input.value.trim();
  const statusBox = document.getElementById('gasConnectionStatus');
  const statusIcon = document.getElementById('gasStatusIcon');
  const statusMsg = document.getElementById('gasStatusMsg');

  if (!url) {
    alert('GASのデプロイURLを入力してください');
    return;
  }

  statusBox.style.display = 'flex';
  statusBox.className = 'connection-status-box';
  statusIcon.textContent = '⏳';
  statusMsg.textContent = 'スプレッドシートに接続中...';

  try {
    const res = await fetch(((url) + "?action=getAll"), { method: 'GET' });
    const data = await res.json();

    if (data && data.success) {
      state.gasApiUrl = url;
      safeStorage.setItem('kakeibo_gas_url', url);

      // 取得データでローカルを同期
      if (Array.isArray(data.transactions) && data.transactions.length > 0) {
        state.transactions = data.transactions;
        saveTransactionsLocal();
      }
      if (Array.isArray(data.shoppingList)) {
        state.shoppingList = data.shoppingList;
        saveShoppingLocal();
      }
      if (data.settings && data.settings.monthlyBudget) {
        state.settings.monthlyBudget = data.settings.monthlyBudget;
        safeStorage.setItem('kakeibo_budget', data.settings.monthlyBudget);
      }

      statusBox.className = 'connection-status-box success';
      statusIcon.textContent = '✅';
      statusMsg.textContent = '接続成功！スプレッドシートと同期完了しました。';
      updateSyncIndicator();
      renderApp();
      showToast('スプレッドシートと同期しました');
    } else {
      throw new Error(data.error || '不明なエラー');
    }
  } catch (err) {
    statusBox.className = 'connection-status-box error';
    statusIcon.textContent = '⚠️';
    statusMsg.textContent = ("接続エラー: " + (err.message || 'CORSまたはURLを確認してください'));
  }
}

function handleClearGasUrl() {
  state.gasApiUrl = '';
  safeStorage.removeItem('kakeibo_gas_url');
  document.getElementById('gasApiUrlInput').value = '';
  const statusBox = document.getElementById('gasConnectionStatus');
  statusBox.style.display = 'flex';
  statusBox.className = 'connection-status-box';
  document.getElementById('gasStatusIcon').textContent = 'ℹ️';
  document.getElementById('gasStatusMsg').textContent = '設定を解除しました (ローカルモード)';
  updateSyncIndicator();
  showToast('ローカルモードに切り替えました');
}

function updateSyncIndicator() {
  const dot = document.getElementById('syncStatusIndicator');
  const subLabel = document.getElementById('gasSyncSubLabel');
  if (state.gasApiUrl) {
    if (dot) dot.className = 'sync-dot online';
    if (subLabel) subLabel.textContent = 'スプレッドシート連携中 (リアルタイム同期)';
  } else {
    if (dot) dot.className = 'sync-dot';
    if (subLabel) subLabel.textContent = 'ローカル保存中 (未連携)';
  }
}

async function syncWithGas(showNotification = true) {
  if (!state.gasApiUrl) return;
  const dot = document.getElementById('syncStatusIndicator');
  if (dot) dot.className = 'sync-dot syncing';

  try {
    const res = await fetch(((state.gasApiUrl) + "?action=getAll"), { method: 'GET' });
    const data = await res.json();
    if (data && data.success) {
      const payload = data.data || data;
      if (Array.isArray(payload.transactions) && payload.transactions.length > 0) {
        state.transactions = payload.transactions;
        saveTransactionsLocal();
      }
      const shopArr = payload.shoppingList || payload.shopping;
      if (Array.isArray(shopArr)) {
        state.shoppingList = shopArr;
        saveShoppingLocal();
      }
      if (payload.settings && payload.settings.monthlyBudget) {
        state.settings.monthlyBudget = payload.settings.monthlyBudget;
        safeStorage.setItem('kakeibo_budget', payload.settings.monthlyBudget);
      }
      if (payload.lineProfiles && typeof payload.lineProfiles === 'object') {
        state.savedLineProfiles = payload.lineProfiles;
        // PC等で未連携状態のとき、スプレッドシートに保存されたLINEプロフィールがあれば自動引き継ぎ
        if (!state.lineProfile) {
          const profList = Object.values(payload.lineProfiles);
          if (profList.length > 0) {
            applyLineProfile(profList[profList.length - 1], false);
          }
        }
      }
      renderApp();
      if (showNotification) showToast('スプレッドシートの最新データと同期しました');
    }
  } catch (err) {
    console.warn('バックグラウンド同期失敗:', err);
  } finally {
    updateSyncIndicator();
  }
}

// ================= CSVエクスポート =================
function exportToCsv() {
  if (state.transactions.length === 0) {
    alert('エクスポートする明細がありません');
    return;
  }

  const headers = ['日付', '種類', 'カテゴリ', 'メモ', '金額'];
  const rows = state.transactions.map(t => [
    t.date,
    t.type === 'expense' ? '支出' : '収入',
    '"' + (t.category || '').replace(/\x22/g, '""') + '"',
    '"' + (t.memo || '').replace(/\x22/g, '""') + '"',
    t.amount
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', ("家計簿Plus_" + (state.currentYear) + (String(state.currentMonth).padStart(2, '0')) + ".csv"));
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('CSVファイルをダウンロードしました');
}

// ================= 要望送信 =================
async function handleSendFeedback() {
  const textarea = document.getElementById('feedbackText');
  const text = textarea.value.trim();
  if (!text) {
    alert('ご要望内容を入力してください');
    return;
  }

  if (state.gasApiUrl) {
    try {
      await fetch(state.gasApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'sendFeedback', feedback: text })
      });
    } catch (e) {}
  }

  textarea.value = '';
  showToast('ご要望を送信しました！ありがとうございます。');
}

// ================= トースト通知 =================
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toastNotification');
  const msgEl = document.getElementById('toastMessage');
  if (!toast || !msgEl) return;

  msgEl.textContent = msg;
  toast.classList.add('show');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2400);
}

// HTMLエスケープヘルパー
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/\x3c/g, '&lt;')
    .replace(/\x3e/g, '&gt;')
    .replace(/\x22/g, '&quot;')
    .replace(/\x27/g, '&#039;');
}

// ================= 年間・月間 詳細予算管理ロジック =================

// 予算設定をローカルストレージへ保存
function saveBudgetSettingsLocal() {
  safeStorage.setItem('kakeibo_budget_settings', JSON.stringify(state.budgetSettings));
  // 互換性のため現在のスコープの月予算を保存
  const currentMonthly = (state.budgetSettings[state.activeScope] && state.budgetSettings[state.activeScope].monthly) || '';
  state.settings.monthlyBudget = String(currentMonthly);
  safeStorage.setItem('kakeibo_budget', String(currentMonthly));
}

// 予算プログレスバー＆残り金額の描画 (月間・年間・1日あたり目安)
function renderBudgetProgress(totalExpense) {
  const budgetWrap = document.getElementById('budgetProgressWrap');
  const yearlyRow = document.getElementById('yearlyBudgetRow');
  const dailyAllowanceEl = document.getElementById('dailyBudgetAllowanceText');
  if (!budgetWrap) return;

  const currBudget = state.budgetSettings[state.activeScope] || state.budgetSettings.personal;
  const mBudget = Number(currBudget.monthly) || 0;
  const yBudget = Number(currBudget.yearly) || 0;

  // 月間または年間の予算が設定されている場合
  if (mBudget > 0 || yBudget > 0) {
    budgetWrap.style.display = 'block';
    const linkEl = document.getElementById('budgetSettingLink');
    if (linkEl) linkEl.textContent = '予算を変更';

    // 1. 月間プログレス
    const elRemMonth = document.getElementById('budgetRemainingText');
    const elTotMonth = document.getElementById('budgetTotalText');
    const elBarMonth = document.getElementById('budgetProgressBar');

    if (mBudget > 0) {
      const remainingMonth = Math.max(0, mBudget - totalExpense);
      const pctMonth = Math.min(100, (totalExpense / mBudget) * 100);
      if (elRemMonth) elRemMonth.textContent = ("残 ¥" + (remainingMonth.toLocaleString('ja-JP')));
      if (elTotMonth) elTotMonth.textContent = ("/ 月予算 ¥" + (mBudget.toLocaleString('ja-JP')));
      if (elBarMonth) {
        elBarMonth.style.width = ((pctMonth) + "%");
        if (pctMonth >= 100) {
          elBarMonth.style.backgroundColor = '#ef4444';
        } else if (pctMonth >= 80) {
          elBarMonth.style.backgroundColor = '#f59e0b';
        } else {
          elBarMonth.style.backgroundColor = '';
        }
      }

      // 📅 マーケティング提言: 1日あたり使える目安の計算と表示
      if (dailyAllowanceEl) {
        const now = new Date();
        const daysInMonth = new Date(state.currentYear, state.currentMonth, 0).getDate();
        const currentDay = (state.currentYear === now.getFullYear() && state.currentMonth === (now.getMonth() + 1))
          ? now.getDate()
          : 1;
        const remainingDays = Math.max(1, daysInMonth - currentDay + 1);
        const dailyAllowance = Math.floor(remainingMonth / remainingDays);

        dailyAllowanceEl.style.display = 'block';
        dailyAllowanceEl.textContent = ("📅 今月あと" + (remainingDays) + "日 / 1日あたり ¥" + (dailyAllowance.toLocaleString('ja-JP')) + " 使える目安");
      }
    } else {
      if (elRemMonth) elRemMonth.textContent = '月予算 未設定';
      if (elTotMonth) elTotMonth.textContent = '';
      if (elBarMonth) elBarMonth.style.width = '0%';
      if (dailyAllowanceEl) dailyAllowanceEl.style.display = 'none';
    }

    // 2. 年間プログレス
    if (yBudget > 0 && yearlyRow) {
      yearlyRow.style.display = 'block';
      const yearPrefix = ((state.currentYear) + "-");
      const yearlyTx = state.transactions.filter(t => 
        t.type === 'expense' &&
        t.scope === state.activeScope &&
        t.date && t.date.startsWith(yearPrefix)
      );
      const yearlyExpense = yearlyTx.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
      const remainingYear = Math.max(0, yBudget - yearlyExpense);
      const pctYear = Math.min(100, (yearlyExpense / yBudget) * 100);

      const elRemYear = document.getElementById('budgetYearlyRemainingText');
      const elTotYear = document.getElementById('budgetYearlyTotalText');
      const elBarYear = document.getElementById('budgetYearlyProgressBar');

      if (elRemYear) elRemYear.textContent = ("残 ¥" + (remainingYear.toLocaleString('ja-JP')));
      if (elTotYear) elTotYear.textContent = ("/ 年予算 ¥" + (yBudget.toLocaleString('ja-JP')));
      if (elBarYear) elBarYear.style.width = ((pctYear) + "%");
    } else if (yearlyRow) {
      yearlyRow.style.display = 'none';
    }
  } else {
    budgetWrap.style.display = 'none';
    if (dailyAllowanceEl) dailyAllowanceEl.style.display = 'none';
    const linkEl = document.getElementById('budgetSettingLink');
    if (linkEl) linkEl.textContent = '予算を設定する';
  }

  updateBudgetSummarySettingsText();
}

// 設定画面内のサマリーテキスト更新
function updateBudgetSummarySettingsText() {
  const el = document.getElementById('budgetSummarySettingText');
  if (!el) return;
  const p = state.budgetSettings.personal;
  const g = state.budgetSettings.group;
  const pM = p.monthly ? ("月¥" + (Number(p.monthly).toLocaleString('ja-JP'))) : '月未設定';
  const pY = p.yearly ? ("年¥" + (Number(p.yearly).toLocaleString('ja-JP'))) : '年未設定';
  const gM = g.monthly ? ("月¥" + (Number(g.monthly).toLocaleString('ja-JP'))) : '月未設定';
  const gY = g.yearly ? ("年¥" + (Number(g.yearly).toLocaleString('ja-JP'))) : '年未設定';
  el.textContent = ("個人: " + (pM) + "/" + (pY) + " | グループ: " + (gM) + "/" + (gY));
}

// 詳細予算設定モーダルを開く
function openBudgetModal() {
  const overlay = document.getElementById('budgetModalOverlay');
  if (!overlay) return;

  // 表示名ラベルを反映
  const pTitle = document.getElementById('budgetModalPersonalTitle');
  const gTitle = document.getElementById('budgetModalGroupTitle');
  if (pTitle) pTitle.textContent = ((state.groupSettings.myName || '自分') + "の個人予算");
  if (gTitle) gTitle.textContent = ("同棲グループ予算 (" + (state.groupSettings.myName || '自分') + " & " + (state.groupSettings.partnerName || 'パートナー') + ")");

  // 初期タブを現在の画面スコープに合わせる
  state.budgetModalScope = state.activeScope;
  applyBudgetModalScopeUI(state.budgetModalScope);
  loadBudgetInputsForScope(state.budgetModalScope);

  overlay.classList.add('open');
}

// 詳細予算設定モーダルを閉じる
function closeBudgetModal() {
  const overlay = document.getElementById('budgetModalOverlay');
  if (overlay) overlay.classList.remove('open');
}

// モーダル内のスコープ切替 (個人 / グループ)
function switchBudgetModalScope(scope) {
  // 切替前に現在の入力内容を一時保持
  saveCurrentBudgetInputsToState();
  state.budgetModalScope = scope;
  applyBudgetModalScopeUI(scope);
  loadBudgetInputsForScope(scope);
}

function applyBudgetModalScopeUI(scope) {
  const btnP = document.getElementById('budgetScopePersonalBtn');
  const btnG = document.getElementById('budgetScopeGroupBtn');
  if (scope === 'personal') {
    if (btnP) btnP.classList.add('active');
    if (btnG) btnG.classList.remove('active');
  } else {
    if (btnP) btnP.classList.remove('active');
    if (btnG) btnG.classList.add('active');
  }
}

// 入力欄にスコープの予算値をセット
function loadBudgetInputsForScope(scope) {
  const b = state.budgetSettings[scope] || {};
  const inputMonthly = document.getElementById('inputModalMonthlyBudget');
  const inputYearly = document.getElementById('inputModalYearlyBudget');

  if (inputMonthly) inputMonthly.value = b.monthly || '';
  if (inputYearly) inputYearly.value = b.yearly || '';

  // カテゴリ別入力欄
  const catInputs = document.querySelectorAll('.input-cat-budget');
  catInputs.forEach(input => {
    const catName = input.getAttribute('data-cat');
    input.value = (b.categories && b.categories[catName]) || '';
  });
}

// 現在の入力値をstateに反映
function saveCurrentBudgetInputsToState() {
  const scope = state.budgetModalScope;
  const inputMonthly = document.getElementById('inputModalMonthlyBudget');
  const inputYearly = document.getElementById('inputModalYearlyBudget');
  
  if (!state.budgetSettings[scope]) {
    state.budgetSettings[scope] = { monthly: '', yearly: '', categories: {} };
  }

  if (inputMonthly) state.budgetSettings[scope].monthly = inputMonthly.value ? Number(inputMonthly.value) : '';
  if (inputYearly) state.budgetSettings[scope].yearly = inputYearly.value ? Number(inputYearly.value) : '';

  if (!state.budgetSettings[scope].categories) {
    state.budgetSettings[scope].categories = {};
  }
  const catInputs = document.querySelectorAll('.input-cat-budget');
  catInputs.forEach(input => {
    const catName = input.getAttribute('data-cat');
    state.budgetSettings[scope].categories[catName] = input.value ? Number(input.value) : '';
  });
}

// 月予算×12で年間予算を自動計算
function handleAutoCalcYearlyBudget() {
  const inputMonthly = document.getElementById('inputModalMonthlyBudget');
  const inputYearly = document.getElementById('inputModalYearlyBudget');
  const mVal = Number(inputMonthly.value);
  if (mVal > 0) {
    const yVal = mVal * 12;
    inputYearly.value = yVal;
    showToast(("月予算 ¥" + (mVal.toLocaleString('ja-JP')) + " × 12 = ¥" + (yVal.toLocaleString('ja-JP')) + " を設定しました"));
  } else {
    alert('先に月間予算を入力してください');
  }
}

// カテゴリ別予算内訳アコーディオンの開閉
function handleToggleCategoryBudgets() {
  const grid = document.getElementById('categoryBudgetsGrid');
  const header = document.getElementById('toggleCategoryBudgetsBtn');
  if (!grid || !header) return;

  const isHidden = grid.style.display === 'none' || !grid.style.display;
  if (isHidden) {
    grid.style.display = 'flex';
    header.classList.add('open');
  } else {
    grid.style.display = 'none';
    header.classList.remove('open');
  }
}

// 詳細予算の保存
async function handleSaveDetailedBudget() {
  saveCurrentBudgetInputsToState();
  saveBudgetSettingsLocal();
  closeBudgetModal();
  renderApp();
  showToast('詳細予算（月間・年間）を保存しました！');

  // GAS URLがあれば非同期で同期
  if (state.gasApiUrl) {
    try {
      await fetch(state.gasApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          action: 'saveSettings',
          settings: {
            monthlyBudget: (state.budgetSettings[state.activeScope] && state.budgetSettings[state.activeScope].monthly) || '',
            budgetSettings: state.budgetSettings
          }
        })
      });
    } catch (e) {
      console.warn('GAS 予算設定保存エラー:', e);
    }
  }
}

// ================= Gemini API 設定管理 =================

function updateGeminiKeyStatusUI() {
  const keyInput = document.getElementById('settingGeminiApiKey');
  const statusTag = document.getElementById('geminiKeyStatusTag');
  if (keyInput) keyInput.value = state.geminiApiKey || '';
  if (statusTag) {
    if (state.geminiApiKey) {
      statusTag.className = 'gemini-status-tag active';
      statusTag.textContent = '✓ 有効 (Gemini 2.5 Flash)';
    } else {
      statusTag.className = 'gemini-status-tag';
      statusTag.textContent = '未設定 (デモモード)';
    }
  }
}

function handleSaveGeminiApiKey() {
  const keyInput = document.getElementById('settingGeminiApiKey');
  const val = (keyInput ? keyInput.value : '').trim();
  state.geminiApiKey = val;
  if (val) {
    safeStorage.setItem('kakeibo_gemini_key', val);
    showToast('Gemini API キーを保存しました！');
  } else {
    safeStorage.removeItem('kakeibo_gemini_key');
    showToast('Gemini API キーを解除しました (デモモード)');
  }
  updateGeminiKeyStatusUI();
}

// ================= Gemini レシートAI自動読取 =================

// レシートモーダルを開く
function openReceiptModal() {
  const overlay = document.getElementById('receiptModalOverlay');
  if (!overlay) return;

  // カテゴリ選択肢を初期化
  const selectCat = document.getElementById('receiptResultCategory');
  if (selectCat) {
    selectCat.innerHTML = CATEGORIES.expense
      .map(c => ("<option value=\"" + (c.name) + "\">" + (c.icon) + " " + (c.name) + "</option>"))
      .join('');
  }

  // グループ選択肢を初期化
  const selectGroup = document.getElementById('receiptTargetGroupSelect');
  if (selectGroup) {
    selectGroup.innerHTML = state.groups.map(g => ("\n" +
"      <option value=\"" + (g.id) + "\" " + (g.id === state.currentGroupId ? 'selected' : '') + ">" + (escapeHtml(g.name)) + "</option>\n" +
"    ")).join('');
  }

  // スコープと支払者初期化
  setReceiptScope(state.activeScope);
  setReceiptPaidBy('me');

  // ラベルにユーザー名を反映
  const meLabel = document.getElementById('receiptPaidByMeLabel');
  const partnerLabel = document.getElementById('receiptPaidByPartnerLabel');
  if (meLabel) meLabel.textContent = state.groupSettings.myName || '自分';
  if (partnerLabel) partnerLabel.textContent = state.groupSettings.partnerName || 'パートナー';

  // APIキー未設定の案内表示
  const keyNotice = document.getElementById('geminiKeyNotice');
  if (keyNotice) {
    keyNotice.style.display = state.geminiApiKey ? 'none' : 'block';
  }

  // 画像プレビュー状態リセット
  resetReceiptDropZone();
  document.getElementById('receiptResultCard').style.display = 'none';
  document.getElementById('aiLoadingBox').style.display = 'none';

  overlay.classList.add('open');
}

// レシートモーダルを閉じる
function closeReceiptModal() {
  const overlay = document.getElementById('receiptModalOverlay');
  if (overlay) overlay.classList.remove('open');
}

// ドロップゾーンのリセット
function resetReceiptDropZone() {
  const prompt = document.getElementById('dropZonePrompt');
  const preview = document.getElementById('dropZonePreview');
  const previewImg = document.getElementById('receiptPreviewImg');
  const fileInput = document.getElementById('receiptFileInput');
  const btnAnalyze = document.getElementById('btnAnalyzeReceipt');

  if (prompt) prompt.style.display = 'flex';
  if (preview) preview.style.display = 'none';
  if (previewImg) previewImg.src = '';
  if (fileInput) fileInput.value = '';
  if (btnAnalyze) btnAnalyze.disabled = true;

  state.receiptModalState.base64Data = null;
  state.receiptModalState.mimeType = 'image/jpeg';
}

// ファイル選択時のハンドラー (カメラ撮影 / ライブラリ選択)
function handleReceiptFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (loadEvt) => {
    const base64Data = loadEvt.target.result;
    state.receiptModalState.base64Data = base64Data;
    state.receiptModalState.mimeType = file.type || 'image/jpeg';

    const prompt = document.getElementById('dropZonePrompt');
    const preview = document.getElementById('dropZonePreview');
    const previewImg = document.getElementById('receiptPreviewImg');
    const btnAnalyze = document.getElementById('btnAnalyzeReceipt');

    if (prompt) prompt.style.display = 'none';
    if (preview) preview.style.display = 'flex';
    if (previewImg) previewImg.src = base64Data;
    if (btnAnalyze) btnAnalyze.disabled = false;
  };
  reader.readAsDataURL(file);
}

// 「✨ Geminiでレシートを解析する」ボタン
async function handleAnalyzeReceiptClick() {
  if (!state.receiptModalState.base64Data) {
    alert('レシートの写真を選択してください');
    return;
  }
  await executeReceiptAnalysis(state.receiptModalState.base64Data, state.receiptModalState.mimeType, false);
}

// 「💡 サンプルレシートで試す」ボタン (APIキー不要)
async function handleDemoReceiptClick() {
  // サンプルプレビューを表示
  const prompt = document.getElementById('dropZonePrompt');
  const preview = document.getElementById('dropZonePreview');
  const previewImg = document.getElementById('receiptPreviewImg');
  if (prompt) prompt.style.display = 'none';
  if (preview) preview.style.display = 'flex';
  if (previewImg) {
    previewImg.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150"><rect width="200" height="150" fill="%23f1f5f9" rx="8"/><text x="100" y="55" font-family="sans-serif" font-size="28" text-anchor="middle">🧾</text><text x="100" y="85" font-family="sans-serif" font-size="12" fill="%2364748b" text-anchor="middle">サンプルレシート</text><text x="100" y="105" font-family="sans-serif" font-size="11" fill="%2394a3b8" text-anchor="middle">セブン-イレブン (合計 ¥1,480)</text></svg>';
  }

  await executeReceiptAnalysis(null, null, true);
}

// レシート解析の実行ルーチン
async function executeReceiptAnalysis(base64Data, mimeType, isDemo = false) {
  const loadingBox = document.getElementById('aiLoadingBox');
  const resultCard = document.getElementById('receiptResultCard');
  const btnAnalyze = document.getElementById('btnAnalyzeReceipt');
  const btnDemo = document.getElementById('btnDemoReceipt');

  if (loadingBox) loadingBox.style.display = 'flex';
  if (resultCard) resultCard.style.display = 'none';
  if (btnAnalyze) btnAnalyze.disabled = true;
  if (btnDemo) btnDemo.disabled = true;

  try {
    let result;
    if (isDemo || !state.geminiApiKey) {
      result = await getDemoReceiptAnalysis();
    } else {
      result = await analyzeReceiptWithGemini(base64Data, mimeType);
    }
    displayReceiptResult(result);
    showToast('✨ Geminiがレシートを解析しました！');
  } catch (err) {
    alert(("解析に失敗しました: " + (err.message || err)));
  } finally {
    if (loadingBox) loadingBox.style.display = 'none';
    if (btnAnalyze) btnAnalyze.disabled = false;
    if (btnDemo) btnDemo.disabled = false;
  }
}

// Gemini 2.5 Flash API の呼び出し
async function analyzeReceiptWithGemini(base64Data, mimeType) {
  const apiKey = state.geminiApiKey;
  if (!apiKey) {
    return getDemoReceiptAnalysis();
  }

  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(apiKey);
  
  const systemInstruction = [
    "あなたは高精度なレシート解析AIです。渡されたレシート画像から、店名、購入日、合計金額、品目リスト、推奨カテゴリを抽出してください。",
    "必ず次のJSON構造のみを出力してください（Markdownのバッククォート等を含めず、純粋なJSON文字列のみ出力）:",
    "{",
    '  \"store\": \"店名（例: セブン-イレブン）\",',
    '  \"date\": \"YYYY-MM-DD\",',
    '  \"amount\": 1280,',
    '  \"category\": \"食費\",',
    '  \"items\": [',
    '    {\"name\": \"おにぎり\", \"price\": 150},',
    '    {\"name\": \"お茶\", \"price\": 130}',
    '  ]',
    "}",
    "※合計金額は税込の数値を抽出してください。",
    "※カテゴリは次のいずれかから最も適したものを1つ選択してください: 食費, 日用品, 交通費, 交際費, 趣味・娯楽, 衣服・美容, 健康・医療, 通信・光熱, その他。",
    "※日付が読み取れない場合は今日の日付をYYYY-MM-DD形式で入れてください。"
  ].join("\n");

  const pureBase64 = base64Data.replace(/^data:[^;]+;base64,/, '');

  const payload = {
    contents: [
      {
        parts: [
          { text: systemInstruction },
          {
            inlineData: {
              mimeType: mimeType || 'image/jpeg',
              data: pureBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error('Gemini API Error:', errorBody);
    throw new Error(("Gemini API エラー (" + (response.status) + ")"));
  }

  const resultData = await response.json();
  let textContent = '';
  try {
    textContent = resultData.candidates[0].content.parts[0].text;
  } catch (e) {}
  if (!textContent) {
    throw new Error('Gemini APIから有効な応答を取得できませんでした');
  }

  try {
    const cleanJson = textContent.trim().replace(/^\x60\x60\x60json/i, '').replace(/\x60\x60\x60$/i, '').trim();
    return JSON.parse(cleanJson);
  } catch (err) {
    console.error('JSONパース失敗:', textContent);
    throw new Error('解析データのJSON変換に失敗しました');
  }
}

// デモレシートデータ（APIキー未設定時またはデモボタン用）
function getDemoReceiptAnalysis() {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        store: 'セブン-イレブン 渋谷公園通り店',
        date: new Date().toISOString().slice(0, 10),
        amount: 1480,
        category: '食費',
        items: [
          { name: 'おにぎり 具たっぷりツナマヨ', price: 160 },
          { name: '綾鷹 緑茶 525ml', price: 168 },
          { name: '具だくさん豚汁', price: 380 },
          { name: 'ミックスサンドウィッチ', price: 320 },
          { name: 'プレミアムロールケーキ', price: 452 }
        ]
      });
    }, 800);
  });
}

// 解析結果をカードに反映・表示 (カテゴリルールを自動適用)
function displayReceiptResult(data) {
  const resultCard = document.getElementById('receiptResultCard');
  if (!resultCard) return;

  const storeInput = document.getElementById('receiptResultStore');
  const amountInput = document.getElementById('receiptResultAmount');
  const dateInput = document.getElementById('receiptResultDate');
  const catSelect = document.getElementById('receiptResultCategory');

  const storeName = data.store || 'レシート支出';
  if (storeInput) storeInput.value = storeName;
  if (amountInput) amountInput.value = data.amount || 0;
  if (dateInput) dateInput.value = data.date || new Date().toISOString().slice(0, 10);

  // カテゴリルールで自動分類を優先適用
  const ruleCat = findCategoryByRule(storeName);
  const finalCategory = ruleCat || data.category || '食費';

  if (catSelect && finalCategory) {
    catSelect.value = finalCategory;
  }

  // 品目リストの展開
  const itemsAccordion = document.getElementById('receiptItemsAccordion');
  const itemsList = document.getElementById('receiptItemsList');
  if (itemsAccordion && itemsList) {
    if (Array.isArray(data.items) && data.items.length > 0) {
      itemsList.innerHTML = data.items.map(item => ("\n" +
"        <li class=\"receipt-item-row\">\n" +
"          <span class=\"receipt-item-name\">" + (escapeHtml(item.name || '品目')) + "</span>\n" +
"          <span class=\"receipt-item-price\">¥" + (Number(item.price || 0).toLocaleString('ja-JP')) + "</span>\n" +
"        </li>\n" +
"      ")).join('');
      itemsAccordion.style.display = 'block';
    } else {
      itemsAccordion.style.display = 'none';
    }
  }

  resultCard.style.display = 'block';
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// レシート結果フォーム内のスコープ選択 (個人 / グループ)
function setReceiptScope(scope) {
  state.receiptModalState.scope = scope;
  const btnP = document.getElementById('receiptScopePersonal');
  const btnG = document.getElementById('receiptScopeGroup');
  const paidByGroup = document.getElementById('receiptPaidByGroup');
  const targetGroupWrap = document.getElementById('receiptTargetGroupWrap');

  if (scope === 'personal') {
    if (btnP) btnP.classList.add('active');
    if (btnG) btnG.classList.remove('active');
    if (paidByGroup) paidByGroup.style.display = 'none';
    if (targetGroupWrap) targetGroupWrap.style.display = 'none';
  } else {
    if (btnP) btnP.classList.remove('active');
    if (btnG) btnG.classList.add('active');
    if (paidByGroup) paidByGroup.style.display = 'block';
    if (targetGroupWrap) targetGroupWrap.style.display = 'block';
  }
}

// レシート結果フォーム内の支払者選択 (自分 / パートナー)
function setReceiptPaidBy(paidBy) {
  state.receiptModalState.paidBy = paidBy;
  const btnMe = document.getElementById('receiptPaidByMe');
  const btnPartner = document.getElementById('receiptPaidByPartner');

  if (paidBy === 'me') {
    if (btnMe) btnMe.classList.add('active');
    if (btnPartner) btnPartner.classList.remove('active');
  } else {
    if (btnMe) btnMe.classList.remove('active');
    if (btnPartner) btnPartner.classList.add('active');
  }
}

// レシート内容を家計簿に登録
async function handleRegisterReceipt() {
  const storeInput = document.getElementById('receiptResultStore');
  const amountInput = document.getElementById('receiptResultAmount');
  const dateInput = document.getElementById('receiptResultDate');
  const catSelect = document.getElementById('receiptResultCategory');
  const groupSelect = document.getElementById('receiptTargetGroupSelect');

  const amount = Number(amountInput ? amountInput.value : 0);
  if (!amount || amount <= 0) {
    alert('有効な合計金額を入力してください');
    return;
  }

  const memo = (storeInput ? storeInput.value : '').trim() || 'レシート支出';
  const date = (dateInput ? dateInput.value : '') || new Date().toISOString().slice(0, 10);
  const category = (catSelect ? catSelect.value : '食費') || '食費';
  const scope = state.receiptModalState.scope || 'personal';
  const paidBy = scope === 'group' ? state.receiptModalState.paidBy : 'me';
  const targetGroupId = scope === 'group' ? ((groupSelect && groupSelect.value) || state.currentGroupId) : null;

  const currentUser = TEST_USERS[state.currentUserId] || TEST_USERS.user_a;

  const newTx = {
    id: ("tx_" + (Date.now()) + "_" + (Math.random().toString(36).substring(2, 7))),
    date,
    type: 'expense',
    category,
    memo,
    amount,
    scope,
    groupId: targetGroupId,
    userId: state.currentUserId,
    userName: currentUser.name,
    paidBy,
    createdAt: new Date().toISOString()
  };

  // 明細リストの先頭に追加
  state.transactions.unshift(newTx);
  saveTransactionsLocal();

  // 画面の年月を登録した日付に合わせる
  const [txYear, txMonth] = date.split('-').map(Number);
  if (txYear && txMonth) {
    state.currentYear = txYear;
    state.currentMonth = txMonth;
  }
  // スコープも合わせる
  switchScope(scope);

  renderApp();
  closeReceiptModal();
  showToast('🎉 レシートから家計簿に登録しました！');

  // GAS に非同期保存
  if (state.gasApiUrl) {
    try {
      await fetch(state.gasApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'addTransaction', transaction: newTx })
      });
    } catch (e) {
      console.warn('GAS レシート登録エラー:', e);
    }
  }
}

// ================= 明細編集モーダル (タップして編集・削除・写真・スコープ・支払者変更) =================
let editModalActiveType = 'expense';
let editModalSelectedCat = '外食';
let editModalActiveScope = 'personal';
let editModalPaidBy = 'me';

function openEditModal(id) {
  const item = state.transactions.find(t => t.id === id);
  if (!item) return;

  const idInput = document.getElementById('editTxId');
  const amountInput = document.getElementById('editInputAmount');
  const memoInput = document.getElementById('editInputMemo');
  const dateInput = document.getElementById('editInputDate');

  if (idInput) idInput.value = item.id;
  if (amountInput) amountInput.value = item.amount;
  if (memoInput) memoInput.value = item.memo || '';
  if (dateInput) dateInput.value = item.date || new Date().toISOString().slice(0, 10);

  // 支出 / 収入 の切り替え
  switchEditModalType(item.type || 'expense');

  // カテゴリ選択状態の復元
  editModalSelectedCat = item.category || '外食';
  const grid = document.getElementById('editCategoriesGrid');
  if (grid) {
    grid.querySelectorAll('.cat-select-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.getAttribute('data-cat') === editModalSelectedCat);
    });
  }

  // 写真の復元
  state.editModalSelectedPhoto = item.photo || null;
  const wrap = document.getElementById('editPhotoPreviewWrap');
  const previewImg = document.getElementById('editPhotoPreviewImg');
  const attachBtn = document.getElementById('btnEditAttachPhoto');
  const attachLabel = document.getElementById('editPhotoAttachLabel');

  if (item.photo) {
    if (wrap) wrap.style.display = 'flex';
    if (previewImg) previewImg.src = item.photo;
    if (attachBtn) attachBtn.style.display = 'none';
    if (attachLabel) attachLabel.textContent = '写真を変更';
  } else {
    if (wrap) wrap.style.display = 'none';
    if (previewImg) previewImg.src = '';
    if (attachBtn) attachBtn.style.display = 'flex';
    if (attachLabel) attachLabel.textContent = '写真を添付';
  }

  // スコープの復元 (個人 / グループ)
  setEditModalScope(item.scope || 'personal');

  // 支払者の復元
  setEditModalPaidBy(item.paidBy || 'me');

  // ラベルにユーザー名を反映
  const meText = document.getElementById('editModalPaidByMeText');
  const partnerText = document.getElementById('editModalPaidByPartnerText');
  const myName = (state.lineProfile && state.lineProfile.displayName) || state.groupSettings.myName || (TEST_USERS[state.currentUserId] || {}).name || '自分';
  const partnerName = state.groupSettings.partnerName || 'パートナー';
  if (meText) meText.textContent = myName;
  if (partnerText) partnerText.textContent = partnerName;

  // 登録先グループ選択肢の復元
  updateEditModalGroupSelect(item.groupId || state.currentGroupId);

  const overlay = document.getElementById('editModalOverlay');
  if (overlay) overlay.classList.add('open');
}

function closeEditModal() {
  const overlay = document.getElementById('editModalOverlay');
  if (overlay) overlay.classList.remove('open');
}

function switchEditModalType(type) {
  editModalActiveType = type;
  const isExpense = type === 'expense';

  const btnExpense = document.getElementById('editTypeExpenseBtn');
  const btnIncome = document.getElementById('editTypeIncomeBtn');
  if (btnExpense) btnExpense.classList.toggle('active', isExpense);
  if (btnIncome) btnIncome.classList.toggle('active', !isExpense);

  const grid = document.getElementById('editCategoriesGrid');
  const catList = CATEGORIES[type] || CATEGORIES.expense;
  editModalSelectedCat = catList[0].name;

  if (grid) {
    grid.innerHTML = catList.map((cat, idx) => ("\n" +
"      <button type=\"button\" class=\"cat-select-btn " + (idx === 0 ? 'selected' : '') + "\" \n" +
"              data-cat=\"" + (cat.name) + "\" data-icon=\"" + (cat.icon) + "\" onclick=\"selectEditModalCategory('" + (cat.name) + "')\">\n" +
"        <span class=\"cat-icon-lg\">" + (cat.icon) + "</span>\n" +
"        <span class=\"cat-name-sm\">" + (escapeHtml(cat.name)) + "</span>\n" +
"      </button>\n" +
"    ")).join('');
  }
}

window.selectEditModalCategory = function(catName) {
  editModalSelectedCat = catName;
  document.querySelectorAll('#editCategoriesGrid .cat-select-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.getAttribute('data-cat') === catName);
  });
};

function setEditModalScope(scope) {
  editModalActiveScope = scope;
  const isPersonal = scope === 'personal';
  const btnP = document.getElementById('editScopePersonal');
  const btnG = document.getElementById('editScopeGroup');
  const groupRow = document.getElementById('editTargetGroupFormGroup');
  const paidByRow = document.getElementById('editPaidByFormGroup');

  if (btnP) btnP.classList.toggle('active', isPersonal);
  if (btnG) btnG.classList.toggle('active', !isPersonal);
  if (groupRow) groupRow.style.display = !isPersonal ? 'block' : 'none';
  if (paidByRow) paidByRow.style.display = !isPersonal ? 'block' : 'none';
}

function setEditModalPaidBy(payer) {
  editModalPaidBy = payer;
  const isMe = payer === 'me';
  const btnMe = document.getElementById('editModalPaidByMe');
  const btnPartner = document.getElementById('editModalPaidByPartner');
  if (btnMe) btnMe.classList.toggle('active', isMe);
  if (btnPartner) btnPartner.classList.toggle('active', !isMe);
}

function updateEditModalGroupSelect(selectedGroupId) {
  const select = document.getElementById('editTargetGroupSelect');
  if (!select) return;

  select.innerHTML = state.groups.map(g => {
    const isOwner = g.ownerId === state.currentUserId;
    const member = g.members.find(m => m.userId === state.currentUserId);
    let note = '';
    if (isOwner) note = ' 👑(作成者)';
    else if (member && member.status === 'pending') note = ' ⏳(承認待ち)';
    else if (member) note = ' (参加中)';
    return ("<option value=\"" + (g.id) + "\" " + (g.id === selectedGroupId ? 'selected' : '') + ">" + (escapeHtml(g.name)) + (note) + "</option>");
  }).join('');
}

// 明細編集の保存
async function handleSaveEditedTx(e) {
  if (e) e.preventDefault();
  const idInput = document.getElementById('editTxId');
  const id = idInput ? idInput.value : null;
  const item = state.transactions.find(t => t.id === id);
  if (!item) {
    alert('対象の明細が見つかりませんでした');
    return;
  }

  const amountVal = document.getElementById('editInputAmount').value;
  const amount = parseFloat(amountVal);
  if (!amount || isNaN(amount) || amount <= 0) {
    alert('有効な金額を入力してください');
    return;
  }

  const memo = document.getElementById('editInputMemo').value.trim();
  const date = document.getElementById('editInputDate').value || item.date;
  const editTargetSelect = document.getElementById('editTargetGroupSelect');
  const targetGroupId = (editTargetSelect && editTargetSelect.value) ? editTargetSelect.value : (item.groupId || state.currentGroupId);

  // プロパティ更新
  item.amount = amount;
  item.memo = memo || editModalSelectedCat;
  item.date = date;
  item.type = editModalActiveType;
  item.category = editModalSelectedCat;
  item.photo = state.editModalSelectedPhoto || null;
  item.scope = editModalActiveScope;
  item.groupId = editModalActiveScope === 'group' ? targetGroupId : null;
  item.paidBy = editModalActiveScope === 'group' ? editModalPaidBy : 'me';
  item.updatedAt = new Date().toISOString();

  saveTransactionsLocal();
  renderApp();
  closeEditModal();
  showToast('✅ 明細の変更を保存しました');

  // GAS に非同期更新
  if (state.gasApiUrl) {
    try {
      fetch(state.gasApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'updateTransaction', transaction: item })
      });
    } catch (err) {
      console.warn('GAS更新エラー:', err);
    }
  }
}

// 明細の削除
async function handleDeleteTransaction() {
  const idInput = document.getElementById('editTxId');
  const id = idInput ? idInput.value : null;
  const item = state.transactions.find(t => t.id === id);
  if (!item) return;

  if (!confirm(("「" + (item.memo || item.category) + "」(¥" + (Number(item.amount).toLocaleString('ja-JP')) + ") を削除してもよろしいですか？"))) {
    return;
  }

  state.transactions = state.transactions.filter(t => t.id !== id);
  saveTransactionsLocal();
  renderApp();
  closeEditModal();
  showToast('🗑️ 明細を削除しました');

  // GAS に非同期削除
  if (state.gasApiUrl) {
    try {
      fetch(state.gasApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'deleteTransaction', id: id })
      });
    } catch (err) {
      console.warn('GAS削除エラー:', err);
    }
  }
}

// ================= 複数グループ作成モーダル =================
function openCreateGroupModal() {
  const nameInput = document.getElementById('inputNewGroupName');
  if (nameInput) nameInput.value = '';
  handleGenerateNewPasscode();
  const overlay = document.getElementById('createGroupModalOverlay');
  if (overlay) overlay.classList.add('open');
}

function closeCreateGroupModal() {
  const overlay = document.getElementById('createGroupModalOverlay');
  if (overlay) overlay.classList.remove('open');
}

function handleGenerateNewPasscode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const passInput = document.getElementById('inputNewGroupPasscode');
  if (passInput) passInput.value = code;
}

function handleConfirmCreateGroup() {
  const nameInput = document.getElementById('inputNewGroupName');
  const passInput = document.getElementById('inputNewGroupPasscode');
  const name = nameInput ? nameInput.value.trim() : '';
  const passcode = (passInput ? passInput.value.trim() : '') || 'TRIP2026';

  if (!name) {
    alert('グループ名を入力してください');
    return;
  }

  const currentUser = TEST_USERS[state.currentUserId] || TEST_USERS.user_a;

  // 重要: 作成時は作成者1名のみ！勝手に2名にしない
  const newGroup = {
    id: 'grp_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    name: name,
    passcode: passcode.toUpperCase(),
    ownerId: state.currentUserId,
    createdAt: new Date().toISOString(),
    members: [
      {
        userId: state.currentUserId,
        name: currentUser.name,
        role: 'owner',
        status: 'approved',
        joinedAt: new Date().toISOString()
      }
    ]
  };

  state.groups.push(newGroup);
  state.currentGroupId = newGroup.id;
  safeStorage.setItem('kakeibo_current_group_id', newGroup.id);
  saveGroupsLocal();

  updateGroupDropdownUI();
  closeCreateGroupModal();
  renderApp();
  showToast(("🎉 グループ「" + (newGroup.name) + "」を作成しました！"));
}

// ================= 招待コードで参加モーダル =================
function openJoinGroupModal() {
  const passInput = document.getElementById('inputJoinPasscode');
  if (passInput) passInput.value = '';
  const overlay = document.getElementById('joinGroupModalOverlay');
  if (overlay) overlay.classList.add('open');
}

function closeJoinGroupModal() {
  const overlay = document.getElementById('joinGroupModalOverlay');
  if (overlay) overlay.classList.remove('open');
}

function handleConfirmJoinGroup() {
  const passInput = document.getElementById('inputJoinPasscode');
  const inputCode = (passInput ? passInput.value.trim() : '').toUpperCase();

  if (!inputCode) {
    alert('招待パスコードを入力してください');
    return;
  }

  // 招待コードに合致するグループを検索
  const targetGroup = state.groups.find(g => (g.passcode || '').toUpperCase() === inputCode);
  if (!targetGroup) {
    alert('該当する招待パスコードのグループが見つかりませんでした。コードをご確認ください。');
    return;
  }

  // 既にメンバー（承認済み / 承認待ち）か確認
  const existingMember = targetGroup.members.find(m => m.userId === state.currentUserId);
  if (existingMember) {
    if (existingMember.status === 'approved') {
      alert(("すでに「" + (targetGroup.name) + "」の参加メンバーです。"));
      state.currentGroupId = targetGroup.id;
      safeStorage.setItem('kakeibo_current_group_id', targetGroup.id);
      updateGroupDropdownUI();
      closeJoinGroupModal();
      renderApp();
      return;
    } else {
      alert(("「" + (targetGroup.name) + "」への参加申請はすでに送信済みです。メンバーの承認をお待ちください。"));
      closeJoinGroupModal();
      return;
    }
  }

  // 承認待ち (pending) 状態で申請登録！
  const currentUser = TEST_USERS[state.currentUserId] || TEST_USERS.user_a;
  targetGroup.members.push({
    userId: state.currentUserId,
    name: currentUser.name,
    role: 'member',
    status: 'pending',
    appliedAt: new Date().toISOString()
  });

  state.currentGroupId = targetGroup.id;
  safeStorage.setItem('kakeibo_current_group_id', targetGroup.id);
  saveGroupsLocal();

  updateGroupDropdownUI();
  closeJoinGroupModal();
  renderApp();
  showToast(("📨 「" + (targetGroup.name) + "」に参加申請を送りました！承認されるまでお待ちください"));
}

// ================= グループ設定・メンバー管理・承認・退会モーダル =================
function openGroupManageModal() {
  const grp = state.groups.find(g => g.id === state.currentGroupId);
  if (!grp) return;

  const titleEl = document.getElementById('manageModalGroupTitle');
  const passcodeEl = document.getElementById('manageGroupPasscodeText');
  if (titleEl) titleEl.textContent = ("⚙️ " + (grp.name) + " の設定・メンバー管理");
  if (passcodeEl) passcodeEl.textContent = grp.passcode || '------';

  const isOwner = grp.ownerId === state.currentUserId;
  const myMember = grp.members.find(m => m.userId === state.currentUserId);
  const isApproved = myMember && myMember.status === 'approved';

  // 承認待ちメンバー一覧の描画
  const pendingSection = document.getElementById('pendingMembersSection');
  const pendingCountLabel = document.getElementById('pendingCountLabel');
  const pendingListEl = document.getElementById('pendingMembersList');

  const pendingMembers = grp.members.filter(m => m.status === 'pending');
  if (pendingCountLabel) pendingCountLabel.textContent = pendingMembers.length;

  if (pendingSection) {
    if (pendingMembers.length > 0) {
      pendingSection.style.display = 'block';
      if (pendingListEl) {
        pendingListEl.innerHTML = pendingMembers.map(m => {
          const uInfo = TEST_USERS[m.userId] || { avatar: '👤', name: m.name };
          return ("\n" +
"            <div class=\"pending-member-row\">\n" +
"              <div class=\"member-info-left\">\n" +
"                <span class=\"member-avatar\">" + (uInfo.avatar) + "</span>\n" +
"                <div class=\"member-name-wrap\">\n" +
"                  <span class=\"member-name\">" + (escapeHtml(m.name)) + "</span>\n" +
"                  <span class=\"member-applied-time\">申請日時: " + (new Date(m.appliedAt || Date.now()).toLocaleDateString('ja-JP')) + "</span>\n" +
"                </div>\n" +
"              </div>\n" +
"              <div class=\"pending-actions-btns\">\n" +
"                <button type=\"button\" class=\"btn-approve-member\" onclick=\"handleApproveMember('" + (m.userId) + "')\">✅ 承認</button>\n" +
"                <button type=\"button\" class=\"btn-reject-member\" onclick=\"handleRejectMember('" + (m.userId) + "')\">✕ 拒否</button>\n" +
"              </div>\n" +
"            </div>\n" +
"          ");
        }).join('');
      }
    } else {
      pendingSection.style.display = 'none';
    }
  }

  // 正式参加メンバー一覧の描画
  const activeCountLabel = document.getElementById('activeMemberCountLabel');
  const activeMembersListEl = document.getElementById('activeMembersList');
  const activeMembers = grp.members.filter(m => m.status === 'approved');

  if (activeCountLabel) activeCountLabel.textContent = activeMembers.length;
  if (activeMembersListEl) {
    activeMembersListEl.innerHTML = activeMembers.map(m => {
      const uInfo = TEST_USERS[m.userId] || { avatar: '👤', name: m.name };
      const isMemberOwner = m.userId === grp.ownerId;
      const isMe = m.userId === state.currentUserId;

      let kickBtnHtml = '';
      if (isOwner && !isMe) {
        kickBtnHtml = ("<button type=\"button\" class=\"btn-kick-member\" onclick=\"handleKickMember('" + (m.userId) + "')\">退会させる</button>");
      }

      return ("\n" +
"        <div class=\"active-member-row\">\n" +
"          <div class=\"member-info-left\">\n" +
"            <span class=\"member-avatar\">" + (uInfo.avatar) + "</span>\n" +
"            <div class=\"member-name-wrap\">\n" +
"              <span class=\"member-name\">" + (escapeHtml(m.name)) + " " + (isMe ? '(あなた)' : '') + "</span>\n" +
"              <span class=\"member-role-badge " + (isMemberOwner ? 'badge-owner' : 'badge-member') + "\">\n" +
"                " + (isMemberOwner ? '👑 グループ作成者' : '👤 参加メンバー') + "\n" +
"              </span>\n" +
"            </div>\n" +
"          </div>\n" +
"          <div class=\"member-row-right\">\n" +
"            " + (kickBtnHtml) + "\n" +
"          </div>\n" +
"        </div>\n" +
"      ");
    }).join('');
  }

  // 退会セクション
  const leaveSection = document.getElementById('leaveGroupSection');
  if (leaveSection) {
    if (isOwner) {
      leaveSection.innerHTML = ("\n" +
"        <p class=\"field-hint\" style=\"text-align: center; color: var(--text-muted);\">\n" +
"          ※ あなたはこのグループの作成者です。メンバーの退会管理が行えます。\n" +
"        </p>\n" +
"      ");
    } else if (isApproved) {
      leaveSection.innerHTML = ("\n" +
"        <button type=\"button\" class=\"btn-leave-group\" id=\"btnLeaveGroup\" onclick=\"handleLeaveCurrentGroup()\">このグループから退会する</button>\n" +
"      ");
    } else {
      leaveSection.innerHTML = ("\n" +
"        <p class=\"field-hint\" style=\"text-align: center; color: #b45309;\">\n" +
"          ※ 現在承認待ちのため、閲覧権限はありません。\n" +
"        </p>\n" +
"      ");
    }
  }

  const overlay = document.getElementById('groupManageModalOverlay');
  if (overlay) overlay.classList.add('open');
}

function closeGroupManageModal() {
  const overlay = document.getElementById('groupManageModalOverlay');
  if (overlay) overlay.classList.remove('open');
}

// パスコードコピー
function handleCopyGroupPasscode() {
  const grp = state.groups.find(g => g.id === state.currentGroupId);
  if (!grp || !grp.passcode) return;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(grp.passcode).then(() => {
      showToast(("📋 パスコード「" + (grp.passcode) + "」をコピーしました！"));
    }).catch(() => {
      prompt('以下のパスコードを友人に伝えてください:', grp.passcode);
    });
  } else {
    prompt('以下のパスコードを友人に伝えてください:', grp.passcode);
  }
}

// 参加申請を承認
function handleApproveMember(userId) {
  const grp = state.groups.find(g => g.id === state.currentGroupId);
  if (!grp) return;

  const targetMember = grp.members.find(m => m.userId === userId && m.status === 'pending');
  if (!targetMember) return;

  targetMember.status = 'approved';
  targetMember.joinedAt = new Date().toISOString();
  saveGroupsLocal();

  openGroupManageModal();
  renderApp();
  showToast(("🎉 " + (targetMember.name) + " さんのグループ参加を承認しました！"));
}

// 参加申請を拒否
function handleRejectMember(userId) {
  const grp = state.groups.find(g => g.id === state.currentGroupId);
  if (!grp) return;

  const targetMember = grp.members.find(m => m.userId === userId);
  if (!targetMember) return;

  if (!confirm(((targetMember.name) + " さんの参加申請をお断りしますか？"))) return;

  grp.members = grp.members.filter(m => m.userId !== userId);
  saveGroupsLocal();

  openGroupManageModal();
  renderApp();
  showToast(("申請をお断りしました"));
}

// 作成者がメンバーを退会させる (追放)
function handleKickMember(userId) {
  const grp = state.groups.find(g => g.id === state.currentGroupId);
  if (!grp) return;

  if (grp.ownerId !== state.currentUserId) {
    alert('メンバーを退会させることができるのはグループ作成者のみです。');
    return;
  }

  const targetMember = grp.members.find(m => m.userId === userId);
  if (!targetMember) return;

  if (!confirm(("本当に「" + (targetMember.name) + "」さんをグループから退会させますか？\n退会すると、このグループの家計簿を閲覧・共有できなくなります。"))) {
    return;
  }

  grp.members = grp.members.filter(m => m.userId !== userId);
  saveGroupsLocal();

  openGroupManageModal();
  renderApp();
  showToast(("👋 " + (targetMember.name) + " さんを退会させました"));
}

// 参加者が自分からグループを退会する
function handleLeaveCurrentGroup() {
  const grp = state.groups.find(g => g.id === state.currentGroupId);
  if (!grp) return;

  if (grp.ownerId === state.currentUserId) {
    alert('グループ作成者はこの画面から退会できません。');
    return;
  }

  if (!confirm(("本当に「" + (grp.name) + "」から退会しますか？\n退会すると、グループの明細や分析は閲覧できなくなります。"))) {
    return;
  }

  grp.members = grp.members.filter(m => m.userId !== state.currentUserId);
  saveGroupsLocal();

  const remaining = state.groups.find(g => g.id !== grp.id) || state.groups[0];
  if (remaining) {
    state.currentGroupId = remaining.id;
    safeStorage.setItem('kakeibo_current_group_id', remaining.id);
  }

  closeGroupManageModal();
  updateGroupDropdownUI();
  renderApp();
  showToast(("グループ「" + (grp.name) + "」から退会しました"));
}

// ================= テストユーザーバー表示切り替え (🧪ボタン連動) =================
function toggleTestUserBar() {
  const bar = document.getElementById('testUserBar');
  if (!bar) return;
  const isHidden = bar.style.display === 'none';
  bar.style.display = isHidden ? 'flex' : 'none';
  safeStorage.setItem('kakeibo_show_test_bar', isHidden ? 'true' : 'false');
  showToast(isHidden ? '🧪 テストユーザーバーを表示しました' : '🧪 テストユーザーバーを非表示にしました');
}

// 起動時に保存されたテストバー状態を復元
function initTestUserBarVisibility() {
  const bar = document.getElementById('testUserBar');
  if (!bar) return;
  const saved = safeStorage.getItem('kakeibo_show_test_bar');
  if (saved === 'true') {
    bar.style.display = 'flex';
  } else if (saved === 'false') {
    bar.style.display = 'none';
  }
}

// ================= 明細のキーワード検索 ＆ カテゴリピルフィルター =================
function handleSearchFilterChange(query) {
  state.searchQuery = (query || '').trim();
  renderApp();
}

function clearSearchFilter() {
  state.searchQuery = '';
  const input = document.getElementById('searchTxInput');
  if (input) input.value = '';
  renderApp();
}

function setCategoryFilter(category) {
  if (state.categoryFilter === category) {
    state.categoryFilter = ''; // 同一カテゴリタップで解除
  } else {
    state.categoryFilter = category;
  }
  renderApp();
}

function renderCategoryFilterPills(displayTx) {
  const container = document.getElementById('categoryFilterPills');
  if (!container) return;

  const usedCategories = new Set();
  displayTx.forEach(t => {
    if (t.category) usedCategories.add(t.category);
  });

  const catList = Array.from(usedCategories);
  if (catList.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';

  const allActive = !state.categoryFilter ? 'active' : '';
  let html = ("<button type=\"button\" class=\"filter-pill " + (allActive) + "\" onclick=\"setCategoryFilter('')\">すべて</button>");

  catList.forEach(catName => {
    const isActive = state.categoryFilter === catName ? 'active' : '';
    const emoji = findCategoryEmoji(catName);
    html += ("\n" +
"      <button type=\"button\" class=\"filter-pill " + (isActive) + "\" onclick=\"setCategoryFilter('" + (escapeHtml(catName)) + "')\">\n" +
"        <span>" + (emoji) + "</span>\n" +
"        <span>" + (escapeHtml(catName)) + "</span>\n" +
"      </button>\n" +
"    ");
  });

  container.innerHTML = html;
}

function findCategoryEmoji(catName) {
  const all = [...(CATEGORIES.expense || []), ...(CATEGORIES.income || [])];
  const found = all.find(c => c.name === catName);
  return found ? found.icon : '🏷️';
}

function getFilteredTransactions(list) {
  return list.filter(t => {
    // 1. カテゴリピルフィルター
    if (state.categoryFilter && t.category !== state.categoryFilter) {
      return false;
    }
    // 2. 検索キーワードフィルター (品目・店名・メモ・金額・カテゴリ)
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const matchMemo = (t.memo || '').toLowerCase().includes(q);
      const matchCat = (t.category || '').toLowerCase().includes(q);
      const matchAmount = String(t.amount || '').includes(q);
      const matchUser = (t.userName || '').toLowerCase().includes(q);
      if (!matchMemo && !matchCat && !matchAmount && !matchUser) {
        return false;
      }
    }
    return true;
  });
}

// ================= 機能① スマート入力 (明細ファイル一括インポート) =================
let smartImportParsedList = [];
let smartImportActiveScope = 'personal';

function openSmartInputScreen() {
  const screen = document.getElementById('smartInputScreen');
  if (!screen) return;
  smartImportParsedList = [];
  smartImportActiveScope = state.activeScope;
  setSmartImportScope(smartImportActiveScope);
  renderSmartImportPreview();
  screen.classList.add('open');
}

function closeSmartInputScreen() {
  const screen = document.getElementById('smartInputScreen');
  if (screen) screen.classList.remove('open');
}

function setSmartImportScope(scope) {
  smartImportActiveScope = scope;
  const btnP = document.getElementById('smartScopePersonalBtn');
  const btnG = document.getElementById('smartScopeGroupBtn');
  if (btnP) btnP.classList.toggle('active', scope === 'personal');
  if (btnG) btnG.classList.toggle('active', scope !== 'personal');
}

// ファイル選択時のパース処理 (CSV, PDFテキスト, テキスト)
function handleSmartImportFileSelect(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) {
    alert('ファイルサイズが2MBを超えています。2MB以内の明細ファイルを選択してください。');
    return;
  }

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const content = evt.target.result;
      parseImportFileContent(content, file.name);
    } catch (err) {
      alert(("ファイル解析に失敗しました: " + (err.message || err)));
    }
  };

  reader.readAsText(file, 'utf-8');
}

// サンプルデータ読込 (PayPay, 楽天カード, 銀行明細)
function handleLoadDemoSmartImport() {
  const today = new Date().toISOString().slice(0, 10);
  const ym = today.slice(0, 7);

  const demoItems = [
    {
      id: 'imp_demo_1',
      date: ((ym) + "-22"),
      type: 'expense',
      memo: 'PayPay コメダ珈琲店 渋谷店',
      amount: 720,
      isTransfer: false,
      checked: true
    },
    {
      id: 'imp_demo_2',
      date: ((ym) + "-21"),
      type: 'expense',
      memo: '楽天カード コストコ ホールセール',
      amount: 14500,
      isTransfer: false,
      checked: true
    },
    {
      id: 'imp_demo_3',
      date: ((ym) + "-20"),
      type: 'expense',
      memo: 'セブン-イレブン 代々木店',
      amount: 680,
      isTransfer: false,
      checked: true
    },
    {
      id: 'imp_demo_4',
      date: ((ym) + "-18"),
      type: 'expense',
      memo: 'Netflix 月額利用料',
      amount: 1490,
      isTransfer: false,
      checked: true
    },
    {
      id: 'imp_demo_5',
      date: ((ym) + "-15"),
      type: 'income',
      memo: '給与振込 (株式会社ABC)',
      amount: 285000,
      isTransfer: false,
      checked: true
    },
    {
      id: 'imp_demo_6',
      date: ((ym) + "-10"),
      type: 'expense',
      memo: 'ATM 現金引き出し',
      amount: 20000,
      isTransfer: true, // 振替・引落は初期状態でチェックOFF
      checked: false
    },
    {
      id: 'imp_demo_7',
      date: ((ym) + "-05"),
      type: 'expense',
      memo: '楽天カード 口座振替 引落',
      amount: 52400,
      isTransfer: true,
      checked: false
    }
  ];

  // カテゴリルール適用
  smartImportParsedList = demoItems.map(item => {
    const ruleCat = findCategoryByRule(item.memo);
    const category = ruleCat || (item.type === 'income' ? '給与' : 'その他');
    return { ...item, category };
  });

  renderSmartImportPreview();
  showToast('📄 サンプル明細を取り込みました (7件)');
}

// 明細テキスト・CSVパース処理
function parseImportFileContent(text, filename) {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) {
    alert('明細データが空です');
    return;
  }

  const items = [];
  const maxItems = 500;

  for (let i = 0; i < lines.length && items.length < maxItems; i++) {
    const line = lines[i];
    // ヘッダー行スキップ
    if (i === 0 && (line.includes('利用日') || line.includes('日付') || line.includes('Date') || line.includes('金額'))) {
      continue;
    }

    const parts = line.split(/[,\t]/).map(p => p.replace(/^[\x22\x27]|[\x22\x27]$/g, '').trim());
    if (parts.length < 2) continue;

    // 日付と金額・品目の検出
    let date = '';
    let amount = 0;
    let memo = '';

    for (let part of parts) {
      if (!date && /^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(part)) {
        date = part.replace(/[年月]/g, '-').replace(/日/g, '').split('/').join('-');
        const [y, m, d] = date.split('-').map(Number);
        date = ((y) + "-" + (String(m).padStart(2, '0')) + "-" + (String(d).padStart(2, '0')));
      } else if (!amount && /^[-+]?[\d,]+(\.\d+)?$/.test(part) && Math.abs(parseFloat(part.replace(/,/g, ''))) > 0) {
        amount = Math.abs(parseFloat(part.replace(/,/g, '')));
      } else if (part.length > 0 && isNaN(Number(part))) {
        if (!memo) memo = part;
        else memo += ' ' + part;
      }
    }

    if (!amount || amount <= 0) continue;
    if (!date) date = new Date().toISOString().slice(0, 10);
    if (!memo) memo = '明細取込';

    // 振替・引落の判定 (ATM、カード引落、チャージ等は重複防止のため初期OFF)
    const isTransfer = /ATM|振替|引落|口座振替|チャージ/i.test(memo);
    const isIncome = /給料|給与|賞与|入金|振込入金/i.test(memo);
    const type = isIncome ? 'income' : 'expense';

    // カテゴリルールの自動適用
    const ruleCat = findCategoryByRule(memo);
    const category = ruleCat || (type === 'income' ? '給与' : 'その他');

    items.push({
      id: ("imp_" + (Date.now()) + "_" + (i) + "_" + (Math.floor(Math.random() * 1000))),
      date,
      type,
      category,
      memo,
      amount,
      isTransfer,
      checked: !isTransfer
    });
  }

  if (items.length === 0) {
    alert('有効な明細データが検出できませんでした。CSV形式をご確認ください。');
    return;
  }

  smartImportParsedList = items;
  renderSmartImportPreview();
  showToast(("📁 「" + (filename) + "」から " + (items.length) + " 件の明細を読み込みました！"));
}

// プレビュー描画
function renderSmartImportPreview() {
  const previewWrap = document.getElementById('smartImportPreview');
  const emptyCard = document.getElementById('smartImportEmptyCard');
  const countEl = document.getElementById('smartImportCount');
  const listEl = document.getElementById('smartImportList');

  if (!previewWrap || !emptyCard) return;

  if (smartImportParsedList.length === 0) {
    previewWrap.style.display = 'none';
    emptyCard.style.display = 'block';
    return;
  }

  emptyCard.style.display = 'none';
  previewWrap.style.display = 'block';

  const checkedCount = smartImportParsedList.filter(item => item.checked).length;
  if (countEl) {
    countEl.textContent = ((checkedCount) + " / " + (smartImportParsedList.length) + " 件 選択中");
  }

  if (listEl) {
    listEl.innerHTML = smartImportParsedList.map((item, idx) => {
      const emoji = findCategoryEmoji(item.category);
      const isIncome = item.type === 'income';
      const transferBadge = item.isTransfer
        ? ("<span class=\"badge-transfer\">⚠️ 振替/引落 (重複防止のため初期OFF)</span>")
        : '';

      return ("\n" +
"        <div class=\"smart-import-item-card " + (item.checked ? 'selected' : '') + "\">\n" +
"          <label class=\"import-checkbox-wrap\">\n" +
"            <input type=\"checkbox\" " + (item.checked ? 'checked' : '') + " onchange=\"toggleSmartImportItemCheck(" + (idx) + ", this.checked)\">\n" +
"          </label>\n" +
"          <div class=\"import-item-info\">\n" +
"            <div class=\"import-item-top\">\n" +
"              <span class=\"import-item-date\">" + (escapeHtml(item.date)) + "</span>\n" +
"              <span class=\"import-item-cat-badge\">" + (emoji) + " " + (escapeHtml(item.category)) + "</span>\n" +
"              " + (transferBadge) + "\n" +
"            </div>\n" +
"            <div class=\"import-item-memo\">" + (escapeHtml(item.memo)) + "</div>\n" +
"          </div>\n" +
"          <div class=\"import-item-amount " + (isIncome ? 'income' : 'expense') + "\">\n" +
"            " + (isIncome ? '+' : '-') + "¥" + (Number(item.amount).toLocaleString('ja-JP')) + "\n" +
"          </div>\n" +
"        </div>\n" +
"      ");
    }).join('');
  }
}

function toggleSmartImportItemCheck(idx, checked) {
  if (smartImportParsedList[idx]) {
    smartImportParsedList[idx].checked = checked;
    renderSmartImportPreview();
  }
}

function toggleAllSmartImportChecks() {
  const anyUnchecked = smartImportParsedList.some(item => !item.checked);
  smartImportParsedList.forEach(item => {
    item.checked = anyUnchecked;
  });
  renderSmartImportPreview();
}

// 一括インポートの実行
async function handleExecuteSmartImport() {
  const selectedItems = smartImportParsedList.filter(item => item.checked);
  if (selectedItems.length === 0) {
    alert('インポートする明細を1件以上選択してください');
    return;
  }

  const currentUser = TEST_USERS[state.currentUserId] || TEST_USERS.user_a;
  const scope = smartImportActiveScope;
  const groupId = scope === 'group' ? state.currentGroupId : null;

  const newTransactions = selectedItems.map(item => ({
    id: ("tx_" + (Date.now()) + "_" + (Math.random().toString(36).substring(2, 7))),
    date: item.date,
    type: item.type,
    category: item.category,
    memo: item.memo,
    amount: item.amount,
    scope: scope,
    groupId: groupId,
    userId: state.currentUserId,
    userName: currentUser.name,
    paidBy: 'me',
    createdAt: new Date().toISOString()
  }));

  // リストの先頭に追加
  state.transactions = [...newTransactions, ...state.transactions];
  saveTransactionsLocal();

  // 最新の明細の年月を表示
  if (newTransactions.length > 0) {
    const [y, m] = newTransactions[0].date.split('-').map(Number);
    if (y && m) {
      state.currentYear = y;
      state.currentMonth = m;
    }
  }

  switchScope(scope);
  renderApp();
  closeSmartInputScreen();
  showToast(("🎉 " + (newTransactions.length) + " 件の明細を一括インポートしました！"));

  // GAS に非同期保存
  if (state.gasApiUrl) {
    try {
      await fetch(state.gasApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'bulkAddTransactions', transactions: newTransactions })
      });
    } catch (e) {
      console.warn('GAS 一括保存エラー:', e);
    }
  }
}

// ================= 機能② カテゴリルール (キーワード自動仕訳) =================
function loadCategoryRules() {
  const saved = safeStorage.getItem('kakeibo_category_rules');
  if (saved) {
    try {
      state.categoryRules = JSON.parse(saved);
      return;
    } catch (e) {
      console.warn('カテゴリルール読込エラー:', e);
    }
  }
  state.categoryRules = [...DEFAULT_CATEGORY_RULES];
  saveCategoryRulesLocal();
}

function saveCategoryRulesLocal() {
  safeStorage.setItem('kakeibo_category_rules', JSON.stringify(state.categoryRules));
}

function openCategoryRulesScreen() {
  const screen = document.getElementById('categoryRulesScreen');
  if (!screen) return;

  loadCategoryRules();
  populateCategoryRulesSelect();
  renderCategoryRulesList();

  openSlideScreen('categoryRulesScreen');
}

function closeCategoryRulesScreen() {
  closeSlideScreen('categoryRulesScreen');
}

function populateCategoryRulesSelect() {
  const select = document.getElementById('selectRuleCategory') || document.getElementById('ruleTargetCategorySelect');
  if (!select) return;

  const all = [...(CATEGORIES.expense || []), ...(CATEGORIES.income || [])];
  select.innerHTML = all.map(c => ("\n" +
"    <option value=\"" + (c.name) + "\">" + (c.icon) + " " + (c.name) + "</option>\n" +
"  ")).join('');
}

function renderCategoryRulesList() {
  const listEl = document.getElementById('categoryRulesListCard') || document.getElementById('categoryRulesList');
  if (!listEl) return;

  if (state.categoryRules.length === 0) {
    listEl.innerHTML = ("<p class=\"field-hint\" style=\"text-align: center; padding: 24px;\">登録されたルールはありません</p>");
    return;
  }

  listEl.innerHTML = state.categoryRules.map((r, idx) => {
    const emoji = findCategoryEmoji(r.category);
    return ("\n" +
"      <div class=\"rule-item-row\">\n" +
"        <div class=\"rule-item-top\">\n" +
"          <div style=\"display: flex; align-items: center; gap: 10px;\">\n" +
"            <span class=\"rule-cat-emoji\">" + (emoji) + "</span>\n" +
"            <span class=\"rule-desc-text\">「" + (escapeHtml(r.keyword)) + "」 → " + (escapeHtml(r.category)) + "</span>\n" +
"          </div>\n" +
"          <button type=\"button\" class=\"circle-icon-btn btn-rule-delete\" onclick=\"handleDeleteCategoryRule('" + (r.id) + "')\" title=\"削除\" aria-label=\"削除\">\n" +
"            ✕\n" +
"          </button>\n" +
"        </div>\n" +
"      </div>\n" +
"    ");
  }).join('');
}

function handleAddCategoryRule() {
  const keywordInput = document.getElementById('inputRuleKeyword');
  const catSelect = document.getElementById('selectRuleCategory') || document.getElementById('ruleTargetCategorySelect');
  const keyword = (keywordInput ? keywordInput.value : '').trim();
  const category = catSelect ? catSelect.value : '';

  if (!keyword) {
    alert('条件にするキーワード (含む文字) を入力してください');
    if (keywordInput) keywordInput.focus();
    return;
  }
  if (!category) {
    alert('振り分け先のカテゴリを選択してください');
    return;
  }

  // 既存重複のチェック
  const existing = state.categoryRules.find(r => r.keyword.toLowerCase() === keyword.toLowerCase());
  if (existing) {
    existing.category = category;
  } else {
    state.categoryRules.push({
      id: ("rule_" + (Date.now()) + "_" + (Math.floor(Math.random() * 1000))),
      keyword,
      category
    });
  }

  saveCategoryRulesLocal();
  if (keywordInput) keywordInput.value = '';
  renderCategoryRulesList();
  showToast(("✨ ルール「" + (keyword) + " → " + (category) + "」を追加しました"));
}

function handleDeleteCategoryRule(id) {
  state.categoryRules = state.categoryRules.filter(r => r.id !== id);
  saveCategoryRulesLocal();
  renderCategoryRulesList();
  showToast('ルールを削除しました');
}

function handleSaveCategoryRules() {
  saveCategoryRulesLocal();
  closeCategoryRulesScreen();
  showToast('💾 カテゴリルールを保存しました！');
}

// テキストからカテゴリルールを検索してカテゴリ名を返す
function findCategoryByRule(text) {
  if (!text || !state.categoryRules || state.categoryRules.length === 0) return null;
  const lower = text.toLowerCase();
  for (const rule of state.categoryRules) {
    if (rule.keyword && lower.includes(rule.keyword.toLowerCase())) {
      return rule.category;
    }
  }
  return null;
}

// 手入力時のメモ入力に応じて自動でカテゴリを選択
function handleMemoInputAutoRule(memoVal, mode = 'add') {
  const matched = findCategoryByRule(memoVal);
  if (!matched) return;

  if (mode === 'add') {
    selectModalCategory(matched);
  } else {
    selectEditModalCategory(matched);
  }
}

// ================= 機能③ カスタムカテゴリ管理 (追加・編集・並び替え) =================
let editCustomCatActiveType = 'expense';
let selectedNewCatEmoji = '🛒';

const EMOJI_PALETTE_26 = [
  '🛒', '🍽️', '☕', '🍺', '🧴', '🚃', '🚗',
  '⛽', '💡', '🏠', '👕', '💄', '🏥', '💊',
  '📱', '🎮', '📚', '✈️', '🐶', '👶', '🎁',
  '💴', '💻', '💰', '📦', '＋'
];

// カスタムカテゴリをLocalStorageへ保存
function saveCustomCategories() {
  safeStorage.setItem('kakeibo_custom_categories', JSON.stringify(CATEGORIES));
}

// 全画面のカテゴリ選択UI・グリッドを同期更新
function refreshAllCategoryUIs() {
  populateCategoryRulesSelect();
  populateFixedCostCategorySelect();

  // レシートAIモーダルのカテゴリ選択肢
  const receiptCat = document.getElementById('receiptResultCategory');
  if (receiptCat) {
    receiptCat.innerHTML = (CATEGORIES.expense || [])
      .map(c => ("<option value=\"" + (c.name) + "\">" + (c.icon) + " " + (c.name) + "</option>"))
      .join('');
  }

  // 追加モーダル内のグリッド再描画
  if (typeof switchAddModalType === 'function') {
    switchAddModalType(modalActiveType);
  }
  // 編集モーダル内のグリッド再描画
  if (typeof switchEditModalType === 'function') {
    switchEditModalType(editModalActiveType);
  }

  // メイン画面の再描画（ピルフィルター等）
  if (typeof renderApp === 'function') {
    renderApp();
  }
}

function openEditCategoriesScreen() {
  const screen = document.getElementById('editCategoriesScreen');
  if (!screen) return;

  // 最新状態を再読込
  const reloaded = loadCustomCategories();
  CATEGORIES.expense = reloaded.expense;
  CATEGORIES.income = reloaded.income;

  switchEditCategoryType('expense');
  renderEmojiPickerGrid();

  openSlideScreen('editCategoriesScreen');
}

function closeEditCategoriesScreen() {
  closeSlideScreen('editCategoriesScreen');
}

function switchEditCategoryType(type) {
  editCustomCatActiveType = type;
  const btnE = document.getElementById('editCatTypeExpenseBtn') || document.getElementById('btnEditCatTypeExpense');
  const btnI = document.getElementById('editCatTypeIncomeBtn') || document.getElementById('btnEditCatTypeIncome');
  if (btnE) btnE.classList.toggle('active', type === 'expense');
  if (btnI) btnI.classList.toggle('active', type !== 'expense');

  renderCustomCategoriesEditor();
}

function renderEmojiPickerGrid() {
  const container = document.getElementById('emojiPickerGrid');
  if (!container) return;

  container.innerHTML = EMOJI_PALETTE_26.map(emoji => ("\n" +
"    <button type=\"button\" class=\"emoji-pick-btn " + (emoji === selectedNewCatEmoji ? 'selected' : '') + "\" \n" +
"            onclick=\"selectNewCatEmoji('" + (emoji) + "')\" title=\"" + (emoji) + "\" aria-label=\"絵文字 " + (emoji) + "\">\n" +
"      " + (emoji) + "\n" +
"    </button>\n" +
"  ")).join('');
}

function selectNewCatEmoji(emoji) {
  if (emoji === '＋') {
    const custom = prompt('追加したい絵文字を1文字入力してください:');
    if (custom && custom.trim()) {
      selectedNewCatEmoji = custom.trim();
    }
  } else {
    selectedNewCatEmoji = emoji;
  }
  renderEmojiPickerGrid();
}

function renderCustomCategoriesEditor() {
  const listEl = document.getElementById('customCategoriesListWrap') || document.getElementById('customCategoriesList');
  if (!listEl) return;

  const currentList = CATEGORIES[editCustomCatActiveType] || [];

  if (currentList.length === 0) {
    listEl.innerHTML = ("<p class=\"field-hint\" style=\"text-align: center; padding: 24px;\">カテゴリがありません。下から追加してください。</p>");
    return;
  }

  listEl.innerHTML = currentList.map((cat, idx) => ("\n" +
"    <div class=\"edit-cat-row\" data-idx=\"" + (idx) + "\">\n" +
"      <button type=\"button\" class=\"circle-icon-btn btn-cat-delete\" onclick=\"handleDeleteCustomCategory(" + (idx) + ")\" title=\"削除\" aria-label=\"削除\">✕</button>\n" +
"      <div class=\"edit-cat-left\" onclick=\"handleEditExistingCategory(" + (idx) + ")\" title=\"タップして名前と絵文字を変更\">\n" +
"        <span class=\"edit-cat-emoji\">" + (cat.icon) + "</span>\n" +
"        <span class=\"edit-cat-name\">" + (escapeHtml(cat.name)) + "</span>\n" +
"      </div>\n" +
"      <div class=\"edit-cat-actions\">\n" +
"        <button type=\"button\" class=\"circle-icon-btn btn-cat-up\" onclick=\"handleMoveCustomCategory(" + (idx) + ", -1)\" title=\"上へ移動\" aria-label=\"上へ移動\">▲</button>\n" +
"        <button type=\"button\" class=\"circle-icon-btn btn-cat-down\" onclick=\"handleMoveCustomCategory(" + (idx) + ", 1)\" title=\"下へ移動\" aria-label=\"下へ移動\">▼</button>\n" +
"        <span class=\"circle-icon-btn drag-handle-btn\" title=\"並び替えハンドル\">⋮⋮</span>\n" +
"      </div>\n" +
"    </div>\n" +
"  ")).join('');
}

function handleAddCustomCategory() {
  const nameInput = document.getElementById('inputNewCatName') || document.getElementById('inputNewCategoryName');
  const name = (nameInput ? nameInput.value : '').trim();

  if (!name) {
    alert('追加するカテゴリ名を入力してください (例: ペット、推し活)');
    if (nameInput) nameInput.focus();
    return;
  }

  const currentList = CATEGORIES[editCustomCatActiveType] || [];
  if (currentList.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    alert(("「" + (name) + "」は既に登録されています"));
    return;
  }

  const emoji = selectedNewCatEmoji || '🏷️';
  currentList.push({
    name,
    icon: emoji
  });

  saveCustomCategories();
  refreshAllCategoryUIs();

  if (nameInput) nameInput.value = '';
  renderCustomCategoriesEditor();
  showToast(("✨ カテゴリ「" + (emoji) + " " + (name) + "」を追加しました！"));
}

function handleEditExistingCategory(idx) {
  const currentList = CATEGORIES[editCustomCatActiveType] || [];
  const cat = currentList[idx];
  if (!cat) return;

  const newName = prompt(("「" + (cat.name) + "」の新しいカテゴリ名を入力してください:"), cat.name);
  if (newName === null) return; // キャンセル
  const trimmedName = newName.trim();
  if (!trimmedName) {
    alert('カテゴリ名を入力してください');
    return;
  }

  // 重複チェック (自分自身以外)
  const isDuplicate = currentList.some((c, i) => i !== idx && c.name.toLowerCase() === trimmedName.toLowerCase());
  if (isDuplicate) {
    alert(("「" + (trimmedName) + "」は他のカテゴリで既に使われています"));
    return;
  }

  const newEmoji = prompt(("「" + (trimmedName) + "」のアイコン絵文字を入力してください:"), cat.icon);
  if (newEmoji && newEmoji.trim()) {
    cat.icon = newEmoji.trim();
  }
  cat.name = trimmedName;

  saveCustomCategories();
  refreshAllCategoryUIs();
  renderCustomCategoriesEditor();
  showToast(("✅ カテゴリを「" + (cat.icon) + " " + (cat.name) + "」に変更しました"));
}

function handleDeleteCustomCategory(idx) {
  const currentList = CATEGORIES[editCustomCatActiveType] || [];
  const cat = currentList[idx];
  if (!cat) return;

  if (currentList.length <= 1) {
    alert('カテゴリは最低1件必要です');
    return;
  }

  if (!confirm(("カテゴリ「" + (cat.icon) + " " + (cat.name) + "」を削除してもよろしいですか？\n※ 削除しても、これまでの記録データは消えません。"))) {
    return;
  }

  currentList.splice(idx, 1);
  saveCustomCategories();
  refreshAllCategoryUIs();
  renderCustomCategoriesEditor();
  showToast(("🗑️ カテゴリ「" + (cat.name) + "」を削除しました"));
}

function handleMoveCustomCategory(idx, delta) {
  const currentList = CATEGORIES[editCustomCatActiveType] || [];
  const targetIdx = idx + delta;
  if (targetIdx < 0 || targetIdx >= currentList.length) return;

  const temp = currentList[idx];
  currentList[idx] = currentList[targetIdx];
  currentList[targetIdx] = temp;

  saveCustomCategories();
  refreshAllCategoryUIs();
  renderCustomCategoriesEditor();
}

function handleResetCustomCategories() {
  if (!confirm('カテゴリ設定を既定（デフォルト）に戻してもよろしいですか？')) {
    return;
  }

  CATEGORIES.expense = DEFAULT_CATEGORIES.expense.map(c => ({ ...c }));
  CATEGORIES.income = DEFAULT_CATEGORIES.income.map(c => ({ ...c }));

  saveCustomCategories();
  refreshAllCategoryUIs();
  renderCustomCategoriesEditor();
  showToast('既定のカテゴリに戻しました');
}

function handleSaveCustomCategories() {
  saveCustomCategories();
  refreshAllCategoryUIs();
  closeEditCategoriesScreen();
  showToast('💾 カテゴリ設定を保存しました！');
}

// ================= 機能④ 固定費 (定期支出・定額の自動記録) =================
let fixedCostActiveType = 'expense';

function loadFixedCosts() {
  const saved = safeStorage.getItem('kakeibo_fixed_costs');
  if (saved) {
    try {
      state.fixedCosts = JSON.parse(saved);
      return;
    } catch (e) {
      console.warn('固定費読込エラー:', e);
    }
  }
  state.fixedCosts = [...DEFAULT_FIXED_COSTS];
  saveFixedCostsLocal();
}

function saveFixedCostsLocal() {
  safeStorage.setItem('kakeibo_fixed_costs', JSON.stringify(state.fixedCosts));
}

function openFixedCostsScreen() {
  const screen = document.getElementById('fixedCostsScreen');
  if (!screen) return;

  loadFixedCosts();
  populateFixedCostCategorySelect();
  populateFixedCostDaySelect();
  switchFixedCostType('expense');

  openSlideScreen('fixedCostsScreen');
}

function closeFixedCostsScreen() {
  closeSlideScreen('fixedCostsScreen');
}

function switchFixedCostType(type) {
  fixedCostActiveType = type;
  const btnE = document.getElementById('fixedCostTypeExpense') || document.getElementById('btnFixedCostExpense');
  const btnI = document.getElementById('fixedCostTypeIncome') || document.getElementById('btnFixedCostIncome');
  if (btnE) btnE.classList.toggle('active', type === 'expense');
  if (btnI) btnI.classList.toggle('active', type !== 'expense');

  populateFixedCostCategorySelect();
  renderFixedCostsList();
}

function populateFixedCostCategorySelect() {
  const select = document.getElementById('selectFixedCostCat') || document.getElementById('fixedCostCategorySelect');
  if (!select) return;

  const catList = CATEGORIES[fixedCostActiveType] || CATEGORIES.expense;
  select.innerHTML = catList.map(c => ("\n" +
"    <option value=\"" + (c.name) + "\">" + (c.icon) + " " + (c.name) + "</option>\n" +
"  ")).join('');
}

function populateFixedCostDaySelect() {
  const select = document.getElementById('selectFixedCostDay') || document.getElementById('fixedCostDaySelect');
  if (!select) return;

  let options = '';
  for (let i = 1; i <= 31; i++) {
    options += ("<option value=\"" + (i) + "\" " + (i === 27 ? 'selected' : '') + ">" + (i) + "日</option>");
  }
  select.innerHTML = options;
}

function renderFixedCostsList() {
  const listEl = document.getElementById('fixedCostsListCard') || document.getElementById('fixedCostsList');
  if (!listEl) return;

  const filtered = state.fixedCosts.filter(fc => fc.type === fixedCostActiveType);

  if (filtered.length === 0) {
    listEl.innerHTML = ("<p class=\"field-hint\" style=\"text-align: center; padding: 24px;\">登録された固定費はありません</p>");
    return;
  }

  listEl.innerHTML = filtered.map(fc => {
    const emoji = findCategoryEmoji(fc.category);
    const isIncome = fc.type === 'income';

    return ("\n" +
"      <div class=\"fixed-cost-item-row\">\n" +
"        <div class=\"fixed-cost-left\">\n" +
"          <span class=\"fixed-cost-icon\">" + (emoji) + "</span>\n" +
"          <div class=\"fixed-cost-info\">\n" +
"            <span class=\"fixed-cost-title\">" + (escapeHtml(fc.memo || fc.category)) + "</span>\n" +
"            <span class=\"fixed-cost-meta\">毎月 " + (fc.day) + "日 / " + (fc.scope === 'group' ? '👥 グループ' : '👤 個人') + "</span>\n" +
"          </div>\n" +
"        </div>\n" +
"        <div class=\"fixed-cost-right\">\n" +
"          <span class=\"fixed-cost-amount " + (isIncome ? 'income' : 'expense') + "\">\n" +
"            " + (isIncome ? '+' : '-') + "¥" + (Number(fc.amount).toLocaleString('ja-JP')) + "\n" +
"          </span>\n" +
"          <button type=\"button\" class=\"btn-fc-record-now\" onclick=\"handleRecordFixedCostNow('" + (fc.id) + "')\" title=\"今すぐ家計簿に記録\">\n" +
"            ⚡ 記録\n" +
"          </button>\n" +
"          <button type=\"button\" class=\"circle-icon-btn btn-fc-delete\" onclick=\"handleDeleteFixedCost('" + (fc.id) + "')\" title=\"削除\" aria-label=\"削除\">\n" +
"            ✕\n" +
"          </button>\n" +
"        </div>\n" +
"      </div>\n" +
"    ");
  }).join('');
}

function handleAddFixedCost() {
  const catSelect = document.getElementById('selectFixedCostCat') || document.getElementById('fixedCostCategorySelect');
  const amountInput = document.getElementById('inputFixedCostAmount');
  const daySelect = document.getElementById('selectFixedCostDay') || document.getElementById('fixedCostDaySelect');
  const memoInput = document.getElementById('inputFixedCostMemo');

  const amount = Number(amountInput ? amountInput.value : 0);
  if (!amount || amount <= 0) {
    alert('有効な金額を入力してください');
    if (amountInput) amountInput.focus();
    return;
  }

  const category = catSelect ? catSelect.value : '住居費';
  const day = Number(daySelect ? daySelect.value : 27);
  const memo = (memoInput ? memoInput.value : '').trim() || category;

  const newFc = {
    id: ("fc_" + (Date.now()) + "_" + (Math.floor(Math.random() * 1000))),
    type: fixedCostActiveType,
    category,
    amount,
    day,
    memo,
    scope: state.activeScope,
    paidBy: 'me'
  };

  state.fixedCosts.push(newFc);
  saveFixedCostsLocal();

  if (amountInput) amountInput.value = '';
  if (memoInput) memoInput.value = '';

  renderFixedCostsList();
  showToast(("✨ 固定費「" + (memo) + "」を登録しました！"));
}

function handleDeleteFixedCost(id) {
  const fc = state.fixedCosts.find(f => f.id === id);
  if (!fc) return;

  if (!confirm(("固定費「" + (fc.memo || fc.category) + "」の自動登録を解除しますか？"))) {
    return;
  }

  state.fixedCosts = state.fixedCosts.filter(f => f.id !== id);
  saveFixedCostsLocal();
  renderFixedCostsList();
  showToast('固定費を削除しました');
}

// 今すぐ記録ボタン (手動で即時反映)
function handleRecordFixedCostNow(id) {
  const fc = state.fixedCosts.find(f => f.id === id);
  if (!fc) return;

  const currentUser = TEST_USERS[state.currentUserId] || TEST_USERS.user_a;
  const targetDay = String(fc.day).padStart(2, '0');
  const targetDate = ((state.currentYear) + "-" + (String(state.currentMonth).padStart(2, '0')) + "-" + (targetDay));

  const newTx = {
    id: ("tx_" + (Date.now()) + "_" + (Math.random().toString(36).substring(2, 7))),
    date: targetDate,
    type: fc.type,
    category: fc.category,
    memo: fc.memo || fc.category,
    amount: fc.amount,
    scope: fc.scope || state.activeScope,
    groupId: fc.scope === 'group' ? state.currentGroupId : null,
    userId: state.currentUserId,
    userName: currentUser.name,
    paidBy: fc.paidBy || 'me',
    createdAt: new Date().toISOString()
  };

  state.transactions.unshift(newTx);
  saveTransactionsLocal();
  renderApp();
  showToast(("⚡ 固定費「" + (fc.memo) + "」(¥" + (fc.amount.toLocaleString('ja-JP')) + ") を今月の家計簿に記録しました！"));
}

// 月次自動記録プロセス (毎月の記録日を判定して未登録なら自動生成)
function processAutoFixedCosts() {
  if (!state.fixedCosts || state.fixedCosts.length === 0) return;

  const now = new Date();
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1;
  const todayDay = now.getDate();

  // 現在表示中の月が過去または当月の場合にチェック
  if (state.currentYear > todayYear || (state.currentYear === todayYear && state.currentMonth > todayMonth)) {
    return; // 未来の月は自動生成しない
  }

  const currentUser = TEST_USERS[state.currentUserId] || TEST_USERS.user_a;
  let addedCount = 0;

  state.fixedCosts.forEach(fc => {
    // 該当日が過ぎているか確認
    const isPastDay = (state.currentYear < todayYear) || 
                      (state.currentYear === todayYear && state.currentMonth < todayMonth) ||
                      (fc.day <= todayDay);

    if (!isPastDay) return;

    const targetDay = String(fc.day).padStart(2, '0');
    const targetDate = ((state.currentYear) + "-" + (String(state.currentMonth).padStart(2, '0')) + "-" + (targetDay));

    // 同一年月・カテゴリ・金額・固定費メモの取引が既にあるかチェック (二重登録防止)
    const exists = state.transactions.some(t => 
      t.date === targetDate &&
      t.type === fc.type &&
      t.category === fc.category &&
      t.amount === fc.amount &&
      (t.memo || '').includes(fc.memo)
    );

    if (!exists) {
      const autoTx = {
        id: ("tx_auto_" + (Date.now()) + "_" + (Math.floor(Math.random() * 1000))),
        date: targetDate,
        type: fc.type,
        category: fc.category,
        memo: ("[固定費] " + (fc.memo)),
        amount: fc.amount,
        scope: fc.scope || 'personal',
        groupId: fc.scope === 'group' ? state.currentGroupId : null,
        userId: state.currentUserId,
        userName: currentUser.name,
        paidBy: fc.paidBy || 'me',
        createdAt: new Date().toISOString()
      };
      state.transactions.unshift(autoTx);
      addedCount++;
    }
  });

  if (addedCount > 0) {
    saveTransactionsLocal();
  }
}

// ================= 機能⑤ 登録の履歴 (全履歴リスト) =================
function openHistoryScreen() {
  const screen = document.getElementById('historyScreen');
  if (!screen) return;
  renderHistoryList();
  screen.classList.add('open');
}

function closeHistoryScreen() {
  const screen = document.getElementById('historyScreen');
  if (screen) screen.classList.remove('open');
}

function renderHistoryList() {
  const listEl = document.getElementById('historyScreenList');
  if (!listEl) return;

  const currentScopeTx = state.transactions.filter(t => t.scope === state.activeScope);

  if (currentScopeTx.length === 0) {
    listEl.innerHTML = ("<p class=\"field-hint\" style=\"text-align: center; padding: 32px;\">登録された明細の履歴はありません</p>");
    return;
  }

  // 日付順ソート
  const sorted = [...currentScopeTx].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  listEl.innerHTML = sorted.map(t => {
    const isIncome = t.type === 'income';
    const emoji = findCategoryEmoji(t.category);
    return ("\n" +
"      <div class=\"history-item-row\" onclick=\"openEditModal('" + (t.id) + "')\">\n" +
"        <div class=\"history-item-left\">\n" +
"          <span class=\"history-item-date\">" + (t.date || '') + "</span>\n" +
"          <span class=\"history-item-cat\">" + (emoji) + " " + (escapeHtml(t.category)) + "</span>\n" +
"          <span class=\"history-item-memo\">" + (escapeHtml(t.memo || '')) + "</span>\n" +
"        </div>\n" +
"        <div class=\"history-item-right\">\n" +
"          <span class=\"history-item-amount " + (isIncome ? 'income' : 'expense') + "\">\n" +
"            " + (isIncome ? '+' : '-') + "¥" + (Number(t.amount).toLocaleString('ja-JP')) + "\n" +
"          </span>\n" +
"        </div>\n" +
"      </div>\n" +
"    ");
  }).join('');
}

// ================= 全主要操作のグローバル公開 (インラインonclick & 確実な実行保証) =================
window.openSettingsScreen = openSettingsScreen;
window.closeSettingsScreen = closeSettingsScreen;
window.openShoppingScreen = openShoppingScreen;
window.closeShoppingScreen = closeShoppingScreen;
window.handleToggleTestUser = handleToggleTestUser;
window.toggleTestUserBar = toggleTestUserBar;
window.initTestUserBarVisibility = initTestUserBarVisibility;
window.switchScope = switchScope;
window.switchActiveGroup = switchActiveGroup;
window.openGroupManageModal = openGroupManageModal;
window.closeGroupManageModal = closeGroupManageModal;
window.openCreateGroupModal = openCreateGroupModal;
window.closeCreateGroupModal = closeCreateGroupModal;
window.openJoinGroupModal = openJoinGroupModal;
window.closeJoinGroupModal = closeJoinGroupModal;
window.openBudgetModal = openBudgetModal;
window.closeBudgetModal = closeBudgetModal;
window.openAddModal = openAddModal;
window.closeAddModal = closeAddModal;
window.openReceiptModal = openReceiptModal;
window.closeReceiptModal = closeReceiptModal;
window.openEditModal = openEditModal;
window.closeEditModal = closeEditModal;
window.switchTab = switchTab;
window.switchSubView = switchSubView;
window.changeMonth = changeMonth;
window.promptMonthChange = promptMonthChange;
window.openGasModal = openGasModal;
window.closeGasModal = closeGasModal;
window.handleApproveMember = handleApproveMember;
window.handleRejectMember = handleRejectMember;
window.handleKickMember = handleKickMember;
window.handleLeaveCurrentGroup = handleLeaveCurrentGroup;
window.handleAddTransaction = handleAddTransaction;
window.handleSaveEditedTx = handleSaveEditedTx;
window.handleDeleteTransaction = handleDeleteTransaction;
window.handleConfirmCreateGroup = handleConfirmCreateGroup;
window.handleConfirmJoinGroup = handleConfirmJoinGroup;
window.handleCopyGroupPasscode = handleCopyGroupPasscode;
window.handleGenerateNewPasscode = handleGenerateNewPasscode;
window.handleAddShoppingItem = handleAddShoppingItem;
window.clearCompletedShopping = clearCompletedShopping;
window.handleSaveGeminiApiKey = handleSaveGeminiApiKey;
window.handleSaveGroupConfig = handleSaveGroupConfig;
window.switchAddModalType = switchAddModalType;
window.switchEditModalType = switchEditModalType;
window.setModalScope = setModalScope;
window.setModalPaidBy = setModalPaidBy;
window.setEditModalScope = setEditModalScope;
window.setEditModalPaidBy = setEditModalPaidBy;
window.handleRemovePhoto = handleRemovePhoto;
window.openPhotoLightbox = openPhotoLightbox;
window.closePhotoLightbox = closePhotoLightbox;

// 4大新機能・検索・フィルター
window.handleSearchFilterChange = handleSearchFilterChange;
window.clearSearchFilter = clearSearchFilter;
window.setCategoryFilter = setCategoryFilter;
window.renderCategoryFilterPills = renderCategoryFilterPills;
window.getFilteredTransactions = getFilteredTransactions;

window.openSmartInputScreen = openSmartInputScreen;
window.closeSmartInputScreen = closeSmartInputScreen;
window.setSmartImportScope = setSmartImportScope;
window.handleSmartImportFileSelect = handleSmartImportFileSelect;
window.handleLoadDemoSmartImport = handleLoadDemoSmartImport;
window.toggleSmartImportItemCheck = toggleSmartImportItemCheck;
window.toggleAllSmartImportChecks = toggleAllSmartImportChecks;
window.handleExecuteSmartImport = handleExecuteSmartImport;

window.openCategoryRulesScreen = openCategoryRulesScreen;
window.closeCategoryRulesScreen = closeCategoryRulesScreen;
window.handleAddCategoryRule = handleAddCategoryRule;
window.handleDeleteCategoryRule = handleDeleteCategoryRule;
window.handleSaveCategoryRules = handleSaveCategoryRules;
window.findCategoryByRule = findCategoryByRule;
window.handleMemoInputAutoRule = handleMemoInputAutoRule;

window.openEditCategoriesScreen = openEditCategoriesScreen;
window.closeEditCategoriesScreen = closeEditCategoriesScreen;
window.switchEditCategoryType = switchEditCategoryType;
window.renderEmojiPickerGrid = renderEmojiPickerGrid;
window.selectNewCatEmoji = selectNewCatEmoji;
window.handleAddCustomCategory = handleAddCustomCategory;
window.handleEditExistingCategory = handleEditExistingCategory;
window.handleDeleteCustomCategory = handleDeleteCustomCategory;
window.handleMoveCustomCategory = handleMoveCustomCategory;
window.handleResetCustomCategories = handleResetCustomCategories;
window.handleSaveCustomCategories = handleSaveCustomCategories;
window.saveCustomCategories = saveCustomCategories;
window.refreshAllCategoryUIs = refreshAllCategoryUIs;

window.openFixedCostsScreen = openFixedCostsScreen;
window.closeFixedCostsScreen = closeFixedCostsScreen;
window.switchFixedCostType = switchFixedCostType;
window.handleAddFixedCost = handleAddFixedCost;
window.handleDeleteFixedCost = handleDeleteFixedCost;
window.handleRecordFixedCostNow = handleRecordFixedCostNow;
window.processAutoFixedCosts = processAutoFixedCosts;

window.openHistoryScreen = openHistoryScreen;
window.closeHistoryScreen = closeHistoryScreen;


