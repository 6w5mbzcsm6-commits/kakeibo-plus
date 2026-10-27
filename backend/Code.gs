/**
 * 夫婦・家族向け共同家計簿アプリ バックエンド (GAS) v2.1
 * LINE Messaging API Webhook & LIFF Web API
 *
 * v2.1 主な機能とセキュリティ強化:
 *  - 操作者の確定（LIFF IDトークンをLINEサーバーで検証）とフェイルクローズ認証
 *  - LIFF検証済みIDトークンによる安全な初回メンバー登録（Webhook偽装による乗っ取り防止）
 *  - 全変更の監査ログ（AuditLogシート自動生成・レシート明細削除履歴・設定変更履歴）
 *  - 過去36ヶ月分の月別集計（リクエスト内メモリキャッシュによる高速化）
 *  - レシートAI-OCR（Gemini API）と明細・価格履歴の保存/検索（値引き行除外・私物プライバシー保護）
 *  - スプレッドシート数式インジェクション対策
 *
 * 必要なスクリプトプロパティ:
 *  - LIFF_CHANNEL_ID           : 【必須】LIFFを作成したLINEログインチャネルのチャネルID
 *  - LINE_CHANNEL_ACCESS_TOKEN : Messaging APIのチャネルアクセストークン
 *  - GEMINI_API_KEY            : レシートOCR用（Google AI Studioで取得）
 *  - GEMINI_MODEL              : 任意。既定は gemini-2.5-flash
 *  - REGISTER_CODE             : 任意。LINEトークからメンバー登録する場合の合言葉
 *  - DEMO_MODE                 : 任意。'true' の場合のみ LIFF_CHANNEL_ID 未設定でのテスト動作を許可
 *  - SPREADSHEET_ID            : 任意。スタンドアロン運用時のみ
 */

// ==========================================
// 設定・定数
// ==========================================
const SCRIPT_PROPERTIES = PropertiesService.getScriptProperties();
const TZ = 'Asia/Tokyo';
const MAX_HISTORY_MONTHS = 36; // 過去3年分
const DEFAULT_BUDGET = 240000;

const SHEET_NAMES = {
  TRANSACTIONS: 'Transactions',
  SHOPPING_LIST: 'ShoppingList',
  MONTHLY_BUDGETS: 'MonthlyBudgets',
  FIXED_EXPENSES: 'FixedExpenses',
  CATEGORIES: 'Categories',
  RULES: 'Rules',
  CONFIG: 'Config',
  RECEIPTS: 'Receipts',
  RECEIPT_ITEMS: 'ReceiptItems',
  AUDIT_LOG: 'AuditLog'
};

// Transactions シートの列定義（0始まり・計14列）
const TX_HEADERS = [
  'ID', '日付', '品名・内容', '金額', 'カテゴリ', '共同フラグ', '支払種別', '支払者', 'メモ',
  '登録者', '登録日時', '最終更新者', '最終更新日時', 'レシートID'
];
const TX = {
  ID: 0, DATE: 1, TITLE: 2, AMOUNT: 3, CATEGORY: 4, IS_SHARED: 5, PAYMENT_TYPE: 6, PAYER: 7, MEMO: 8,
  CREATED_BY: 9, CREATED_AT: 10, UPDATED_BY: 11, UPDATED_AT: 12, RECEIPT_ID: 13
};

const RECEIPT_HEADERS = ['レシートID', '日付', '店名', '合計', '支払者', '登録者', '登録日時'];
const RECEIPT_ITEM_HEADERS = ['明細ID', 'レシートID', '日付', '店名', '品名', '正規化名', '数量', '金額', '単価'];
const AUDIT_HEADERS = ['日時', '操作者', '認証済', '操作', '対象種別', '対象ID', '変更前', '変更後'];

const ALLOWED_PAYMENT_TYPES = ['shared_card', 'advanced_by_user', 'personal_cash'];
const SYSTEM_ACTOR = { allowed: true, verified: true, name: 'システム', userId: '' };

// リクエスト内のシート読み取りキャッシュ（同一リクエストでの重複I/Oを排除）
let _memCache = {};
function clearMemCache() {
  _memCache = {};
}

// ==========================================
// 共通ユーティリティ
// ==========================================

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * スプレッドシートへの数式インジェクション防止（=, +, -, @, タブ, 改行で始まる文字列をエスケープ）
 */
function safeSheetStr(v) {
  const s = String(v === undefined || v === null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) {
    return "'" + s;
  }
  return s;
}

/**
 * 読み取り時に先頭のエスケープ用シングルクォートがあれば復元
 */
function cleanSheetStr(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return s.replace(/^'([=+\-@\t\r])/, '$1');
}

function fmtDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}

function fmtDateTime(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
  return String(v || '');
}

function nowStr() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

function todayStr() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function currentMonthStr() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
}

function toBool(v) {
  return v === true || String(v).toLowerCase() === 'true';
}

/**
 * 実在する日付（yyyy-MM-dd）かどうかを厳密に検証（2026-02-31などを拒否）
 */
function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const [y, m, d] = String(s).split('-').map(Number);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && (dt.getMonth() + 1) === m && dt.getDate() === d;
}

/**
 * 対象月を検証し、不正または範囲外なら当月を返す（過去36ヶ月まで）
 */
function sanitizeMonth(monthStr) {
  const cur = currentMonthStr();
  if (!/^\d{4}-\d{2}$/.test(String(monthStr || ''))) return cur;
  const [y, m] = monthStr.split('-').map(Number);
  const [cy, cm] = cur.split('-').map(Number);
  const diff = (cy - y) * 12 + (cm - m);
  if (m < 1 || m > 12 || diff < 0 || diff >= MAX_HISTORY_MONTHS) return cur;
  return monthStr;
}

/**
 * 品名の正規化（全角半角・大小・ひらがな/カタカナ・空白を吸収して価格検索に使う）
 */
function normalizeName(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
    .replace(/\s+/g, '');
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    throw new Error('他の操作が処理中です。数秒待ってからもう一度お試しください');
  }
  try {
    return fn();
  } finally {
    clearMemCache();
    lock.releaseLock();
  }
}

// ==========================================
// スプレッドシート基本操作
// ==========================================

function getSpreadsheet() {
  if (_memCache._ss) return _memCache._ss;
  const ssId = SCRIPT_PROPERTIES.getProperty('SPREADSHEET_ID');
  _memCache._ss = ssId ? SpreadsheetApp.openById(ssId) : SpreadsheetApp.getActiveSpreadsheet();
  return _memCache._ss;
}

function getSheet(name) {
  if (!_memCache._sheets) _memCache._sheets = {};
  if (_memCache._sheets[name] !== undefined) return _memCache._sheets[name];
  _memCache._sheets[name] = getSpreadsheet().getSheetByName(name);
  return _memCache._sheets[name];
}

function findRowIndexById(sheet, id, col) {
  if (!sheet) return -1;
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;
  const ids = sheet.getRange(2, col || 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

// ==========================================
// 認証・操作者の特定（フェイルクローズ設計）
// ==========================================

function isDemoAllowed() {
  return SCRIPT_PROPERTIES.getProperty('DEMO_MODE') === 'true';
}

/**
 * LIFFのIDトークンをLINEサーバーで検証し、LINEユーザーIDを返す。失敗時は空文字。
 */
function verifyIdToken(idToken, channelId) {
  if (!idToken || !channelId) return '';
  const cache = CacheService.getScriptCache();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken);
  const key = 'idt_' + Utilities.base64EncodeWebSafe(digest);
  const cached = cache.get(key);
  if (cached) return cached;

  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: channelId },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return '';
  const body = JSON.parse(res.getContentText());
  if (!body.sub) return '';
  const ttl = Math.max(1, Math.min(3000, Number(body.exp) - Math.floor(Date.now() / 1000)));
  cache.put(key, body.sub, ttl);
  return body.sub;
}

/**
 * 設定から2人の表示名を取得（未設定時は「メンバー1」「メンバー2」）
 */
function getMemberNames(config) {
  const cfg = config || getConfigData();
  return {
    husbandName: cleanSheetStr(cfg.husbandName || '') || 'メンバー1',
    wifeName: cleanSheetStr(cfg.wifeName || '') || 'メンバー2'
  };
}

/**
 * 支払者名またはスロット識別子から 'husband' | 'wife' | 'shared' | null を判定
 * 過去データの「夫」「妻」や表示名変更前のデータもスロットに正規化する
 */
function resolvePayerSlot(payer, config) {
  const p = String(payer || '').trim();
  if (!p) return null;
  if (p === '共同' || p === 'shared') return 'shared';
  const names = getMemberNames(config);
  if (p === names.husbandName || p === '夫' || p === 'メンバー1' || p === 'husband') return 'husband';
  if (p === names.wifeName || p === '妻' || p === 'メンバー2' || p === 'wife') return 'wife';
  return null;
}

/**
 * ユーザーIDからメンバー表示名を判定。未登録なら null
 */
function memberNameFromUserId(userId) {
  if (!userId) return null;
  const config = getConfigData();
  const names = getMemberNames(config);
  if (userId === config.husbandUserId) return names.husbandName;
  if (userId === config.wifeUserId) return names.wifeName;
  return null;
}

/**
 * LIFFからのリクエストの操作者を確定する
 * - LIFF_CHANNEL_ID 設定時: LINEサーバーでIDトークンを検証し、登録済みメンバーのみ許可
 * - LIFF_CHANNEL_ID 未設定時: DEMO_MODE='true' の場合のみ未認証デモとして許可、それ以外は拒否（フェイルクローズ）
 */
function resolveActor(idToken) {
  const channelId = SCRIPT_PROPERTIES.getProperty('LIFF_CHANNEL_ID');
  if (!channelId) {
    if (isDemoAllowed()) {
      return { allowed: true, verified: false, name: '未認証', userId: '' };
    }
    return {
      allowed: false,
      code: 'SETUP_REQUIRED',
      error: 'セキュリティ保護のため、GASのスクリプトプロパティに LIFF_CHANNEL_ID を設定してください（README Step 6参照）。'
    };
  }
  if (!idToken) {
    return { allowed: false, code: 'AUTH', error: 'LINEログインが必要です。LINEアプリ内から開いてください。' };
  }
  const userId = verifyIdToken(idToken, channelId);
  if (!userId) {
    return { allowed: false, code: 'AUTH', error: 'ログインの有効期限が切れました。再読み込みしてください。' };
  }
  const name = memberNameFromUserId(userId);
  if (!name) {
    const config = getConfigData();
    const names = getMemberNames(config);
    return {
      allowed: false,
      code: 'UNREGISTERED',
      userId: userId,
      availableRoles: {
        husband: !config.husbandUserId,
        wife: !config.wifeUserId,
        husbandName: names.husbandName,
        wifeName: names.wifeName
      },
      error: 'このLINEアカウントはまだ登録されていません。下の画面でお好きな表示名を入力して登録してください。'
    };
  }
  return { allowed: true, verified: true, name: name, userId: userId };
}

/**
 * LIFFの検証済みIDトークンを用いた安全な初回メンバー登録（自由な表示名に対応）
 */
function registerMemberByToken(idToken, data) {
  const channelId = SCRIPT_PROPERTIES.getProperty('LIFF_CHANNEL_ID');
  if (!channelId) {
    return { success: false, error: 'LIFF_CHANNEL_ID が設定されていません（Step 6参照）' };
  }
  const userId = verifyIdToken(idToken, channelId);
  if (!userId) {
    return { success: false, code: 'AUTH', error: 'LINEログインの検証に失敗しました。再読み込みしてください。' };
  }
  const rawSlot = data && (data.slot || data.role);
  const slot = (rawSlot === 'husband' || rawSlot === '夫' || rawSlot === 'メンバー1')
    ? 'husband'
    : ((rawSlot === 'wife' || rawSlot === '妻' || rawSlot === 'メンバー2') ? 'wife' : '');
  if (!slot) {
    return { success: false, error: '登録するメンバー枠を選択してください' };
  }
  const customName = String((data && data.name) || '').trim().slice(0, 15);
  if (!customName) {
    return { success: false, error: '表示名（ニックネーム）を入力してください（15文字以内）' };
  }
  if (['共同', 'all', '未認証', '自動計上'].indexOf(customName) !== -1) {
    return { success: false, error: `「${customName}」はシステム予約語のため表示名に使用できません` };
  }
  const requiredCode = SCRIPT_PROPERTIES.getProperty('REGISTER_CODE');
  if (requiredCode && String(data.registerCode || '').trim() !== requiredCode) {
    return { success: false, error: '登録用の合言葉（REGISTER_CODE）が一致しません' };
  }

  return withLock(() => {
    clearMemCache();
    const config = getConfigData();
    const names = getMemberNames(config);
    const key = slot === 'husband' ? 'husbandUserId' : 'wifeUserId';
    const otherKey = slot === 'husband' ? 'wifeUserId' : 'husbandUserId';
    const nameKey = slot === 'husband' ? 'husbandName' : 'wifeName';
    const otherName = slot === 'husband' ? names.wifeName : names.husbandName;
    const avail = () => ({
      husband: !config.husbandUserId,
      wife: !config.wifeUserId,
      husbandName: names.husbandName,
      wifeName: names.wifeName
    });

    if (config[key] && config[key] !== userId) {
      return { success: false, availableRoles: avail(), error: '選択した枠は既に別のアカウントで登録済みです。もう一方の枠を選択してください。' };
    }
    if (config[otherKey] === userId) {
      return { success: false, availableRoles: avail(), error: 'このLINEアカウントは既にもう一方の枠で登録されています。' };
    }
    if (config[otherKey] && customName === otherName) {
      return { success: false, availableRoles: avail(), error: `パートナーと同じ名前（${otherName}）は登録できません。区別できる表示名にしてください。` };
    }
    setConfigValue(key, userId);
    setConfigValue(nameKey, safeSheetStr(customName));
    const actor = { allowed: true, verified: true, name: customName, userId: userId };
    writeAudit(actor, '登録', 'メンバー', customName, null, { role: customName, slot: slot });
    return { success: true, role: customName, slot: slot };
  });
}

function actorLabel(actor) {
  return actor.verified ? actor.name : actor.name + '(デモ)';
}

// ==========================================
// 変更履歴（監査ログ・フェイルクローズ）
// ==========================================

function writeAudit(actor, action, targetType, targetId, before, after) {
  let sheet = getSheet(SHEET_NAMES.AUDIT_LOG);
  if (!sheet) {
    ensureSheet(SHEET_NAMES.AUDIT_LOG, AUDIT_HEADERS, '#B91C1C', [1]);
    sheet = getSheet(SHEET_NAMES.AUDIT_LOG);
  }
  if (!sheet) {
    throw new Error('監査ログシート（AuditLog）の作成に失敗したため処理を中断しました');
  }
  sheet.appendRow([
    nowStr(),
    safeSheetStr(actor.name),
    actor.verified ? 'TRUE' : 'FALSE',
    safeSheetStr(action),
    safeSheetStr(targetType),
    safeSheetStr(targetId),
    before ? JSON.stringify(before) : '',
    after ? JSON.stringify(after) : ''
  ]);
}

function getAuditLog(params, actor) {
  const sheet = getSheet(SHEET_NAMES.AUDIT_LOG);
  if (!sheet) return { success: true, logs: [] };
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { success: true, logs: [] };

  const limit = Math.min(Math.max(Number(params && params.limit) || 50, 1), 200);
  const targetId = params && params.targetId ? String(params.targetId) : '';
  const startRow = Math.max(2, lastRow - 999);
  const values = sheet.getRange(startRow, 1, lastRow - startRow + 1, AUDIT_HEADERS.length).getValues();

  const logs = [];
  for (let i = values.length - 1; i >= 0 && logs.length < limit; i--) {
    const r = values[i];
    if (targetId && String(r[5]) !== targetId) continue;
    logs.push({
      at: fmtDateTime(r[0]),
      actor: cleanSheetStr(r[1]),
      verified: toBool(r[2]),
      action: cleanSheetStr(r[3]),
      targetType: cleanSheetStr(r[4]),
      targetId: String(r[5]),
      before: safeJsonParse(r[6]),
      after: safeJsonParse(r[7])
    });
  }
  return { success: true, logs: logs };
}

function safeJsonParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

// ==========================================
// Webhook & Web API エントリポイント
// ==========================================

function doGet(e) {
  clearMemCache();
  try {
    if (!isDemoAllowed()) {
      return jsonOut({
        success: false,
        code: 'AUTH',
        error: 'LINEアプリ内の「ふたり家計簿」からアクセスしてください（直接URLを開いてデータを見ることはできません）'
      });
    }
    const action = (e && e.parameter && e.parameter.action) || 'getInitialData';
    if (action === 'getInitialData') {
      return jsonOut(getInitialData(e.parameter.month, { name: '未認証', verified: false }));
    }
    return jsonOut({ success: false, error: '不明なアクションです: ' + action });
  } catch (error) {
    console.error(error);
    return jsonOut({ success: false, error: '内部エラーが発生しました' });
  }
}

function doPost(e) {
  clearMemCache();
  try {
    const postData = JSON.parse(e.postData.contents);

    // 1. LINE Messaging API Webhook
    if (postData.events && Array.isArray(postData.events)) {
      handleLineWebhook(postData.events);
      return jsonOut({ status: 'ok' });
    }

    // 2. 初回メンバー登録アクション（検証済みIDトークンで登録）
    if (postData.action === 'registerMember') {
      return jsonOut(registerMemberByToken(postData.idToken, postData.data || {}));
    }

    // 3. LIFFアプリからの通常リクエスト（操作者を必ずサーバー側で確定）
    const actor = resolveActor(postData.idToken);
    if (!actor.allowed) {
      return jsonOut({
        success: false,
        code: actor.code,
        error: actor.error,
        userId: actor.userId || '',
        availableRoles: actor.availableRoles || null
      });
    }

    const data = postData.data || {};
    let result;
    switch (postData.action) {
      case 'getInitialData': result = getInitialData(data.month, actor); break;
      case 'addTransaction': result = addTransaction(data, actor); break;
      case 'updateTransaction': result = updateTransaction(data, actor); break;
      case 'deleteTransaction': result = deleteTransaction(data.id, actor); break;
      case 'addShoppingItem': result = addShoppingItem(data, actor); break;
      case 'updateShoppingItem': result = updateShoppingItem(data, actor); break;
      case 'deleteShoppingItem': result = deleteShoppingItem(data.id, actor); break;
      case 'updateMonthlyBudget': result = updateMonthlyBudget(data, actor); break;
      case 'updateFixedExpense': result = updateFixedExpense(data, actor); break;
      case 'deleteFixedExpense': result = deleteFixedExpense(data.id, actor); break;
      case 'updateCategory': result = updateCategory(data, actor); break;
      case 'updateRule': result = updateRule(data, actor); break;
      case 'updateTransferStatus': result = updateTransferStatus(data, actor); break;
      case 'updateBaseContribution': result = updateBaseContribution(data, actor); break;
      case 'scanReceipt': result = scanReceipt(data, actor); break;
      case 'saveReceipt': result = saveReceipt(data, actor); break;
      case 'searchPrices': result = searchPrices(data.query, actor); break;
      case 'getAuditLog': result = getAuditLog(data, actor); break;
      default: result = { success: false, error: '未定義のアクション: ' + postData.action };
    }
    // 書き込みアクションで returnInitialData が指定されている場合、同一リクエスト内で最新データを一括返却（通信往復を半減）
    if (result && result.success && postData.returnInitialData && postData.action !== 'getInitialData') {
      const updatedName = memberNameFromUserId(actor.userId) || actor.name;
      const freshActor = { allowed: true, verified: actor.verified, name: updatedName, userId: actor.userId };
      result.initialData = getInitialData(postData.viewMonth || data.month, freshActor);
    }
    return jsonOut(result);
  } catch (error) {
    console.error(error);
    return jsonOut({ success: false, error: error.message || '内部エラーが発生しました' });
  }
}

// ==========================================
// LINE Messaging API 処理部
// ==========================================

function handleLineWebhook(events) {
  const lineToken = SCRIPT_PROPERTIES.getProperty('LINE_CHANNEL_ACCESS_TOKEN') || '';
  if (!lineToken) {
    console.error('LINE_CHANNEL_ACCESS_TOKENが設定されていません');
    return;
  }
  events.forEach(event => {
    if (event.type === 'message' && event.message.type === 'text') {
      try {
        const replyText = processNaturalLanguageMessage(event.message.text.trim(), event.source.userId);
        sendLineReply(event.replyToken, replyText, lineToken);
      } catch (err) {
        console.error(err);
        sendLineReply(event.replyToken, '処理中にエラーが発生しました。もう一度お試しください🙏', lineToken);
      }
    }
  });
}

function setConfigValue(key, value) {
  const sheet = getSheet(SHEET_NAMES.CONFIG);
  const idx = findRowIndexById(sheet, key, 1);
  if (idx > 0) {
    sheet.getRange(idx, 2).setValue(value);
  } else {
    sheet.appendRow([safeSheetStr(key), value]);
  }
  delete _memCache.config;
}

/**
 * LINEで受信したテキストの自然言語パーサー
 */
function processNaturalLanguageMessage(text, userId) {
  // メンバー登録（Webhook偽装対策のため、REGISTER_CODE設定時のみトーク登録を許可。未設定時はLIFF画面へ誘導）
  const regMatch = text.match(/^(.{1,15})として登録(?:\s+(.+))?$/);
  if (regMatch) {
    const customName = regMatch[1].trim();
    const codeArg = (regMatch[2] || '').trim();
    const requiredCode = SCRIPT_PROPERTIES.getProperty('REGISTER_CODE');
    if (!requiredCode) {
      return `🔒 セキュリティ保護のため、アカウント登録はLINE内の「ふたり家計簿」アプリを開いて、お好きな表示名で登録ボタンを押してください✨`;
    }
    if (codeArg !== requiredCode) {
      return `合言葉が一致しません。「表示名として登録 合言葉」の形式で送信するか、LIFFアプリ画面から登録してください。`;
    }
    if (['共同', 'all', '未認証', '自動計上'].indexOf(customName) !== -1) {
      return `「${customName}」はシステム予約語のため表示名に使用できません。`;
    }
    return withLock(() => {
      clearMemCache();
      const config = getConfigData();
      const names = getMemberNames(config);
      if (config.husbandUserId === userId || config.wifeUserId === userId) {
        return 'このアカウントは既に登録されています。表示名の変更はアプリの「設定」タブから行えます。';
      }
      const slot = !config.husbandUserId ? 'husband' : (!config.wifeUserId ? 'wife' : '');
      if (!slot) {
        return '2名分の枠が既に登録済みです。変更はスプレッドシートのConfigシートで行ってください。';
      }
      const otherName = slot === 'husband' ? names.wifeName : names.husbandName;
      if ((slot === 'husband' ? config.wifeUserId : config.husbandUserId) && customName === otherName) {
        return `パートナーと同じ名前（${otherName}）は登録できません。区別できる表示名にしてください。`;
      }
      setConfigValue(slot === 'husband' ? 'husbandUserId' : 'wifeUserId', userId);
      setConfigValue(slot === 'husband' ? 'husbandName' : 'wifeName', safeSheetStr(customName));
      writeAudit({ name: customName, verified: true }, '登録', 'メンバー', customName, null, { role: customName, slot: slot });
      return `✅ このアカウントを「${customName}」として登録しました！`;
    });
  }

  const config = getConfigData();
  const names = getMemberNames(config);
  const userName = memberNameFromUserId(userId);
  const anyRegistered = !!(config.husbandUserId || config.wifeUserId);

  if (/^(ヘルプ|使い方|help)$/i.test(text)) {
    return buildHelpText();
  }

  if (!userName) {
    return anyRegistered
      ? 'このアカウントは未登録です。ご家族の設定をご確認ください。'
      : '初回設定です。リッチメニューから「ふたり家計簿」アプリを開いて、お好きなニックネームでメンバー登録してください✨';
  }
  const actor = { allowed: true, verified: true, name: userName, userId: userId };

  // 1. 残金
  if (/^(残金|予算|いくら|今月)$/.test(text)) {
    const s = calculateMonthlySummary();
    return `📊【今月の家計状況】\n` +
           `・予算: ¥${s.budget.toLocaleString()}\n` +
           `・支出合計: ¥${s.totalExpense.toLocaleString()}\n` +
           `・残り残金: ¥${s.remaining.toLocaleString()}\n` +
           `・今日使える目安: ¥${s.dailyAllowance.toLocaleString()} / 日 (残${s.daysLeft}日)\n` +
           `※詳細はアプリで確認できます✨`;
  }

  // 2. 振込額
  if (/^(振込|振込額|精算|いくら振込)$/.test(text)) {
    const t = calculateTransfers();
    return `🏦【今月の共同口座 振込予定額】\n` +
           `━━━━━━━━━━━━━━\n` +
           `🔵 ${names.husbandName}: ¥${t.husband.totalTransfer.toLocaleString()}\n` +
           ` (基本¥${t.husband.baseContribution.toLocaleString()} + 私物¥${t.husband.privateOnSharedCard.toLocaleString()} - 立替¥${t.husband.advancedForShared.toLocaleString()})\n\n` +
           `🩷 ${names.wifeName}: ¥${t.wife.totalTransfer.toLocaleString()}\n` +
           ` (基本¥${t.wife.baseContribution.toLocaleString()} + 私物¥${t.wife.privateOnSharedCard.toLocaleString()} - 立替¥${t.wife.advancedForShared.toLocaleString()})\n` +
           `━━━━━━━━━━━━━━`;
  }

  // 3. 買い物リスト追加（価格検索より先に判定し、「買う 牛乳」などを確実に処理）
  const buyMatch = text.match(/^(?:買う|買い物|買出)\s+(.+)$/);
  if (buyMatch) {
    const itemName = buyMatch[1].trim().slice(0, 50);
    addShoppingItem({ title: itemName, category: '日用品' }, actor);
    return `🛒 買い物リストに「${itemName}」を追加しました！`;
  }

  // 4. 価格検索: 「価格 ネギ」「ネギ いくら」「ネギの値段」
  const priceMatch = text.match(/^(?:価格|値段|相場)\s+(.+)$/) || text.match(/^(.+?)\s*(?:の値段|の価格|の相場|いくら)$/);
  if (priceMatch && priceMatch[1] !== '今月') {
    return buildPriceReply(priceMatch[1].trim(), actor);
  }

  // 5. 支出登録
  return parseExpenseInput(text, actor);
}

function buildHelpText() {
  return `💡【家計簿Botの使い方】\n\n` +
         `■ かんたん支出登録\n` +
         `・スーパー 3200\n` +
         `・立替 2500 ドラッグストア\n` +
         `・共同カード 私物 4800 服\n\n` +
         `■ 買い物リスト\n・買う 牛乳\n\n` +
         `■ 状況確認\n・残金\n・振込額\n\n` +
         `■ 過去の価格を調べる\n・ネギ いくら\n・価格 豆腐\n\n` +
         `📷 レシートの読み取りや初回メンバー登録はアプリ画面から行えます`;
}

function buildPriceReply(query, actor) {
  const r = searchPrices(query, actor);
  if (!r.success) return r.error;
  if (r.count === 0) return `「${query}」の購入履歴はまだありません。レシートを読み取ると記録されます📷`;
  const lines = r.history.slice(0, 5).map(h => `・${h.date} ${h.store} ¥${h.unitPrice.toLocaleString()}`);
  return `🔎「${query}」の価格履歴（${r.count}件）\n` +
         lines.join('\n') + `\n━━━━━━━━━━━━━━\n` +
         `直近 ¥${r.stats.latest.toLocaleString()} / 最安 ¥${r.stats.min.toLocaleString()} / 平均 ¥${r.stats.avg.toLocaleString()} / 最高 ¥${r.stats.max.toLocaleString()}`;
}

function parseExpenseInput(text, actor) {
  const parts = text.split(/[\s　]+/);
  if (parts.length < 2) {
    return `入力方法がわかりませんでした💦\n例:「スーパー 3200」「立替 1500 日用品」\n「ヘルプ」で使い方を表示します。`;
  }

  let amount = null;
  let paymentType = 'shared_card';
  let isShared = true;
  let payer = actor.name;
  const remainingParts = [];

  const names = getMemberNames();
  parts.forEach(part => {
    const cleanNum = part.replace(/[¥,円]/g, '');
    if (/^\d+$/.test(cleanNum) && amount === null) { amount = parseInt(cleanNum, 10); return; }
    if (part === '立替') { paymentType = 'advanced_by_user'; return; }
    if (part === '私物' || part === '個人') { isShared = false; return; }
    if (part === '共同カード') { paymentType = 'shared_card'; return; }
    if (part === names.husbandName || part === '夫' || part === 'パパ') { payer = names.husbandName; return; }
    if (part === names.wifeName || part === '妻' || part === 'ママ') { payer = names.wifeName; return; }
    remainingParts.push(part);
  });

  if (!amount || amount <= 0 || amount > 10000000) {
    return `金額を正しく読み取れませんでした。例:「スーパー 3200」`;
  }

  const title = (remainingParts.join(' ') || '未分類支出').slice(0, 50);
  const category = matchCategoryByRules(title);

  addTransaction({
    date: todayStr(), title: title, amount: amount, category: category,
    isShared: isShared, paymentType: paymentType, payer: payer, memo: 'LINE Bot登録'
  }, actor);

  let typeDesc = '共同費';
  if (!isShared && paymentType === 'shared_card') typeDesc = `⚠️共同カード私物（${payer}の振込額に加算）`;
  else if (isShared && paymentType === 'advanced_by_user') typeDesc = `✨個人立替（${payer}の振込額から控除）`;

  return `✅ 記録しました！\n━━━━━━━━━━━━━━\n品名: ${title}\n金額: ¥${amount.toLocaleString()}\nカテゴリ: ${category}\n種別: ${typeDesc}\n支払者: ${payer}\n━━━━━━━━━━━━━━`;
}

function sendLineReply(replyToken, text, token) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
    muteHttpExceptions: true
  });
}

// ==========================================
// 初期データ取得 (LIFF一括取得API)
// ==========================================

function getInitialData(targetMonth, actor) {
  const month = sanitizeMonth(targetMonth);
  const config = getConfigData();
  const names = getMemberNames(config);
  const transactions = getTransactionsForMonth(month);
  const actorSlot = resolvePayerSlot(actor.name, config) || 'husband';

  return {
    success: true,
    month: month,
    actor: { name: actor.name, slot: actorSlot, verified: !!actor.verified },
    transactions: transactions,
    receiptItems: getReceiptItemsForMonth(month),
    shoppingList: getShoppingList(),
    monthlyBudgets: getMonthlyBudgets(),
    fixedExpenses: getFixedExpenses(),
    categories: getCategories(),
    rules: getRules(),
    config: {
      husbandBaseContribution: Number(config.husbandBaseContribution) || 60000,
      wifeBaseContribution: Number(config.wifeBaseContribution) || 60000,
      husbandName: names.husbandName,
      wifeName: names.wifeName
    },
    transfers: calculateTransfers(month),
    summary: calculateMonthlySummary(month),
    monthlyTotals: getMonthlyTotals(MAX_HISTORY_MONTHS)
  };
}

// ==========================================
// 支出（Transactions）
// ==========================================

function rowToTx(row) {
  return {
    id: String(row[TX.ID]),
    date: fmtDate(row[TX.DATE]),
    title: cleanSheetStr(row[TX.TITLE]),
    amount: Number(row[TX.AMOUNT]) || 0,
    category: cleanSheetStr(row[TX.CATEGORY]),
    isShared: toBool(row[TX.IS_SHARED]),
    paymentType: String(row[TX.PAYMENT_TYPE]),
    payer: cleanSheetStr(row[TX.PAYER]),
    memo: cleanSheetStr(row[TX.MEMO] || ''),
    createdBy: cleanSheetStr(row[TX.CREATED_BY] || ''),
    createdAt: fmtDateTime(row[TX.CREATED_AT]),
    updatedBy: cleanSheetStr(row[TX.UPDATED_BY] || ''),
    updatedAt: fmtDateTime(row[TX.UPDATED_AT]),
    receiptId: String(row[TX.RECEIPT_ID] || '')
  };
}

function getAllTransactions() {
  if (_memCache.transactions) return _memCache.transactions;
  const sheet = getSheet(SHEET_NAMES.TRANSACTIONS);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  const numCols = Math.min(sheet.getLastColumn(), TX_HEADERS.length);
  const raw = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  _memCache.transactions = raw
    .filter(r => r[TX.ID])
    .map(r => {
      while (r.length < TX_HEADERS.length) r.push('');
      return rowToTx(r);
    });
  return _memCache.transactions;
}

function getTransactionsForMonth(monthStr) {
  return getAllTransactions()
    .filter(tx => tx.date.startsWith(monthStr))
    .sort((a, b) => (a.date === b.date) ? (a.createdAt < b.createdAt ? 1 : -1) : (a.date < b.date ? 1 : -1));
}

function validateTxInput(tx) {
  const amount = Number(tx.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 10000000) return { error: '金額は1円以上の整数で入力してください' };
  const title = String(tx.title || '').trim().slice(0, 50);
  if (!title) return { error: '品名を入力してください' };
  const date = tx.date || todayStr();
  if (!isValidDateStr(date)) return { error: '日付の形式が正しくありません' };
  const paymentType = tx.paymentType || 'shared_card';
  if (ALLOWED_PAYMENT_TYPES.indexOf(paymentType) === -1) return { error: '決済手段が正しくありません' };
  const config = getConfigData();
  const names = getMemberNames(config);
  const slot = resolvePayerSlot(tx.payer, config);
  if (!slot) return { error: '支払者が正しくありません' };
  const payer = slot === 'husband' ? names.husbandName : (slot === 'wife' ? names.wifeName : '共同');
  return {
    value: {
      date: date, title: title, amount: amount,
      category: String(tx.category || 'その他').slice(0, 20),
      isShared: tx.isShared !== false && String(tx.isShared) !== 'false',
      paymentType: paymentType, payer: payer,
      memo: String(tx.memo || '').slice(0, 100)
    }
  };
}

function addTransaction(tx, actor) {
  const v = validateTxInput(tx);
  if (v.error) return { success: false, error: v.error };
  return withLock(() => {
    const id = Utilities.getUuid();
    appendTxRow(id, v.value, actor, '');
    writeAudit(actor, '追加', '支出', id, null, v.value);
    return { success: true, id: id };
  });
}

function appendTxRow(id, t, actor, receiptId) {
  const sheet = getSheet(SHEET_NAMES.TRANSACTIONS);
  sheet.appendRow([
    id,
    t.date,
    safeSheetStr(t.title),
    t.amount,
    safeSheetStr(t.category),
    t.isShared,
    t.paymentType,
    safeSheetStr(t.payer),
    safeSheetStr(t.memo),
    safeSheetStr(actorLabel(actor)),
    nowStr(),
    '',
    '',
    receiptId || ''
  ]);
}

function updateTransaction(tx, actor) {
  const v = validateTxInput(tx);
  if (v.error) return { success: false, error: v.error };
  return withLock(() => {
    const sheet = getSheet(SHEET_NAMES.TRANSACTIONS);
    const rowIdx = findRowIndexById(sheet, tx.id, 1);
    if (rowIdx < 0) return { success: false, error: '対象の支出が見つかりません' };

    const beforeRow = sheet.getRange(rowIdx, 1, 1, TX_HEADERS.length).getValues()[0];
    const before = rowToTx(beforeRow);
    const next = v.value;

    // レシート由来の支出は金額・品名を固定し、日付変更時はReceipts/ReceiptItemsの日付も連動更新
    if (before.receiptId) {
      next.amount = before.amount;
      next.title = before.title;
      if (next.date !== before.date) {
        updateReceiptDate(before.receiptId, next.date);
      }
    }

    sheet.getRange(rowIdx, TX.DATE + 1, 1, 8).setValues([[
      next.date,
      safeSheetStr(next.title),
      next.amount,
      safeSheetStr(next.category),
      next.isShared,
      next.paymentType,
      safeSheetStr(next.payer),
      safeSheetStr(next.memo)
    ]]);
    sheet.getRange(rowIdx, TX.UPDATED_BY + 1, 1, 2).setValues([[safeSheetStr(actorLabel(actor)), nowStr()]]);

    writeAudit(actor, '更新', '支出', before.id, pickTxFields(before), next);
    return { success: true };
  });
}

function pickTxFields(tx) {
  return {
    date: tx.date, title: tx.title, amount: tx.amount, category: tx.category,
    isShared: tx.isShared, paymentType: tx.paymentType, payer: tx.payer, memo: tx.memo
  };
}

function deleteTransaction(id, actor) {
  return withLock(() => {
    const sheet = getSheet(SHEET_NAMES.TRANSACTIONS);
    const rowIdx = findRowIndexById(sheet, id, 1);
    if (rowIdx < 0) return { success: false, error: '削除対象が見つかりません' };

    const before = rowToTx(sheet.getRange(rowIdx, 1, 1, TX_HEADERS.length).getValues()[0]);
    const auditBefore = Object.assign({}, before);
    if (before.receiptId) {
      auditBefore.items = getAllReceiptItems()
        .filter(it => it.receiptId === before.receiptId)
        .map(it => ({ name: it.name, quantity: it.quantity, price: it.price }));
      deleteReceiptRows(before.receiptId);
    }
    sheet.deleteRow(rowIdx);

    // 削除後もレシート明細を含めて内容を追跡できるよう、全情報を監査ログに残す
    writeAudit(actor, '削除', '支出', before.id, auditBefore, null);
    return { success: true };
  });
}

// ==========================================
// 月別集計（折れ線グラフ用・過去36ヶ月）
// ==========================================

function getMonthlyTotals(count) {
  const n = Math.min(Math.max(Number(count) || MAX_HISTORY_MONTHS, 1), MAX_HISTORY_MONTHS);
  const config = getConfigData();
  const names = getMemberNames(config);
  const [cy, cm] = currentMonthStr().split('-').map(Number);
  const map = {};
  const order = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(cy, cm - 1 - i, 1);
    const m = `${d.getFullYear()}-${ ('0' + (d.getMonth() + 1)).slice(-2) }`;
    const personalObj = { husband: 0, wife: 0, '夫': 0, '妻': 0 };
    personalObj[names.husbandName] = 0;
    personalObj[names.wifeName] = 0;
    map[m] = { month: m, shared: 0, personal: personalObj, budget: resolveBudget(m) };
    order.push(m);
  }
  getAllTransactions().forEach(tx => {
    const bucket = map[tx.date.slice(0, 7)];
    if (!bucket) return;
    if (tx.isShared) {
      bucket.shared += tx.amount;
    } else {
      const slot = resolvePayerSlot(tx.payer, config);
      if (slot === 'husband') {
        bucket.personal.husband += tx.amount;
        bucket.personal['夫'] += tx.amount;
        bucket.personal[names.husbandName] = bucket.personal.husband;
      } else if (slot === 'wife') {
        bucket.personal.wife += tx.amount;
        bucket.personal['妻'] += tx.amount;
        bucket.personal[names.wifeName] = bucket.personal.wife;
      }
    }
  });
  return order.map(m => map[m]);
}

// ==========================================
// 買い物リスト
// ==========================================

function getShoppingList() {
  if (_memCache.shoppingList) return _memCache.shoppingList;
  const sheet = getSheet(SHEET_NAMES.SHOPPING_LIST);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  _memCache.shoppingList = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues().filter(r => r[0]).map(row => ({
    id: String(row[0]),
    title: cleanSheetStr(row[1]),
    category: cleanSheetStr(row[2]),
    isCompleted: toBool(row[3]),
    requestedBy: cleanSheetStr(row[4]),
    createdAt: fmtDate(row[5])
  }));
  return _memCache.shoppingList;
}

function addShoppingItem(item, actor) {
  const title = String(item.title || '').trim().slice(0, 50);
  if (!title) return { success: false, error: '品名を入力してください' };
  return withLock(() => {
    const id = Utilities.getUuid();
    getSheet(SHEET_NAMES.SHOPPING_LIST).appendRow([
      id, safeSheetStr(title), safeSheetStr(String(item.category || '日用品').slice(0, 20)), false, safeSheetStr(actor.name), todayStr()
    ]);
    return { success: true, id: id };
  });
}

function updateShoppingItem(item) {
  return withLock(() => {
    const sheet = getSheet(SHEET_NAMES.SHOPPING_LIST);
    const idx = findRowIndexById(sheet, item.id, 1);
    if (idx < 0) return { success: false, error: 'アイテムが見つかりません' };
    sheet.getRange(idx, 2, 1, 3).setValues([[
      safeSheetStr(String(item.title || '').slice(0, 50)),
      safeSheetStr(String(item.category || '日用品').slice(0, 20)),
      toBool(item.isCompleted)
    ]]);
    return { success: true };
  });
}

function deleteShoppingItem(id) {
  return withLock(() => {
    const sheet = getSheet(SHEET_NAMES.SHOPPING_LIST);
    const idx = findRowIndexById(sheet, id, 1);
    if (idx < 0) return { success: false, error: '削除対象が見つかりません' };
    sheet.deleteRow(idx);
    return { success: true };
  });
}

// ==========================================
// 振込・予算計算
// ==========================================

function paidKey(month, slot) {
  return 'paid_' + month + '_' + slot;
}

function isSlotPaid(config, monthStr, slot) {
  const legacyWho = slot === 'husband' ? '夫' : '妻';
  if (config[paidKey(monthStr, slot)] !== undefined) return toBool(config[paidKey(monthStr, slot)]);
  return toBool(config[paidKey(monthStr, legacyWho)]);
}

function calculateTransfers(targetMonth) {
  const monthStr = sanitizeMonth(targetMonth);
  const config = getConfigData();
  const txs = getTransactionsForMonth(monthStr);

  const hBase = Number(config.husbandBaseContribution) || 60000;
  const wBase = Number(config.wifeBaseContribution) || 60000;
  const acc = { husband: { priv: 0, adv: 0 }, wife: { priv: 0, adv: 0 } };

  txs.forEach(tx => {
    const slot = resolvePayerSlot(tx.payer, config);
    if (slot !== 'husband' && slot !== 'wife') return;
    if (!tx.isShared && tx.paymentType === 'shared_card') acc[slot].priv += tx.amount;
    if (tx.isShared && tx.paymentType === 'advanced_by_user') acc[slot].adv += tx.amount;
  });

  const build = (base, slot) => ({
    baseContribution: base,
    privateOnSharedCard: acc[slot].priv,
    advancedForShared: acc[slot].adv,
    totalTransfer: Math.max(0, base + acc[slot].priv - acc[slot].adv),
    isPaid: isSlotPaid(config, monthStr, slot)
  });
  return { month: monthStr, husband: build(hBase, 'husband'), wife: build(wBase, 'wife') };
}

function resolveBudget(monthStr) {
  const budgets = getMonthlyBudgets();
  const exact = budgets.find(b => b.month === monthStr);
  if (exact) return exact.amount;
  const earlier = budgets.filter(b => b.month < monthStr).sort((a, b) => (a.month < b.month ? 1 : -1));
  return earlier.length ? earlier[0].amount : DEFAULT_BUDGET;
}

function calculateMonthlySummary(targetMonth) {
  const monthStr = sanitizeMonth(targetMonth);
  const isCurrentMonth = monthStr === currentMonthStr();
  const budgetAmount = resolveBudget(monthStr) || DEFAULT_BUDGET;

  const totalExpense = getTransactionsForMonth(monthStr).filter(t => t.isShared).reduce((s, t) => s + t.amount, 0);
  const remaining = budgetAmount - totalExpense;

  const [year, month] = monthStr.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const todayDay = Number(Utilities.formatDate(new Date(), TZ, 'd'));
  const daysLeft = isCurrentMonth ? Math.max(1, lastDay - todayDay + 1) : 0;

  return {
    month: monthStr,
    isCurrentMonth: isCurrentMonth,
    budget: budgetAmount,
    totalExpense: totalExpense,
    remaining: remaining,
    progressRate: Math.min(100, Math.round((totalExpense / budgetAmount) * 100)),
    daysLeft: daysLeft,
    dailyAllowance: isCurrentMonth ? Math.max(0, Math.floor(remaining / daysLeft)) : 0
  };
}

// ==========================================
// マスタ・設定データ
// ==========================================

function getMonthlyBudgets() {
  if (_memCache.budgets) return _memCache.budgets;
  const sheet = getSheet(SHEET_NAMES.MONTHLY_BUDGETS);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  _memCache.budgets = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().filter(r => r[0]).map(r => ({
    month: String(r[0]).slice(0, 7),
    amount: Number(r[1]) || 0,
    note: cleanSheetStr(r[2] || '')
  }));
  return _memCache.budgets;
}

function updateMonthlyBudget(data, actor) {
  const amount = Number(data.amount);
  if (!/^\d{4}-\d{2}$/.test(String(data.month || '')) || !Number.isInteger(amount) || amount <= 0) {
    return { success: false, error: '予算の入力値が正しくありません' };
  }
  return withLock(() => {
    const sheet = getSheet(SHEET_NAMES.MONTHLY_BUDGETS);
    const idx = findRowIndexById(sheet, data.month, 1);
    const before = getMonthlyBudgets().find(b => b.month === data.month) || null;
    const note = safeSheetStr(String(data.note || '').slice(0, 50));
    if (idx > 0) {
      sheet.getRange(idx, 2, 1, 2).setValues([[amount, note]]);
    } else {
      sheet.appendRow([data.month, amount, note]);
    }
    writeAudit(actor, '更新', '月予算', data.month, before, { month: data.month, amount: amount });
    return { success: true };
  });
}

function getFixedExpenses() {
  if (_memCache.fixedExpenses) return _memCache.fixedExpenses;
  const sheet = getSheet(SHEET_NAMES.FIXED_EXPENSES);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  _memCache.fixedExpenses = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues().filter(r => r[0]).map(r => ({
    id: String(r[0]),
    title: cleanSheetStr(r[1]),
    amount: Number(r[2]) || 0,
    category: cleanSheetStr(r[3]),
    billingDay: Number(r[4]) || 1,
    isActive: toBool(r[5]),
    payer: cleanSheetStr(r[6] || '共同カード')
  }));
  return _memCache.fixedExpenses;
}

function updateFixedExpense(item, actor) {
  const amount = Number(item.amount);
  const title = String(item.title || '').trim().slice(0, 50);
  if (!title || !Number.isInteger(amount) || amount <= 0) return { success: false, error: '固定費の入力値が正しくありません' };
  return withLock(() => {
    const sheet = getSheet(SHEET_NAMES.FIXED_EXPENSES);
    const id = item.id || Utilities.getUuid();
    const billingDay = Math.min(31, Math.max(1, Number(item.billingDay) || 1));
    const category = String(item.category || 'その他').slice(0, 20);
    const isActive = item.isActive !== false;
    const payer = String(item.payer || '共同カード').slice(0, 20);
    const row = [id, safeSheetStr(title), amount, safeSheetStr(category), billingDay, isActive, safeSheetStr(payer)];
    const existing = item.id ? getFixedExpenses().find(f => f.id === String(item.id)) : null;
    const idx = item.id ? findRowIndexById(sheet, item.id, 1) : -1;
    if (idx > 0) sheet.getRange(idx, 1, 1, 7).setValues([row]);
    else sheet.appendRow(row);
    if (actor) {
      writeAudit(actor, existing ? '更新' : '追加', '固定費', id, existing, { title: title, amount: amount, category: category, billingDay: billingDay, isActive: isActive });
    }
    return { success: true, id: id };
  });
}

function deleteFixedExpense(id, actor) {
  return withLock(() => {
    const sheet = getSheet(SHEET_NAMES.FIXED_EXPENSES);
    const idx = findRowIndexById(sheet, id, 1);
    if (idx < 0) return { success: false, error: '削除対象の固定費が見つかりません' };
    const existing = getFixedExpenses().find(f => f.id === String(id)) || null;
    sheet.deleteRow(idx);
    if (actor) writeAudit(actor, '削除', '固定費', id, existing, null);
    return { success: true };
  });
}

function getCategories() {
  if (_memCache.categories) return _memCache.categories;
  const sheet = getSheet(SHEET_NAMES.CATEGORIES);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  _memCache.categories = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().filter(r => r[0]).map(r => ({
    name: cleanSheetStr(r[0]), color: String(r[1]), icon: String(r[2])
  }));
  return _memCache.categories;
}

function updateCategory(item, actor) {
  const name = String(item.name || '').trim().slice(0, 20);
  if (!name) return { success: false, error: 'カテゴリ名を入力してください' };
  return withLock(() => {
    const sheet = getSheet(SHEET_NAMES.CATEGORIES);
    const idx = findRowIndexById(sheet, name, 1);
    const color = /^#[0-9a-fA-F]{6}$/.test(item.color || '') ? item.color : '#6B7280';
    const icon = String(item.icon || 'tag').slice(0, 30);
    const row = [safeSheetStr(name), color, safeSheetStr(icon)];
    if (idx > 0) sheet.getRange(idx, 1, 1, 3).setValues([row]);
    else sheet.appendRow(row);
    if (actor) writeAudit(actor, idx > 0 ? '更新' : '追加', 'カテゴリ', name, null, { title: name, color: color });
    return { success: true };
  });
}

function getRules() {
  if (_memCache.rules) return _memCache.rules;
  const sheet = getSheet(SHEET_NAMES.RULES);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  _memCache.rules = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().filter(r => r[0]).map(r => ({
    keyword: cleanSheetStr(r[0]), category: cleanSheetStr(r[1])
  }));
  return _memCache.rules;
}

function updateRule(item, actor) {
  const keyword = String(item.keyword || '').trim().slice(0, 30);
  const category = String(item.category || '').trim().slice(0, 20);
  if (!keyword || !category) return { success: false, error: 'キーワードとカテゴリを入力してください' };
  return withLock(() => {
    const sheet = getSheet(SHEET_NAMES.RULES);
    const idx = findRowIndexById(sheet, keyword, 1);
    if (idx > 0) sheet.getRange(idx, 2).setValue(safeSheetStr(category));
    else sheet.appendRow([safeSheetStr(keyword), safeSheetStr(category)]);
    if (actor) writeAudit(actor, idx > 0 ? '更新' : '追加', '仕分けルール', keyword, null, { keyword: keyword, category: category });
    return { success: true };
  });
}

function matchCategoryByRules(title) {
  const rules = getRules();
  for (const rule of rules) {
    if (title.indexOf(rule.keyword) !== -1) return rule.category;
  }
  return '日用品';
}

function getConfigData() {
  if (_memCache.config) return _memCache.config;
  const sheet = getSheet(SHEET_NAMES.CONFIG);
  const config = {
    husbandBaseContribution: 60000, wifeBaseContribution: 60000,
    husbandUserId: '', wifeUserId: '',
    husbandName: 'メンバー1', wifeName: 'メンバー2'
  };
  if (!sheet || sheet.getLastRow() <= 1) return config;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(r => {
    if (r[0]) config[String(r[0])] = r[1];
  });
  _memCache.config = config;
  return config;
}

function updateTransferStatus(data, actor) {
  const config = getConfigData();
  const slot = resolvePayerSlot(data && (data.slot || data.payer), config);
  if (!/^\d{4}-\d{2}$/.test(String(data.month || '')) || (slot !== 'husband' && slot !== 'wife')) {
    return { success: false, error: '入力値が正しくありません' };
  }
  return withLock(() => {
    clearMemCache();
    const cfg = getConfigData();
    const names = getMemberNames(cfg);
    const displayPayer = slot === 'husband' ? names.husbandName : names.wifeName;
    const key = paidKey(data.month, slot);
    const beforePaid = isSlotPaid(cfg, data.month, slot);
    const nextPaid = toBool(data.isPaid);
    setConfigValue(key, nextPaid);
    writeAudit(actor, '更新', '振込状況', data.month + ':' + displayPayer, { payer: displayPayer, isPaid: beforePaid }, { payer: displayPayer, isPaid: nextPaid });
    return { success: true };
  });
}

function updateBaseContribution(data, actor) {
  const hv = Number(data.husband);
  const wv = Number(data.wife);
  if (!Number.isInteger(hv) || !Number.isInteger(wv) || hv < 0 || wv < 0 || hv > 10000000 || wv > 10000000) {
    return { success: false, error: '基本拠出額が正しくありません' };
  }
  return withLock(() => {
    clearMemCache();
    const before = getConfigData();
    const beforeNames = getMemberNames(before);
    const hName = data.husbandName !== undefined ? String(data.husbandName || '').trim().slice(0, 15) : beforeNames.husbandName;
    const wName = data.wifeName !== undefined ? String(data.wifeName || '').trim().slice(0, 15) : beforeNames.wifeName;
    if (!hName || !wName) {
      return { success: false, error: 'ふたりの表示名を1〜15文字で入力してください' };
    }
    if (hName === wName) {
      return { success: false, error: 'ふたりの表示名は異なる名前にしてください' };
    }
    if (['共同', 'all', '未認証', '自動計上'].indexOf(hName) !== -1 || ['共同', 'all', '未認証', '自動計上'].indexOf(wName) !== -1) {
      return { success: false, error: 'システム予約語（共同 など）は表示名に使用できません' };
    }
    const prevObj = {
      husbandName: beforeNames.husbandName,
      wifeName: beforeNames.wifeName,
      husband: Number(before.husbandBaseContribution) || 60000,
      wife: Number(before.wifeBaseContribution) || 60000
    };
    setConfigValue('husbandBaseContribution', hv);
    setConfigValue('wifeBaseContribution', wv);
    setConfigValue('husbandName', safeSheetStr(hName));
    setConfigValue('wifeName', safeSheetStr(wName));
    if (beforeNames.husbandName !== hName) renamePayerInSheets(beforeNames.husbandName, hName);
    if (beforeNames.wifeName !== wName) renamePayerInSheets(beforeNames.wifeName, wName);
    writeAudit(actor, '更新', 'メンバー・基本拠出設定', 'base', prevObj, { husbandName: hName, wifeName: wName, husband: hv, wife: wv });
    return { success: true };
  });
}

function renamePayerInSheets(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const txSheet = getSheet(SHEET_NAMES.TRANSACTIONS);
  if (txSheet && txSheet.getLastRow() > 1) {
    const numRows = txSheet.getLastRow() - 1;
    const payers = txSheet.getRange(2, TX.PAYER + 1, numRows, 1).getValues();
    let changed = false;
    for (let i = 0; i < payers.length; i++) {
      if (cleanSheetStr(payers[i][0]) === oldName) {
        payers[i][0] = safeSheetStr(newName);
        changed = true;
      }
    }
    if (changed) txSheet.getRange(2, TX.PAYER + 1, numRows, 1).setValues(payers);
  }
  delete _memCache.transactions;
}

// ==========================================
// レシート OCR（Gemini API）
// ==========================================

function scanReceipt(data, actor) {
  // 未認証でのAPIキー消費を防ぐため、本人確認済みまたは明示的DEMO_MODEのみ許可
  if ((!actor || !actor.verified) && !isDemoAllowed()) {
    return { success: false, code: 'AUTH', error: 'レシート読み取りにはLINEログインとメンバー登録が必要です' };
  }
  const apiKey = SCRIPT_PROPERTIES.getProperty('GEMINI_API_KEY');
  if (!apiKey) return { success: false, error: 'GEMINI_API_KEY が未設定です（README Step 7参照）' };

  const mime = String(data.mimeType || 'image/jpeg');
  const b64 = String(data.imageBase64 || '');
  if (['image/jpeg', 'image/png', 'image/webp'].indexOf(mime) === -1) return { success: false, error: '対応していない画像形式です' };
  if (!b64 || b64.length > 7000000) return { success: false, error: '画像が空、または大きすぎます（縮小して再試行してください）' };

  const userModel = (SCRIPT_PROPERTIES.getProperty('GEMINI_MODEL') || '').trim();
  const modelsToTry = [];
  [userModel, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'].forEach(m => {
    const clean = String(m || '').replace(/^models\//i, '').trim();
    if (clean && modelsToTry.indexOf(clean) === -1) modelsToTry.push(clean);
  });

  const prompt =
    'これは日本のレシート画像です。店名、購入日、明細を読み取ってください。\n' +
    '- price は「その行の税込合計金額（数量×単価）」の整数円。値引き・割引行は負の整数で別の明細にする。\n' +
    '- quantity は数量（不明なら1）。\n' +
    '- 品名はレシート表記のまま。ポイント・小計・合計・お釣り・税額の行は明細に含めない。\n' +
    '- date は yyyy-MM-dd。読み取れなければ空文字。\n' +
    '- total はレシートに印字された支払合計（税込）の整数円。読み取れなければ0。';

  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0,
      responseSchema: {
        type: 'OBJECT',
        properties: {
          store: { type: 'STRING' },
          date: { type: 'STRING' },
          total: { type: 'INTEGER' },
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { name: { type: 'STRING' }, quantity: { type: 'INTEGER' }, price: { type: 'INTEGER' } },
              required: ['name', 'quantity', 'price']
            }
          }
        },
        required: ['store', 'date', 'total', 'items']
      }
    }
  };

  let res = null;
  let code = 0;
  let lastTriedModel = modelsToTry[0];
  for (let i = 0; i < modelsToTry.length; i++) {
    lastTriedModel = modelsToTry[i];
    res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(lastTriedModel) + ':generateContent',
      {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': apiKey.trim() },
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      }
    );
    code = res.getResponseCode();
    if (code === 200) break;
    console.warn('Gemini try failed (' + lastTriedModel + '): ' + code + ' ' + res.getContentText());
    if (code !== 404) break; // 404（モデル名不一致・未対応）は次の候補モデルで自動リトライ
  }

  if (code !== 200) {
    let detail = '';
    try {
      const errJson = JSON.parse(res.getContentText());
      if (errJson && errJson.error && errJson.error.message) detail = errJson.error.message;
    } catch (_) {}
    if (code === 404) {
      return {
        success: false,
        error: 'AIモデル（' + lastTriedModel + '）が見つかりません(404)。GASのスクリプトプロパティ GEMINI_MODEL を空欄にするか gemini-2.5-flash に変更してください'
      };
    }
    if (code === 400 || code === 403) {
      return {
        success: false,
        error: 'GEMINI_API_KEY が無効か権限がありません(' + code + ')。Google AI Studioで発行したキーか確認してください'
      };
    }
    if (code === 429) {
      return {
        success: false,
        error: 'AIの利用上限(429)に達しました。1分ほど待ってから再試行してください'
      };
    }
    return {
      success: false,
      error: 'AI読み取りに失敗しました（' + code + (detail ? ': ' + detail.slice(0, 60) : '') + '）'
    };
  }

  let parsed;
  try {
    const json = JSON.parse(res.getContentText());
    parsed = JSON.parse(json.candidates[0].content.parts[0].text);
  } catch (err) {
    console.error(err);
    return { success: false, error: 'レシートを読み取れませんでした。明るい場所でまっすぐ撮影してください' };
  }

  const items = (parsed.items || []).slice(0, 60).map(it => ({
    name: String(it.name || '').trim().slice(0, 50),
    quantity: Math.min(99, Math.max(1, parseInt(it.quantity, 10) || 1)),
    price: parseInt(it.price, 10) || 0
  })).filter(it => it.name && it.price !== 0);

  return {
    success: true,
    receipt: {
      store: String(parsed.store || '').trim().slice(0, 50),
      date: isValidDateStr(parsed.date) ? parsed.date : todayStr(),
      total: parseInt(parsed.total, 10) || 0,
      items: items
    }
  };
}

/**
 * 確認済みのレシートを保存する。
 * Receipts / ReceiptItems に明細を保存し、支出一覧用に店名単位の支出を1件登録する
 */
function saveReceipt(data, actor) {
  const store = String(data.store || '').trim().slice(0, 50);
  if (!store) return { success: false, error: '店名を入力してください' };
  const date = data.date || todayStr();
  if (!isValidDateStr(date)) return { success: false, error: '日付の形式が正しくありません' };
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 60) {
    return { success: false, error: '明細は1〜60件で入力してください' };
  }

  const items = [];
  for (const it of data.items) {
    const name = String(it.name || '').trim().slice(0, 50);
    const qty = Number(it.quantity);
    const price = Number(it.price);
    if (!name) return { success: false, error: '品名が空の明細があります' };
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) return { success: false, error: '数量が正しくありません: ' + name };
    if (!Number.isInteger(price) || price === 0 || Math.abs(price) > 1000000) return { success: false, error: '金額が正しくありません: ' + name };
    items.push({ name: name, qty: qty, price: price });
  }
  const total = items.reduce((s, it) => s + it.price, 0);
  if (total <= 0) return { success: false, error: '合計金額が0円以下です' };

  const tx = validateTxInput({
    date: date, title: store, amount: total, category: data.category,
    isShared: data.isShared, paymentType: data.paymentType, payer: data.payer, memo: 'レシート読み取り'
  });
  if (tx.error) return { success: false, error: tx.error };

  return withLock(() => {
    const receiptId = Utilities.getUuid();
    const txId = Utilities.getUuid();

    getSheet(SHEET_NAMES.RECEIPTS).appendRow([
      receiptId, date, safeSheetStr(store), total, safeSheetStr(tx.value.payer), safeSheetStr(actorLabel(actor)), nowStr()
    ]);

    const itemRows = items.map(it => [
      Utilities.getUuid(), receiptId, date, safeSheetStr(store), safeSheetStr(it.name), normalizeName(it.name),
      it.qty, it.price, Math.round(it.price / it.qty)
    ]);
    const itemSheet = getSheet(SHEET_NAMES.RECEIPT_ITEMS);
    itemSheet.getRange(itemSheet.getLastRow() + 1, 1, itemRows.length, RECEIPT_ITEM_HEADERS.length).setValues(itemRows);

    appendTxRow(txId, tx.value, actor, receiptId);
    // 支出の変更履歴モーダル（targetId = txId）からも追跡できるよう txId を記録
    writeAudit(actor, '追加', 'レシート', txId, null, {
      receiptId: receiptId, date: date, title: store, amount: total,
      category: tx.value.category, isShared: tx.value.isShared, paymentType: tx.value.paymentType, payer: tx.value.payer,
      items: items.map(i => ({ name: i.name, quantity: i.qty, price: i.price }))
    });
    return { success: true, receiptId: receiptId, txId: txId, total: total };
  });
}

function updateReceiptDate(receiptId, newDate) {
  const rSheet = getSheet(SHEET_NAMES.RECEIPTS);
  const rIdx = findRowIndexById(rSheet, receiptId, 1);
  if (rIdx > 0) rSheet.getRange(rIdx, 2).setValue(newDate);

  const itemSheet = getSheet(SHEET_NAMES.RECEIPT_ITEMS);
  if (itemSheet && itemSheet.getLastRow() > 1) {
    const ids = itemSheet.getRange(2, 2, itemSheet.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === receiptId) {
        itemSheet.getRange(i + 2, 3).setValue(newDate);
      }
    }
  }
}

function deleteReceiptRows(receiptId) {
  const itemSheet = getSheet(SHEET_NAMES.RECEIPT_ITEMS);
  if (itemSheet && itemSheet.getLastRow() > 1) {
    const ids = itemSheet.getRange(2, 2, itemSheet.getLastRow() - 1, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0]) === receiptId) itemSheet.deleteRow(i + 2);
    }
  }
  const rSheet = getSheet(SHEET_NAMES.RECEIPTS);
  const idx = findRowIndexById(rSheet, receiptId, 1);
  if (idx > 0) rSheet.deleteRow(idx);
}

function getAllReceiptItems() {
  if (_memCache.receiptItems) return _memCache.receiptItems;
  const sheet = getSheet(SHEET_NAMES.RECEIPT_ITEMS);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  _memCache.receiptItems = sheet.getRange(2, 1, sheet.getLastRow() - 1, RECEIPT_ITEM_HEADERS.length).getValues()
    .filter(r => r[0])
    .map(r => ({
      id: String(r[0]), receiptId: String(r[1]), date: fmtDate(r[2]), store: cleanSheetStr(r[3]),
      name: cleanSheetStr(r[4]), normName: String(r[5]), quantity: Number(r[6]) || 1,
      price: Number(r[7]) || 0, unitPrice: Number(r[8]) || 0
    }));
  return _memCache.receiptItems;
}

function getReceiptItemsForMonth(monthStr) {
  return getAllReceiptItems().filter(it => it.date.startsWith(monthStr)).map(it => ({
    receiptId: it.receiptId, name: it.name, quantity: it.quantity, price: it.price, unitPrice: it.unitPrice
  }));
}

/**
 * 品名の部分一致で過去の購入価格を検索（全期間）
 * - 値引き行（price <= 0）は統計汚染を防ぐため除外
 * - パートナーの私物レシート（!isShared && payer !== actor.name）はプライバシー保護のため除外
 */
function searchPrices(query, actor) {
  const q = normalizeName(query);
  if (!q) return { success: false, error: '検索する品名を入力してください' };

  // レシートIDごとの公開可否マップを作成（他人の私物レシートを除外）
  const privateOtherReceipts = {};
  if (actor && actor.name) {
    const config = getConfigData();
    const actorSlot = resolvePayerSlot(actor.name, config);
    getAllTransactions().forEach(tx => {
      const txSlot = resolvePayerSlot(tx.payer, config);
      if (tx.receiptId && !tx.isShared && txSlot !== actorSlot && tx.payer !== actor.name) {
        privateOtherReceipts[tx.receiptId] = true;
      }
    });
  }

  const matched = getAllReceiptItems()
    .filter(it => it.price > 0 && it.unitPrice > 0 && !privateOtherReceipts[it.receiptId] && it.normName.indexOf(q) !== -1)
    .sort((a, b) => (a.date < b.date ? 1 : (a.date > b.date ? -1 : 0)));

  if (matched.length === 0) return { success: true, query: query, count: 0, stats: null, byStore: [], history: [] };

  const prices = matched.map(m => m.unitPrice);
  const stats = {
    latest: matched[0].unitPrice,
    min: Math.min.apply(null, prices),
    max: Math.max.apply(null, prices),
    avg: Math.round(prices.reduce((s, p) => s + p, 0) / prices.length)
  };

  const storeMap = {};
  matched.forEach(m => {
    if (!storeMap[m.store]) storeMap[m.store] = { store: m.store, latest: m.unitPrice, latestDate: m.date, min: m.unitPrice, count: 0 };
    const s = storeMap[m.store];
    s.min = Math.min(s.min, m.unitPrice);
    s.count++;
  });

  return {
    success: true, query: query, count: matched.length, stats: stats,
    byStore: Object.keys(storeMap).map(k => storeMap[k]).sort((a, b) => a.min - b.min),
    history: matched.slice(0, 100).map(m => ({
      date: m.date, store: m.store, name: m.name, quantity: m.quantity, price: m.price, unitPrice: m.unitPrice
    }))
  };
}

// ==========================================
// 初期化・マイグレーション
// ==========================================

/**
 * シートが無ければ作成し、ヘッダーを揃える（既存データは消さない・何度実行しても安全）
 * @return {boolean} 新規作成した場合 true
 */
function ensureSheet(name, headers, color, textColumns) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(name);
  let created = false;
  if (!sheet) {
    sheet = ss.insertSheet(name);
    created = true;
    if (_memCache._sheets) _memCache._sheets[name] = sheet;
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setBackground(color).setFontColor('#FFFFFF').setFontWeight('bold');
  // 新規作成時のみ日付・日時列の書式を文字列に設定（既存シートのDate型データをシリアル値化しないため）
  if (created && textColumns && textColumns.length) {
    textColumns.forEach(col => sheet.getRange(1, col, sheet.getMaxRows(), 1).setNumberFormat('@'));
  }
  return created;
}

function setupSpreadsheet() {
  clearMemCache();
  ensureSheet(SHEET_NAMES.TRANSACTIONS, TX_HEADERS, '#2563EB', [2, 11, 13]);
  ensureSheet(SHEET_NAMES.RECEIPTS, RECEIPT_HEADERS, '#0891B2', [2, 7]);
  ensureSheet(SHEET_NAMES.RECEIPT_ITEMS, RECEIPT_ITEM_HEADERS, '#0E7490', [3]);
  ensureSheet(SHEET_NAMES.AUDIT_LOG, AUDIT_HEADERS, '#B91C1C', [1]);

  ensureSheet(SHEET_NAMES.SHOPPING_LIST, ['ID', '品名', 'カテゴリ', '完了フラグ', '依頼者', '登録日'], '#059669', [6]);

  if (ensureSheet(SHEET_NAMES.MONTHLY_BUDGETS, ['月', '予算額', '備考'], '#4F46E5', [1])) {
    getSheet(SHEET_NAMES.MONTHLY_BUDGETS).appendRow([currentMonthStr(), DEFAULT_BUDGET, '通常月予算']);
  }

  if (ensureSheet(SHEET_NAMES.FIXED_EXPENSES, ['ID', '項目名', '金額', 'カテゴリ', '引落日', '有効フラグ', '支払元'], '#7C3AED')) {
    const s = getSheet(SHEET_NAMES.FIXED_EXPENSES);
    s.appendRow([Utilities.getUuid(), '家賃', 110000, '住居費', 27, true, '共同口座']);
    s.appendRow([Utilities.getUuid(), '光熱費 (電気・ガス)', 15000, '水道光熱費', 20, true, '共同カード']);
    s.appendRow([Utilities.getUuid(), 'ネット回線 (光)', 5200, '通信費', 15, true, '共同カード']);
  }

  if (ensureSheet(SHEET_NAMES.CATEGORIES, ['カテゴリ名', 'テーマカラー', 'アイコン'], '#EA580C')) {
    const s = getSheet(SHEET_NAMES.CATEGORIES);
    [['食費', '#10B981', 'utensils'], ['日用品', '#3B82F6', 'shopping-bag'], ['外食', '#F59E0B', 'coffee'],
     ['住居費', '#6366F1', 'home'], ['水道光熱費', '#06B6D4', 'zap'], ['通信費', '#8B5CF6', 'wifi'],
     ['趣味・衣服', '#EC4899', 'heart'], ['その他', '#6B7280', 'more-horizontal']].forEach(r => s.appendRow(r));
  }

  if (ensureSheet(SHEET_NAMES.RULES, ['キーワード', '対応カテゴリ'], '#D97706')) {
    const s = getSheet(SHEET_NAMES.RULES);
    [['スーパー', '食費'], ['イオン', '食費'], ['ライフ', '食費'], ['ランチ', '外食'], ['ディナー', '外食'], ['カフェ', '外食'],
     ['ドラッグストア', '日用品'], ['薬局', '日用品'], ['コンビニ', '食費']].forEach(r => s.appendRow(r));
  }

  ensureSheet(SHEET_NAMES.CONFIG, ['設定項目', '設定値'], '#374151');
  const configSheet = getSheet(SHEET_NAMES.CONFIG);
  const existingKeys = configSheet.getLastRow() > 1
    ? configSheet.getRange(2, 1, configSheet.getLastRow() - 1, 1).getValues().map(r => String(r[0]))
    : [];
  [['husbandBaseContribution', 60000], ['wifeBaseContribution', 60000], ['husbandUserId', ''], ['wifeUserId', ''], ['husbandName', 'メンバー1'], ['wifeName', 'メンバー2']]
    .forEach(r => { if (existingKeys.indexOf(r[0]) === -1) configSheet.appendRow(r); });

  console.log('✅ スプレッドシートの初期化/更新が完了しました（既存データは保持されています）');
}

/**
 * 毎月1日に自動実行される固定費自動計上トリガー関数（二重計上防止付き）
 */
function processMonthlyFixedExpenses() {
  clearMemCache();
  const month = currentMonthStr();
  const firstDay = month + '-01';
  const posted = getTransactionsForMonth(month).filter(t => t.memo === '固定費自動計上').map(t => t.title);

  let count = 0;
  getFixedExpenses().forEach(item => {
    const title = '【固定費】' + item.title;
    if (!item.isActive || posted.indexOf(title) !== -1) return;
    addTransaction({
      date: firstDay, title: title, amount: item.amount, category: item.category,
      isShared: true, paymentType: 'shared_card', payer: '共同', memo: '固定費自動計上'
    }, SYSTEM_ACTOR);
    count++;
  });
  console.log(`✅ ${firstDay}: 固定費 ${count} 件を自動計上しました`);
}
