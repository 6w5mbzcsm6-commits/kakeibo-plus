/**
 * ふたり家計簿 (PairBudget) - Vercel Serverless Function
 * 単一エンドポイント (/api/budget)
 * Supabase PostgreSQL + Gemini API + LINE Messaging API
 * マルチペア対応（世帯分離）＆ 臨時イベント精算（30日TTLパージ・最小送金回数アルゴリズム）
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

// Vercel Serverless Function タイムアウト設定 (最大60秒)
export const maxDuration = 60;

// ==========================================
// 定数・環境変数
// ==========================================
const DEFAULT_BUDGET = 240000;
const MAX_HISTORY_MONTHS = 36;
const DEFAULT_PAIR_ID = '00000000-0000-0000-0000-000000000001';
const ALLOWED_PAYMENT_TYPES = [
  'shared_card',
  'advanced_by_user',
  'personal_advance',
  'personal_cash',
  'personal_self'
];

/**
 * 環境変数キー・シークレットの正規化（前後の空白・クォーテーションの自動除去）
 */
function normalizeEnvSecret(rawKey) {
  if (!rawKey) return '';
  let str = String(rawKey).trim();
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }
  return str;
}

/**
 * Supabase URLの自動補正（ダッシュボードURLやプロジェクトIDの自動変換、フォールバックURL）
 */
function normalizeSupabaseUrl(rawUrl) {
  let str = normalizeEnvSecret(rawUrl);
  if (!str) return 'https://pqxrlkheqwuvgwgnxnkk.supabase.co';

  // もしダッシュボードURLが指定されていた場合
  // 例: https://supabase.com/dashboard/project/pqxrlkheqwuvgwgnxnkk...
  const dashboardMatch = str.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dashboardMatch && dashboardMatch[1]) {
    return `https://${dashboardMatch[1]}.supabase.co`;
  }

  // プロジェクトID単体の場合 (20文字前後の英小文字数字)
  if (/^[a-z0-9]{15,30}$/i.test(str)) {
    return `https://${str}.supabase.co`;
  }

  // プロトコル補完
  if (!/^https?:\/\//i.test(str)) {
    str = 'https://' + str;
  }

  // 末尾のスラッシュを除去
  return str.replace(/\/+$/, '');
}

/**
 * Supabaseキーのタイプ判別
 */
function getKeyType(key) {
  if (!key) return 'missing';
  if (key.startsWith('sb_secret_')) return 'sb_secret';
  if (key.startsWith('sb_publishable_')) return 'sb_publishable';
  if (key.split('.').length === 3) return 'jwt';
  return 'unknown';
}

/**
 * Supabaseクライアントの初期化（新形式キー対応＆URL自動補正＆フォールバック）
 */
function getSupabase(customUrl = null, customKey = null) {
  const rawUrl = customUrl || process.env.SUPABASE_URL;
  const rawKey = customKey || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  const url = normalizeSupabaseUrl(rawUrl);
  const key = normalizeEnvSecret(rawKey);

  if (!url || !key) {
    throw new Error('Supabaseの環境変数 (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) が設定されていません');
  }

  // 新形式キー（sb_secret_... または sb_publishable_...）対応
  // PostgREST が Expected 3 parts in JWT を出さないよう、authオプションとglobalヘッダーを最適化
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    },
    global: {
      headers: {
        apikey: key,
        ...(key.startsWith('sb_') ? { 'x-supabase-api-key': key } : {})
      }
    }
  });
}

// ==========================================
// 日付・文字列・招待コードユーティリティ
// ==========================================

function todayStr() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function currentMonthStr() {
  return todayStr().slice(0, 7);
}

function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime());
}

/**
 * 対象月の開始日・終了日（うるう年・小の月対応）を算出
 */
function getMonthDateRange(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return {
    startDate: `${monthStr}-01`,
    endDate: `${monthStr}-${String(lastDay).padStart(2, '0')}`
  };
}

function sanitizeMonth(monthStr) {
  const cur = currentMonthStr();
  if (!monthStr || !/^\d{4}-\d{2}$/.test(String(monthStr))) return cur;
  const [y, m] = monthStr.split('-').map(Number);
  const [cy, cm] = cur.split('-').map(Number);
  const diff = (cy - y) * 12 + (cm - m);
  if (m < 1 || m > 12 || diff < 0 || diff >= MAX_HISTORY_MONTHS) return cur;
  return monthStr;
}

/**
 * 品名の正規化（全角半角・大小・ひらがな/カタカナ・空白を吸収）
 */
function normalizeName(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
    .replace(/\s+/g, '');
}

/**
 * 主要食材・日用品の同義語辞書（シノニム展開 v2.8.0）
 */
const SYNONYM_GROUPS = [
  ['白菜', 'はくさい', 'ハクサイ'],
  ['豆腐', 'とうふ', 'トウフ'],
  ['卵', '玉子', 'たまご', 'タマゴ'],
  ['牛乳', 'ぎゅうにゅう', 'ギュウニュウ', 'ミルク'],
  ['玉ねぎ', 'たまねぎ', 'タマネギ', '玉葱'],
  ['人参', 'にんじん', 'ニンジン'],
  ['豚肉', 'ぶた肉', 'ポーク', '豚'],
  ['鶏肉', 'とり肉', 'チキン', '鶏'],
  ['牛肉', '牛', 'ビーフ'],
  ['もやし', 'モヤシ'],
  ['キャベツ', 'きゃべつ'],
  ['大根', 'だいこん', 'ダイコン'],
  ['納豆', 'なっとう', 'ナットウ'],
  ['ネギ', 'ねぎ', '葱'],
  ['きゅうり', 'キュウリ', '胡瓜'],
  ['じゃがいも', 'ジャガイモ', 'ポテト'],
  ['レタス', 'れたす'],
  ['トマト', 'とまと'],
  ['醤油', 'しょうゆ', 'ショウユ'],
  ['味噌', 'みそ', 'ミソ'],
  ['マヨネーズ', 'マヨ'],
  ['食パン', 'パン'],
  ['米', 'お米', 'ごはん', 'コメ'],
  ['ティッシュ', 'ティシュ', 'boxティッシュ'],
  ['トイレットペーパー', 'トイレロール', 'トイレットロール'],
  ['ラップ', 'サランラップ', 'クレラップ'],
  ['洗剤', '食器用洗剤', '洗濯洗剤']
];

/**
 * 検索クエリのシノニム・表記揺れ展開 (v2.8.0)
 */
function expandSearchKeywords(rawQuery) {
  const qClean = String(rawQuery || '').trim();
  if (!qClean) return [];

  const normQ = normalizeName(qClean);
  const keywords = new Set([qClean, normQ]);

  // カタカナ ➔ ひらがな変換も追加
  const hiraQ = normQ.replace(/[\u30A1-\u30F6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  keywords.add(hiraQ);

  // シノニム辞書探索
  for (const group of SYNONYM_GROUPS) {
    const isMatch = group.some(w => {
      const nw = normalizeName(w);
      return normQ === nw || normQ.includes(nw) || nw.includes(normQ);
    });
    if (isMatch) {
      group.forEach(w => {
        keywords.add(w);
        keywords.add(normalizeName(w));
      });
    }
  }

  return Array.from(keywords).filter(k => k && k.length > 0);
}

/**
 * 6〜8桁の英数字招待コード生成（見間違えやすい 0/O, 1/I を除外）
 */
function generateInviteCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 7; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function isDemoAllowed() {
  // 明示的に STRICT_LINE_AUTH=true が設定されていない限り、PCブラウザやGitHub Pagesからのアクセスも許可する
  if (process.env.STRICT_LINE_AUTH === 'true') {
    return process.env.DEMO_MODE === 'true';
  }
  return process.env.DEMO_MODE !== 'false';
}

// ==========================================
// 認証・ユーザー・ペア特定 (LINE Token & Webhook)
// ==========================================

/**
 * LIFF IDトークンをLINE検証APIで確認
 */
async function verifyIdTokenDetail(idToken, rawChannelId) {
  const cleanChannelId = String(rawChannelId || '')
    .trim()
    .replace(/^https?:\/\/liff\.line\.me\//i, '')
    .split('-')[0]
    .trim();
  if (!idToken || !cleanChannelId) {
    return { sub: '', error: 'IDトークンまたはチャネルIDが空です' };
  }

  try {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: cleanChannelId })
    });
    const body = await res.json();
    if (!res.ok || !body.sub) {
      const desc = String(body.error_description || body.error || `HTTP ${res.status}`);
      return { sub: '', error: desc };
    }
    return { sub: body.sub, error: '' };
  } catch (err) {
    return { sub: '', error: err.message };
  }
}

function sanitizePairId(id) {
  const s = String(id || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
    ? s
    : DEFAULT_PAIR_ID;
}

/**
 * リクエスト操作者を確定
 */
async function resolveActor(idToken, supabase, requestedPairId = null) {
  const safePairId = sanitizePairId(requestedPairId);
  const channelId = process.env.LINE_CHANNEL_ID;
  if (!channelId) {
    if (isDemoAllowed()) {
      return { allowed: true, verified: false, name: 'メンバー1', userId: '', slot: 'husband', pairId: safePairId };
    }
    return {
      allowed: false,
      code: 'SETUP_REQUIRED',
      error: '環境変数 LINE_CHANNEL_ID が設定されていません。'
    };
  }

  if (!idToken) {
    if (isDemoAllowed()) {
      return { allowed: true, verified: false, name: 'メンバー1', userId: '', slot: 'husband', pairId: safePairId };
    }
    return {
      allowed: false,
      code: 'AUTH',
      error: 'LINEのIDトークンが取得できませんでした（LINE DevelopersのLIFF設定で「openid」スコープがONか確認してください）'
    };
  }

  const v = await verifyIdTokenDetail(idToken, channelId);
  if (!v.sub) {
    if (isDemoAllowed()) {
      return { allowed: true, verified: false, name: 'メンバー1', userId: '', slot: 'husband', pairId: safePairId };
    }
    const isClientMismatch = /client_id|audience|channel/i.test(v.error);
    return {
      allowed: false,
      code: isClientMismatch ? 'SETUP_REQUIRED' : 'AUTH',
      error: isClientMismatch
        ? `LINEチャネルIDの設定が一致していません（詳細: ${v.error}）`
        : `ログインの有効期限が切れました（${v.error}）。再読み込みしてください。`
    };
  }

  const userId = v.sub;
  // DBからユーザー検索（所属ペアも取得）
  const { data: user } = await supabase
    .from('users')
    .select('*, pairs(*)')
    .eq('line_user_id', userId)
    .maybeSingle();

  if (!user) {
    // まだ users テーブルに未登録でも、オンボーディング画面の無限ループを防ぐため
    // 指定されたペア（またはデフォルトペア）でのデータ取得・操作を許可する
    return {
      allowed: true,
      verified: false,
      isUnregistered: true,
      name: 'メンバー1',
      userId: userId,
      slot: 'husband',
      pairId: safePairId
    };
  }

  return {
    allowed: true,
    verified: true,
    name: user.display_name,
    userId: user.line_user_id,
    slot: user.slot,
    pairId: sanitizePairId(user.pair_id || safePairId),
    pairName: user.pairs?.name || 'ふたりの家計簿',
    inviteCode: user.pairs?.invite_code || ''
  };
}

/**
 * ペアIDの検証 & 確定（IDOR脆弱性防御）
 * 認証済みユーザーの所属ペアを最優先し、未認証デモ時のみリクエスト指定ペアまたはデフォルトペアを採用
 */
function getTargetPairId(actor, requestData) {
  if (actor && actor.verified && actor.pairId) {
    return sanitizePairId(actor.pairId);
  }
  return sanitizePairId(requestData?.pairId || actor?.pairId || DEFAULT_PAIR_ID);
}

/**
 * LINE Webhook署名検証
 */
function verifyLineSignature(rawBody, signature, channelSecret) {
  if (process.env.LINE_SKIP_SIGNATURE_VERIFY === 'true') {
    console.warn('LINE_SKIP_SIGNATURE_VERIFY が有効なため、署名検証をスキップします');
    return true;
  }
  if (!signature || !channelSecret) {
    console.warn(`署名またはChannel Secretが未指定です: signature=${Boolean(signature)}, secret=${Boolean(channelSecret)}`);
    return false;
  }
  try {
    const hmac = crypto.createHmac('SHA256', channelSecret);
    hmac.update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));
    const digest = hmac.digest('base64');
    const signatureBuffer = Buffer.from(signature);
    const digestBuffer = Buffer.from(digest);
    if (signatureBuffer.length !== digestBuffer.length) {
      console.warn(`LINE署名長不一致: received=${signatureBuffer.length}, expected=${digestBuffer.length}`);
      return false;
    }
    const matched = crypto.timingSafeEqual(digestBuffer, signatureBuffer);
    if (!matched) {
      console.warn(`LINE署名不一致: expected=${digest.slice(0, 8)}..., received=${signature.slice(0, 8)}...`);
    }
    return matched;
  } catch (err) {
    console.warn('LINE署名検証エラー:', err.message);
    return false;
  }
}

// ==========================================
// 監査ログヘルパー
// ==========================================
async function writeAudit(supabase, actor, pairId, action, targetType, targetId, before, after) {
  try {
    await supabase.from('audit_logs').insert({
      pair_id: pairId || DEFAULT_PAIR_ID,
      actor_id: actor ? actor.name : 'system',
      action: action,
      target_type: targetType,
      target_id: String(targetId || ''),
      before_data: before || null,
      after_data: after || null
    });
  } catch (err) {
    console.error('監査ログの記録に失敗:', err);
  }
}

// ==========================================
// 設定・メンバー情報ヘルパー (ペア別)
// ==========================================
async function getAppSetting(supabase, pairId, key, defaultVal = null) {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('pair_id', pairId || DEFAULT_PAIR_ID).eq('key', key).maybeSingle();
    if (!data || data.value === null || data.value === undefined) return defaultVal;
    try {
      return JSON.parse(data.value);
    } catch (_) {
      return data.value;
    }
  } catch (_) {
    return defaultVal;
  }
}

async function setAppSetting(supabase, pairId, key, value) {
  try {
    const strVal = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    await supabase.from('app_settings').upsert({ pair_id: pairId || DEFAULT_PAIR_ID, key, value: strVal }, { onConflict: 'pair_id, key' });
  } catch (err) {
    console.error(`app_settings保存エラー (${key}):`, err);
  }
}

async function getConfigData(supabase, pairId) {
  const targetPairId = pairId || DEFAULT_PAIR_ID;
  const [settingsRes, usersRes, pairRes] = await Promise.all([
    supabase.from('app_settings').select('*').eq('pair_id', targetPairId),
    supabase.from('users').select('*').eq('pair_id', targetPairId),
    supabase.from('pairs').select('*').eq('id', targetPairId).maybeSingle()
  ]);

  const config = {
    pairId: targetPairId,
    pairName: pairRes.data?.name || 'ふたりの家計簿',
    inviteCode: pairRes.data?.invite_code || '',
    husbandBaseContribution: 60000,
    wifeBaseContribution: 60000,
    husbandUserId: '',
    wifeUserId: '',
    husbandName: 'メンバー1',
    wifeName: 'メンバー2',
    shoppingPurgeDays: 1,
    categoryBudgets: {},
    categoryBudgetsByMonth: {},
    surplusPolicy: 'savings',
    savingsConfig: { initialSavings: 0, monthlyInterests: {} },
    autoCheckShoppingOnReceipt: true
  };

  (settingsRes.data || []).forEach(s => {
    if (s.key === 'husbandBaseContribution') config.husbandBaseContribution = Number(s.value) || 60000;
    if (s.key === 'wifeBaseContribution') config.wifeBaseContribution = Number(s.value) || 60000;
    if (s.key === 'husbandName') config.husbandName = s.value;
    if (s.key === 'wifeName') config.wifeName = s.value;
    if (s.key === 'shoppingPurgeDays') config.shoppingPurgeDays = Number(s.value !== undefined ? s.value : 1);
    if (s.key === 'surplusPolicy') config.surplusPolicy = ['savings', 'ratio', 'equal'].includes(s.value) ? s.value : 'savings';
    if (s.key === 'autoCheckShoppingOnReceipt') config.autoCheckShoppingOnReceipt = s.value !== 'false' && s.value !== false;
    if (s.key === 'categoryBudgets') {
      try {
        config.categoryBudgets = JSON.parse(s.value);
      } catch (_) {}
    }
    if (/^categoryBudgets_\d{4}-\d{2}$/.test(s.key)) {
      const mKey = s.key.replace('categoryBudgets_', '');
      try {
        config.categoryBudgetsByMonth[mKey] = JSON.parse(s.value);
      } catch (_) {}
    }
    if (s.key === 'customCategories') {
      try {
        config.customCategories = JSON.parse(s.value);
      } catch (_) {}
    }
    if (s.key === 'savingsConfig') {
      try {
        config.savingsConfig = JSON.parse(s.value);
      } catch (_) {}
    }
    if (s.key === 'membersConfig') {
      try {
        config.members = JSON.parse(s.value);
      } catch (_) {}
    }
  });

  (usersRes.data || []).forEach(u => {
    if (u.slot === 'husband' || u.slot === 'slot1') {
      config.husbandUserId = u.line_user_id;
      if (u.display_name) config.husbandName = u.display_name;
    } else if (u.slot === 'wife' || u.slot === 'slot2') {
      config.wifeUserId = u.line_user_id;
      if (u.display_name) config.wifeName = u.display_name;
    }
  });

  return config;
}

function resolvePayerSlot(payer, config) {
  const p = String(payer || '').trim();
  if (!p) return null;
  if (p === '共同' || p === 'shared') return 'shared';
  if (p === config.husbandName || p === '夫' || p === 'メンバー1' || p === 'husband' || p === 'slot1') return 'husband';
  if (p === config.wifeName || p === '妻' || p === 'メンバー2' || p === 'wife' || p === 'slot2') return 'wife';
  return null;
}

// ==========================================
// ビジネスロジック集計
// ==========================================

function calculateTransfers(monthStr, txs, config, monthlyBudget) {
  const hBase = Number(config.husbandBaseContribution) || 60000;
  const wBase = Number(config.wifeBaseContribution) || 60000;
  const acc = { husband: { priv: 0, adv: 0 }, wife: { priv: 0, adv: 0 } };

  txs.forEach(tx => {
    const slot = resolvePayerSlot(tx.payer, config);
    if (slot !== 'husband' && slot !== 'wife') return;
    const isPriv = !tx.isShared && tx.paymentType === 'shared_card';
    const isAdv = tx.isShared && (tx.paymentType === 'advanced_by_user' || tx.paymentType === 'personal_advance');
    if (isPriv) acc[slot].priv += tx.amount;
    if (isAdv) acc[slot].adv += tx.amount;
  });

  const hPaid = monthlyBudget ? !!monthlyBudget.transfer_status_user1 : false;
  const wPaid = monthlyBudget ? !!monthlyBudget.transfer_status_user2 : false;

  return {
    month: monthStr,
    husband: {
      baseContribution: hBase,
      privateOnSharedCard: acc.husband.priv,
      advancedForShared: acc.husband.adv,
      totalTransfer: Math.max(0, hBase + acc.husband.priv - acc.husband.adv),
      isPaid: hPaid
    },
    wife: {
      baseContribution: wBase,
      privateOnSharedCard: acc.wife.priv,
      advancedForShared: acc.wife.adv,
      totalTransfer: Math.max(0, wBase + acc.wife.priv - acc.wife.adv),
      isPaid: wPaid
    }
  };
}

function calculateMonthlySummary(monthStr, txs, budgetAmount) {
  const isCurrentMonth = monthStr === currentMonthStr();
  const totalExpense = txs.filter(t => t.isShared).reduce((s, t) => s + t.amount, 0);
  const remaining = budgetAmount - totalExpense;

  const [year, month] = monthStr.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const todayDay = new Date().getDate();
  const daysLeft = isCurrentMonth ? Math.max(1, lastDay - todayDay + 1) : 0;

  return {
    month: monthStr,
    isCurrentMonth: isCurrentMonth,
    budget: budgetAmount,
    totalExpense: totalExpense,
    remaining: remaining,
    progressRate: budgetAmount > 0 ? Math.min(100, Math.round((totalExpense / budgetAmount) * 100)) : 0,
    daysLeft: daysLeft,
    dailyAllowance: isCurrentMonth && daysLeft > 0 ? Math.max(0, Math.floor(remaining / daysLeft)) : 0
  };
}

// ==========================================
// 最小送金回数アルゴリズム（Debt Simplification）
// ==========================================
function simplifyDebts(balances) {
  // balances: { [member: string]: number (paid - shouldPay) }
  const creditors = []; // プラス（受け取る人）
  const debtors = [];   // マイナス（支払う人）

  Object.entries(balances).forEach(([name, amount]) => {
    const rounded = Math.round(amount);
    if (rounded > 0) creditors.push({ name, amount: rounded });
    else if (rounded < 0) debtors.push({ name, amount: -rounded });
  });

  // 金額降順でソート（グリーディ相殺）
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transactions = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const transferAmount = Math.min(debtor.amount, creditor.amount);

    if (transferAmount > 0) {
      transactions.push({
        from: debtor.name,
        to: creditor.name,
        amount: transferAmount
      });
    }

    debtor.amount -= transferAmount;
    creditor.amount -= transferAmount;

    if (debtor.amount === 0) i++;
    if (creditor.amount === 0) j++;
  }

  return transactions;
}

/**
 * 30日経過イベントの自動削除（パージ）
 */
async function purgeExpiredEvents(supabase) {
  try {
    const { data, error } = await supabase.rpc('purge_expired_events');
    if (error) {
      // RPCが未適用の場合は直接DELETEクエリで実行
      await supabase.from('events').delete().lt('expires_at', new Date().toISOString());
    }
  } catch (err) {
    console.warn('イベントパージ処理エラー:', err);
  }
}

/**
 * 購入済み買い物アイテムの自動物理削除（未購入アイテムは絶対に削除しない）
 * @param {object} supabase
 * @param {string} pairId
 * @param {number} purgeDays
 */
async function purgeCompletedShoppingItems(supabase, pairId, purgeDays) {
  try {
    const days = Number(purgeDays !== undefined ? purgeDays : 1);
    if (days === -1) return; // 自動削除なし

    if (days === 0) {
      // 即時削除: 購入済みをすべて物理削除（未購入は除外）
      await supabase
        .from('shopping_list')
        .delete()
        .eq('pair_id', pairId)
        .eq('is_completed', true);
      return;
    }

    const cutoffIso = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();

    // 1) completed_at が記録されており、cutoffIso 以前の購入済みアイテム
    await supabase
      .from('shopping_list')
      .delete()
      .eq('pair_id', pairId)
      .eq('is_completed', true)
      .not('completed_at', 'is', null)
      .lt('completed_at', cutoffIso);

    // 2) completed_at が null の購入済み旧データフォールバック（created_at で判定）
    await supabase
      .from('shopping_list')
      .delete()
      .eq('pair_id', pairId)
      .eq('is_completed', true)
      .is('completed_at', null)
      .lt('created_at', cutoffIso);
  } catch (err) {
    console.warn('買い物リスト自動削除エラー:', err);
  }
}

// ==========================================
// APIアクション実装
// ==========================================

/**
 * 初期データ一括取得（ペア完全分離）
 */
async function handleGetInitialData(supabase, targetMonth, actor, requestedPairId) {
  const pairId = getTargetPairId(actor, { pairId: requestedPairId });
  const month = sanitizeMonth(targetMonth);
  const { startDate, endDate } = getMonthDateRange(month);
  const config = await getConfigData(supabase, pairId);
  const actorSlot = resolvePayerSlot(actor?.name, config) || 'husband';

  // 期限切れイベントの自動パージをトリガー
  purgeExpiredEvents(supabase).catch(() => {});
  // 購入済み買い物アイテムの自動パージ（設定日数経過分を物理削除）
  await purgeCompletedShoppingItems(supabase, pairId, config.shoppingPurgeDays);

  // 並列データ取得（全て pair_id で厳格に分離）
  const [
    txRes,
    itemsRes,
    shoppingRes,
    budgetsRes,
    fixedRes,
    catRes,
    rulesRes,
    allTxRes
  ] = await Promise.all([
    // 当月の支出
    supabase
      .from('transactions')
      .select('*')
      .eq('pair_id', pairId)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false }),
    // 当月のレシート明細
    supabase
      .from('receipt_items')
      .select('*, receipts!inner(date, pair_id)')
      .eq('receipts.pair_id', pairId)
      .gte('receipts.date', startDate)
      .lte('receipts.date', endDate),
    // 買い物リスト
    supabase.from('shopping_list').select('*').eq('pair_id', pairId).order('created_at', { ascending: false }),
    // 月次予算マスタ
    supabase.from('monthly_budgets').select('*').eq('pair_id', pairId).order('month', { ascending: false }),
    // 固定費
    supabase.from('fixed_expenses').select('*').eq('pair_id', pairId).order('billing_day', { ascending: true }),
    // カテゴリ（共通）
    supabase.from('categories').select('*').order('sort_order', { ascending: true }),
    // ルール（ペア別）
    supabase.from('rules').select('*').eq('pair_id', pairId),
    // 過去支出（月別推移計算用・直近36ヶ月）
    supabase
      .from('transactions')
      .select('date, amount, is_shared, payment_type, payer_id')
      .eq('pair_id', pairId)
      .gte('date', `${new Date(Date.now() - 36 * 30 * 86400000).toISOString().slice(0, 7)}-01`)
  ]);

  const rawTxs = txRes.data || [];
  const transactions = rawTxs.map(t => ({
    id: t.id,
    date: t.date,
    title: t.title,
    amount: Number(t.amount) || 0,
    category: t.category_id,
    isShared: t.is_shared,
    paymentType: t.payment_type,
    payer: t.payer_id,
    memo: t.memo || '',
    createdBy: t.created_by || '',
    createdAt: t.created_at,
    updatedBy: t.updated_by || '',
    updatedAt: t.updated_at,
    receiptId: t.receipt_id || ''
  }));

  const receiptItems = (itemsRes.data || []).map(it => ({
    receiptId: it.receipt_id,
    name: it.item_name,
    quantity: Number(it.quantity) || 1,
    price: Number(it.price) || 0,
    unitPrice: Number(it.unit_price) || 0
  }));

  const shoppingList = (shoppingRes.data || []).map(s => ({
    id: s.id,
    title: s.title,
    category: s.category_id || '日用品',
    isCompleted: s.is_completed,
    completedAt: s.completed_at || null,
    requestedBy: s.requested_by,
    createdAt: s.created_at?.slice(0, 10)
  }));

  const monthlyBudgets = (budgetsRes.data || []).map(b => ({
    month: b.month,
    amount: Number(b.budget_amount) || DEFAULT_BUDGET,
    note: b.note || ''
  }));

  const fixedExpenses = (fixedRes.data || []).map(f => ({
    id: f.id,
    title: f.title,
    amount: Number(f.amount) || 0,
    category: f.category_id,
    billingDay: f.billing_day,
    isActive: f.is_active,
    payer: f.payer || '共同カード'
  }));

  const categories = (catRes.data || []).map(c => ({
    name: c.name,
    color: c.color,
    icon: c.icon
  }));

  const rules = (rulesRes.data || []).map(r => ({
    keyword: r.keyword,
    category: r.category_id
  }));

  // 部門別予算（categoryBudgets）の探索＆前月自動引き継ぎ (v2.8.0)
  let resolvedCategoryBudgets = {};
  let categoryBudgetsInheritedFrom = null;

  if (config.categoryBudgetsByMonth && config.categoryBudgetsByMonth[month]) {
    resolvedCategoryBudgets = config.categoryBudgetsByMonth[month];
  } else {
    const pastMonths = Object.keys(config.categoryBudgetsByMonth || {})
      .filter(m => m < month)
      .sort((a, b) => (a < b ? 1 : -1));
    if (pastMonths.length > 0) {
      resolvedCategoryBudgets = config.categoryBudgetsByMonth[pastMonths[0]];
      categoryBudgetsInheritedFrom = pastMonths[0];
    } else if (config.categoryBudgets && Object.keys(config.categoryBudgets).length > 0) {
      resolvedCategoryBudgets = config.categoryBudgets;
    }
  }

  // 予算額の決定＆前月自動引き継ぎ (v2.8.0)
  const curBudgetObj = (budgetsRes.data || []).find(b => b.month === month);
  let resolvedBudget = DEFAULT_BUDGET;
  let budgetInheritedFrom = null;
  if (curBudgetObj) {
    resolvedBudget = Number(curBudgetObj.budget_amount) || DEFAULT_BUDGET;
  } else {
    const past = (budgetsRes.data || []).filter(b => b.month < month).sort((a, b) => (a.month < b.month ? 1 : -1));
    if (past.length > 0) {
      resolvedBudget = Number(past[0].budget_amount) || DEFAULT_BUDGET;
      budgetInheritedFrom = past[0].month;
    }
    // monthlyBudgets 配列に対象月分を仮想補完（フロントエンドでシームレス参照）
    monthlyBudgets.unshift({
      month: month,
      amount: resolvedBudget,
      note: budgetInheritedFrom ? `${budgetInheritedFrom}から自動引き継ぎ` : '初期値',
      isInherited: true,
      inheritedFrom: budgetInheritedFrom
    });
  }

  // 振込・精算計算
  const transfers = calculateTransfers(month, transactions, config, curBudgetObj);
  const summary = calculateMonthlySummary(month, transactions, resolvedBudget);

  // 過去36ヶ月の月別推移
  const [cy, cm] = currentMonthStr().split('-').map(Number);
  const totalsMap = {};
  const totalsOrder = [];
  for (let i = MAX_HISTORY_MONTHS - 1; i >= 0; i--) {
    const d = new Date(cy, cm - 1 - i, 1);
    const m = `${d.getFullYear()}-${('0' + (d.getMonth() + 1)).slice(-2)}`;
    const personalObj = {
      husband: 0,
      wife: 0,
      夫: 0,
      妻: 0,
      [config.husbandName]: 0,
      [config.wifeName]: 0
    };
    totalsMap[m] = {
      month: m,
      shared: 0,
      personal: personalObj,
      budget: resolvedBudget,
      sharedCard: 0,
      sharedCardLiving: 0,
      sharedCardPersonal: 0
    };
    totalsOrder.push(m);
  }

  (allTxRes.data || []).forEach(tx => {
    const m = tx.date.slice(0, 7);
    const b = totalsMap[m];
    if (!b) return;
    const amt = Number(tx.amount) || 0;
    const isSharedCard = tx.payment_type === 'shared_card';
    if (isSharedCard) {
      b.sharedCard += amt;
      if (tx.is_shared) {
        b.sharedCardLiving += amt;
      } else {
        b.sharedCardPersonal += amt;
      }
    }
    if (tx.is_shared) {
      b.shared += amt;
    } else {
      const slot = resolvePayerSlot(tx.payer_id, config);
      if (slot === 'husband') {
        b.personal.husband += amt;
        b.personal['夫'] += amt;
        b.personal[config.husbandName] = b.personal.husband;
      } else if (slot === 'wife') {
        b.personal.wife += amt;
        b.personal['妻'] += amt;
        b.personal[config.wifeName] = b.personal.wife;
      }
    }
  });

  return {
    success: true,
    version: 'v2.8.0',
    pair: {
      id: pairId,
      name: config.pairName,
      inviteCode: config.inviteCode
    },
    month: month,
    actor: { name: actor?.name || '未認証', slot: actorSlot, verified: !!actor?.verified },
    transactions: transactions,
    receiptItems: receiptItems,
    shoppingList: shoppingList,
    monthlyBudgets: monthlyBudgets,
    fixedExpenses: fixedExpenses,
    categories: categories,
    rules: rules,
    config: {
      husbandBaseContribution: Number(config.husbandBaseContribution) || 60000,
      wifeBaseContribution: Number(config.wifeBaseContribution) || 60000,
      husbandName: config.husbandName,
      wifeName: config.wifeName,
      shoppingPurgeDays: Number(config.shoppingPurgeDays !== undefined ? config.shoppingPurgeDays : 1),
      categoryBudgets: resolvedCategoryBudgets,
      categoryBudgetsInheritedFrom: categoryBudgetsInheritedFrom,
      budgetInheritedFrom: budgetInheritedFrom,
      customCategories: config.customCategories || [],
      surplusPolicy: config.surplusPolicy || 'savings',
      savingsConfig: config.savingsConfig || { initialSavings: 0, monthlyInterests: {} }
    },
    members: config.members || null,
    transfers: transfers,
    summary: summary,
    monthlyTotals: totalsOrder.map(m => totalsMap[m])
  };
}

/**
 * 新規ペア作成 (createPair)
 */
async function handleCreatePair(supabase, idToken, data) {
  const pairName = String(data?.name || 'ふたりの家計簿').trim().slice(0, 30);
  const customName = String(data?.userName || '').trim().slice(0, 15) || 'メンバー1';
  const inviteCode = generateInviteCode();

  // 1. ペア作成
  const { data: newPair, error: pairErr } = await supabase.from('pairs').insert({
    name: pairName,
    invite_code: inviteCode
  }).select('*').single();

  if (pairErr) {
    console.error('ペア作成エラー:', pairErr);
    return { success: false, error: '新しいペアの作成に失敗しました' };
  }

  const pairId = newPair.id;

  // 2. 初期設定・ルールを初期化
  await Promise.all([
    supabase.from('app_settings').insert([
      { pair_id: pairId, key: 'husbandName', value: customName },
      { pair_id: pairId, key: 'wifeName', value: 'メンバー2' },
      { pair_id: pairId, key: 'husbandBaseContribution', value: '60000' },
      { pair_id: pairId, key: 'wifeBaseContribution', value: '60000' }
    ]),
    supabase.from('rules').insert([
      { pair_id: pairId, keyword: 'イオン', category_id: '食費' },
      { pair_id: pairId, keyword: 'ライフ', category_id: '食費' },
      { pair_id: pairId, keyword: 'ドラッグ', category_id: '日用品' }
    ]),
    supabase.from('fixed_expenses').insert([
      { pair_id: pairId, title: '家賃', amount: 110000, category_id: '住居費', billing_day: 27, is_active: true, payment_type: 'shared_card', payer: '共同カード' }
    ])
  ]);

  // 3. ユーザーの紐付け（IDトークンがある場合）
  if (idToken) {
    const channelId = process.env.LINE_CHANNEL_ID;
    const v = await verifyIdTokenDetail(idToken, channelId);
    if (v.sub) {
      await supabase.from('users').upsert({
        line_user_id: v.sub,
        pair_id: pairId,
        slot: 'husband',
        display_name: customName,
        updated_at: new Date().toISOString()
      }, { onConflict: 'line_user_id' });
    }
  }

  await writeAudit(supabase, { name: customName }, pairId, '作成', '世帯ペア', pairId, null, { pairName, inviteCode });

  return {
    success: true,
    pair: {
      id: pairId,
      name: pairName,
      inviteCode: inviteCode
    },
    role: customName,
    slot: 'husband'
  };
}

/**
 * 招待コードによるペア合流 (joinPair)
 */
async function handleJoinPair(supabase, idToken, data) {
  const code = String(data?.inviteCode || '').trim().toUpperCase();
  if (!code) return { success: false, error: '招待コードを入力してください' };

  const customName = String(data?.name || data?.userName || '').trim().slice(0, 15);
  if (!customName) return { success: false, error: '表示名を入力してください' };

  // 招待コードでペアを検索
  const { data: pair, error: pErr } = await supabase.from('pairs').select('*').ilike('invite_code', code).maybeSingle();
  if (!pair) {
    return { success: false, error: '招待コードが見つかりません。コードをご確認ください。' };
  }

  const pairId = pair.id;

  // ペア内の既存メンバー状況を確認（マルチメンバー・シェアハウス対応）
  const { data: members } = await supabase.from('users').select('*').eq('pair_id', pairId);
  const existingCount = (members || []).length;
  const husbandTaken = (members || []).some(m => m.slot === 'husband' || m.slot === 'slot1');
  const wifeTaken = (members || []).some(m => m.slot === 'wife' || m.slot === 'slot2');

  // 空いているスロットがあれば優先的に割り当て、3人目以降も動的スロットで無制限に参加可能
  const slot = !husbandTaken ? 'husband' : (!wifeTaken ? 'wife' : `member_${existingCount + 1}`);

  // IDトークン検証
  let userId = '';
  if (idToken) {
    const channelId = process.env.LINE_CHANNEL_ID;
    const v = await verifyIdTokenDetail(idToken, channelId);
    if (v.sub) userId = v.sub;
  }

  if (userId) {
    await supabase.from('users').upsert({
      line_user_id: userId,
      pair_id: pairId,
      slot: slot,
      display_name: customName,
      updated_at: new Date().toISOString()
    }, { onConflict: 'line_user_id' });
  }

  const settingKey = slot === 'husband' ? 'husbandName' : 'wifeName';
  await supabase.from('app_settings').upsert({ pair_id: pairId, key: settingKey, value: customName }, { onConflict: 'pair_id, key' });

  await writeAudit(supabase, { name: customName }, pairId, '参加', '世帯ペア', pairId, null, { slot, role: customName });

  return {
    success: true,
    pair: {
      id: pairId,
      name: pair.name,
      inviteCode: pair.invite_code
    },
    role: customName,
    slot: slot
  };
}

/**
 * メンバー初回登録
 */
async function handleRegisterMember(supabase, idToken, data) {
  const channelId = process.env.LINE_CHANNEL_ID;
  if (!channelId) {
    return { success: false, error: '環境変数 LINE_CHANNEL_ID が設定されていません' };
  }
  const v = await verifyIdTokenDetail(idToken, channelId);
  if (!v.sub) {
    return { success: false, code: 'AUTH', error: 'LINEログインの検証に失敗しました。再読み込みしてください。' };
  }
  const userId = v.sub;
  const targetPairId = data?.pairId || DEFAULT_PAIR_ID;

  const rawSlot = data && (data.slot || data.role);
  const slot = (rawSlot === 'husband' || rawSlot === '夫' || rawSlot === 'メンバー1' || rawSlot === 'slot1')
    ? 'husband'
    : ((rawSlot === 'wife' || rawSlot === '妻' || rawSlot === 'メンバー2' || rawSlot === 'slot2') ? 'wife' : '');

  if (!slot) return { success: false, error: '登録するメンバー枠を選択してください' };

  const customName = String((data && data.name) || '').trim().slice(0, 15);
  if (!customName) return { success: false, error: '表示名（ニックネーム）を入力してください（15文字以内）' };
  if (['共同', 'all', '未認証', '自動計上'].includes(customName)) {
    return { success: false, error: `「${customName}」はシステム予約語のため表示名に使用できません` };
  }

  const reqCode = process.env.REGISTER_CODE;
  if (reqCode && String(data.registerCode || '').trim() !== reqCode) {
    return { success: false, error: '登録用の合言葉（REGISTER_CODE）が一致しません' };
  }

  // 枠の空き状況と重複チェック（当該ペア内）
  const { data: allUsers } = await supabase.from('users').select('*').eq('pair_id', targetPairId);
  const existingWithSlot = (allUsers || []).find(u => (u.slot === slot || (slot === 'husband' && u.slot === 'slot1') || (slot === 'wife' && u.slot === 'slot2')));
  if (existingWithSlot && existingWithSlot.line_user_id !== userId) {
    return { success: false, error: '選択した枠は既に別のアカウントで登録済みです。もう一方の枠を選択してください。' };
  }

  const otherSlot = slot === 'husband' ? 'wife' : 'husband';
  const otherUser = (allUsers || []).find(u => u.slot === otherSlot);
  if (otherUser && customName === otherUser.display_name) {
    return { success: false, error: `パートナーと同じ名前（${otherUser.display_name}）は登録できません。` };
  }

  // users テーブルへ保存
  const { error: upsertErr } = await supabase.from('users').upsert({
    line_user_id: userId,
    pair_id: targetPairId,
    slot: slot,
    display_name: customName,
    updated_at: new Date().toISOString()
  }, { onConflict: 'line_user_id' });

  if (upsertErr) {
    console.error('ユーザー登録エラー:', upsertErr);
    return { success: false, error: 'ユーザーの登録に失敗しました' };
  }

  // 設定名も同期
  const settingKey = slot === 'husband' ? 'husbandName' : 'wifeName';
  await supabase.from('app_settings').upsert({ pair_id: targetPairId, key: settingKey, value: customName }, { onConflict: 'pair_id, key' });

  const actor = { name: customName, verified: true };
  await writeAudit(supabase, actor, targetPairId, '登録', 'メンバー', customName, null, { role: customName, slot });

  return { success: true, role: customName, slot, pairId: targetPairId };
}

/**
 * 支出追加
 */
async function handleAddTransaction(supabase, data, actor) {
  const pairId = getTargetPairId(actor, data);
  const amount = Number(data.amount);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10000000) {
    return { success: false, error: '金額は0円以外の整数で入力してください' };
  }
  const title = String(data.title || '').trim().slice(0, 50);
  if (!title) return { success: false, error: '品名を入力してください' };
  const date = data.date || todayStr();
  if (!isValidDateStr(date)) return { success: false, error: '日付の形式が正しくありません' };

  const paymentType = data.paymentType || 'shared_card';
  const isShared = data.isShared !== false && String(data.isShared) !== 'false';
  const payer = String(data.payer || actor.name).trim();

  const txRow = {
    pair_id: pairId,
    date: date,
    title: title,
    amount: amount,
    category_id: String(data.category || 'その他').slice(0, 20),
    is_shared: isShared,
    payment_type: paymentType,
    payer_id: payer,
    memo: String(data.memo || '').slice(0, 100),
    created_by: actor.name,
    receipt_id: data.receiptId || null
  };

  const { data: inserted, error } = await supabase.from('transactions').insert(txRow).select('id').single();
  if (error) {
    console.error('支出追加エラー:', error);
    return { success: false, error: '支出の追加に失敗しました' };
  }

  await writeAudit(supabase, actor, pairId, '追加', '支出', inserted.id, null, txRow);
  return { success: true, id: inserted.id };
}

/**
 * 支出更新
 */
async function handleUpdateTransaction(supabase, data, actor) {
  const pairId = getTargetPairId(actor, data);
  if (!data.id) return { success: false, error: '支出IDが必要です' };
  const amount = Number(data.amount);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10000000) return { success: false, error: '金額が正しくありません' };
  const title = String(data.title || '').trim().slice(0, 50);
  if (!title) return { success: false, error: '品名を入力してください' };
  const date = data.date || todayStr();
  if (!isValidDateStr(date)) return { success: false, error: '日付が正しくありません' };

  // 更新前レコードの取得（pair_idの一致を検証）
  const { data: before } = await supabase.from('transactions').select('*').eq('id', data.id).eq('pair_id', pairId).single();
  if (!before) return { success: false, error: '対象の支出が見つかりません' };

  const updateFields = {
    date: date,
    title: title,
    amount: amount,
    category_id: String(data.category || 'その他').slice(0, 20),
    is_shared: data.isShared !== false && String(data.isShared) !== 'false',
    payment_type: data.paymentType || 'shared_card',
    payer_id: String(data.payer || actor.name).trim(),
    memo: String(data.memo || '').slice(0, 100),
    updated_by: actor.name,
    updated_at: new Date().toISOString()
  };

  // レシート由来の支出の場合、日付連動更新
  if (before.receipt_id && before.date !== date) {
    await supabase.from('receipts').update({ date }).eq('id', before.receipt_id).eq('pair_id', pairId);
  }

  const { error } = await supabase.from('transactions').update(updateFields).eq('id', data.id).eq('pair_id', pairId);
  if (error) {
    console.error('支出更新エラー:', error);
    return { success: false, error: '支出の更新に失敗しました' };
  }

  await writeAudit(supabase, actor, pairId, '更新', '支出', data.id, before, updateFields);
  return { success: true };
}

/**
 * 支出削除
 */
async function handleDeleteTransaction(supabase, id, actor) {
  const pairId = getTargetPairId(actor, {});
  if (!id) return { success: false, error: '削除IDが必要です' };
  const { data: before } = await supabase.from('transactions').select('*').eq('id', id).eq('pair_id', pairId).single();
  if (!before) return { success: false, error: '削除対象が見つかりません' };

  // レシート紐付きならレシートも連動削除
  if (before.receipt_id) {
    await supabase.from('receipts').delete().eq('id', before.receipt_id).eq('pair_id', pairId);
  }

  const { error } = await supabase.from('transactions').delete().eq('id', id).eq('pair_id', pairId);
  if (error) {
    console.error('支出削除エラー:', error);
    return { success: false, error: '支出の削除に失敗しました' };
  }

  await writeAudit(supabase, actor, pairId, '削除', '支出', id, before, null);
  return { success: true };
}

/**
 * 買い物リスト CRUD
 */
async function handleAddShoppingItem(supabase, item, actor) {
  const pairId = getTargetPairId(actor, item);
  const title = String(item.title || '').trim().slice(0, 50);
  if (!title) return { success: false, error: '品名を入力してください' };

  const { data: inserted, error } = await supabase.from('shopping_list').insert({
    pair_id: pairId,
    title: title,
    category_id: String(item.category || '日用品').slice(0, 20),
    is_completed: false,
    requested_by: actor.name
  }).select('id').single();

  if (error) return { success: false, error: '買い物リストの追加に失敗しました' };
  return { success: true, id: inserted.id };
}

async function handleUpdateShoppingItem(supabase, item, actor) {
  const pairId = getTargetPairId(actor, item);
  if (!item.id) return { success: false, error: 'アイテムIDが必要です' };
  const updateFields = {
    title: String(item.title || '').trim().slice(0, 50),
    category_id: String(item.category || '日用品').slice(0, 20),
    is_completed: !!item.isCompleted
  };
  if (item.isCompleted) {
    updateFields.completed_at = new Date().toISOString();
  } else {
    updateFields.completed_at = null;
  }

  const { error } = await supabase.from('shopping_list').update(updateFields).eq('id', item.id).eq('pair_id', pairId);
  if (error) return { success: false, error: '更新に失敗しました' };

  if (item.isCompleted) {
    // 購入完了時、設定（0日即時削除など）に応じて自動パージ
    try {
      const config = await getConfigData(supabase, pairId);
      await purgeCompletedShoppingItems(supabase, pairId, config.shoppingPurgeDays);
    } catch (_) {}
  }

  return { success: true };
}

/**
 * 買い物リストの購入済みアイテム自動削除期間設定更新
 */
async function handleUpdateShoppingPurgeDays(supabase, data, actor) {
  const pairId = getTargetPairId(actor, data);
  const days = Number(data.shoppingPurgeDays !== undefined ? data.shoppingPurgeDays : 1);
  if (isNaN(days) || ![-1, 0, 1, 3, 7, 14, 30].includes(days)) {
    return { success: false, error: '不正な自動削除日数です' };
  }

  const { error } = await supabase
    .from('app_settings')
    .upsert({ pair_id: pairId, key: 'shoppingPurgeDays', value: String(days) }, { onConflict: 'pair_id, key' });

  if (error) {
    return { success: false, error: '自動削除日数の保存に失敗しました' };
  }

  // 設定変更直後に条件を満たす購入済みアイテムをパージ
  await purgeCompletedShoppingItems(supabase, pairId, days);

  return { success: true, shoppingPurgeDays: days };
}

async function handleDeleteShoppingItem(supabase, id, actor) {
  const pairId = getTargetPairId(actor, {});
  if (!id) return { success: false, error: 'IDが必要です' };
  const { error } = await supabase.from('shopping_list').delete().eq('id', id).eq('pair_id', pairId);
  if (error) return { success: false, error: '削除に失敗しました' };
  return { success: true };
}

/**
 * 部門（カテゴリ）別予算更新 (v2.8.0: 月別保存＆グローバル自動同期)
 */
async function handleUpdateCategoryBudgets(supabase, data, actor) {
  const pairId = getTargetPairId(actor, data);
  const budgets = typeof data.categoryBudgets === 'object' && data.categoryBudgets !== null ? data.categoryBudgets : {};
  const month = data.month || currentMonthStr();

  // 1. 全体デフォルト設定を更新
  const { error: globalErr } = await supabase
    .from('app_settings')
    .upsert({ pair_id: pairId, key: 'categoryBudgets', value: JSON.stringify(budgets) }, { onConflict: 'pair_id, key' });
  if (globalErr) return { success: false, error: '部門別予算の保存に失敗しました' };

  // 2. 対象月の月別設定も保存
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    await supabase
      .from('app_settings')
      .upsert({ pair_id: pairId, key: `categoryBudgets_${month}`, value: JSON.stringify(budgets) }, { onConflict: 'pair_id, key' });
  }

  return { success: true, categoryBudgets: budgets, month };
}

/**
 * カスタム部門（カテゴリ）更新 (v2.7.0)
 */
async function handleUpdateCustomCategories(supabase, data, actor) {
  const pairId = getTargetPairId(actor, data);
  const customCats = Array.isArray(data.customCategories) ? data.customCategories : [];
  const { error } = await supabase
    .from('app_settings')
    .upsert({ pair_id: pairId, key: 'customCategories', value: JSON.stringify(customCats) }, { onConflict: 'pair_id, key' });
  if (error) return { success: false, error: 'カスタム部門の保存に失敗しました' };

  if (data.categoryBudgets && typeof data.categoryBudgets === 'object') {
    await supabase
      .from('app_settings')
      .upsert({ pair_id: pairId, key: 'categoryBudgets', value: JSON.stringify(data.categoryBudgets) }, { onConflict: 'pair_id, key' });
  }

  return { success: true, customCategories: customCats, categoryBudgets: data.categoryBudgets || null };
}

/**
 * 余剰金の月末精算ルール更新 (savings / ratio / equal)
 */
async function handleUpdateSurplusPolicy(supabase, data, actor) {
  const pairId = getTargetPairId(actor, data);
  const policy = ['savings', 'ratio', 'equal'].includes(data.surplusPolicy) ? data.surplusPolicy : 'savings';
  const { error } = await supabase
    .from('app_settings')
    .upsert({ pair_id: pairId, key: 'surplusPolicy', value: policy }, { onConflict: 'pair_id, key' });
  if (error) return { success: false, error: '精算ルールの保存に失敗しました' };
  return { success: true, surplusPolicy: policy };
}

/**
 * 共同積立・利息設定更新
 */
async function handleUpdateSavingsConfig(supabase, data, actor) {
  const pairId = getTargetPairId(actor, data);
  const savingsConfig = typeof data.savingsConfig === 'object' && data.savingsConfig !== null ? data.savingsConfig : { initialSavings: 0, monthlyInterests: {} };
  const { error } = await supabase
    .from('app_settings')
    .upsert({ pair_id: pairId, key: 'savingsConfig', value: JSON.stringify(savingsConfig) }, { onConflict: 'pair_id, key' });
  if (error) return { success: false, error: '積立データの保存に失敗しました' };
  return { success: true, savingsConfig };
}

/**
 * 月次予算更新
 */
async function handleUpdateMonthlyBudget(supabase, data, actor) {
  const pairId = getTargetPairId(actor, data);
  const amount = Number(data.amount);
  if (!/^\d{4}-\d{2}$/.test(String(data.month || '')) || !Number.isInteger(amount) || amount <= 0) {
    return { success: false, error: '予算の入力値が正しくありません' };
  }
  const note = String(data.note || '').slice(0, 50);

  const { data: before } = await supabase
    .from('monthly_budgets')
    .select('*')
    .eq('pair_id', pairId)
    .eq('month', data.month)
    .maybeSingle();

  const { error } = await supabase.from('monthly_budgets').upsert({
    pair_id: pairId,
    month: data.month,
    budget_amount: amount,
    note: note,
    updated_at: new Date().toISOString()
  }, { onConflict: 'pair_id, month' });

  if (error) return { success: false, error: '月予算の更新に失敗しました' };
  await writeAudit(supabase, actor, pairId, '更新', '月予算', data.month, before, { month: data.month, amount, note });
  return { success: true };
}

/**
 * 固定費 CRUD
 */
async function handleUpdateFixedExpense(supabase, item, actor) {
  const pairId = getTargetPairId(actor, item);
  const amount = Number(item.amount);
  const title = String(item.title || '').trim().slice(0, 50);
  if (!title || !Number.isInteger(amount) || amount <= 0) {
    return { success: false, error: '固定費の入力値が正しくありません' };
  }

  const payload = {
    pair_id: pairId,
    title: title,
    amount: amount,
    category_id: String(item.category || 'その他').slice(0, 20),
    billing_day: Math.min(31, Math.max(1, Number(item.billingDay) || 1)),
    is_active: item.isActive !== false,
    payer: String(item.payer || '共同カード').slice(0, 20),
    updated_at: new Date().toISOString()
  };

  if (item.id) {
    const { data: before } = await supabase.from('fixed_expenses').select('*').eq('id', item.id).eq('pair_id', pairId).maybeSingle();
    const { error } = await supabase.from('fixed_expenses').update(payload).eq('id', item.id).eq('pair_id', pairId);
    if (error) return { success: false, error: '固定費の更新に失敗しました' };
    await writeAudit(supabase, actor, pairId, '更新', '固定費', item.id, before, payload);
    return { success: true, id: item.id };
  } else {
    const { data: inserted, error } = await supabase.from('fixed_expenses').insert(payload).select('id').single();
    if (error) return { success: false, error: '固定費の追加に失敗しました' };
    await writeAudit(supabase, actor, pairId, '追加', '固定費', inserted.id, null, payload);
    return { success: true, id: inserted.id };
  }
}

async function handleDeleteFixedExpense(supabase, id, actor) {
  const pairId = getTargetPairId(actor, {});
  if (!id) return { success: false, error: 'IDが必要です' };
  const { data: before } = await supabase.from('fixed_expenses').select('*').eq('id', id).eq('pair_id', pairId).maybeSingle();
  const { error } = await supabase.from('fixed_expenses').delete().eq('id', id).eq('pair_id', pairId);
  if (error) return { success: false, error: '固定費の削除に失敗しました' };
  await writeAudit(supabase, actor, pairId, '削除', '固定費', id, before, null);
  return { success: true };
}

/**
 * カテゴリ更新
 */
async function handleUpdateCategory(supabase, item, actor) {
  const name = String(item.name || '').trim().slice(0, 20);
  if (!name) return { success: false, error: 'カテゴリ名を入力してください' };
  const color = /^#[0-9a-fA-F]{6}$/.test(item.color || '') ? item.color : '#6B7280';
  const icon = String(item.icon || 'tag').slice(0, 30);

  const { error } = await supabase.from('categories').upsert({
    id: name,
    name: name,
    color: color,
    icon: icon
  }, { onConflict: 'id' });

  if (error) return { success: false, error: 'カテゴリの更新に失敗しました' };
  await writeAudit(supabase, actor, DEFAULT_PAIR_ID, '更新', 'カテゴリ', name, null, { name, color, icon });
  return { success: true };
}

/**
 * ルール更新
 */
async function handleUpdateRule(supabase, item, actor) {
  const pairId = getTargetPairId(actor, item);
  const keyword = String(item.keyword || '').trim().slice(0, 30);
  const category = String(item.category || '').trim().slice(0, 20);
  if (!keyword || !category) return { success: false, error: 'キーワードとカテゴリを入力してください' };

  const { error } = await supabase.from('rules').upsert({
    pair_id: pairId,
    keyword: keyword,
    category_id: category
  }, { onConflict: 'pair_id, keyword' });

  if (error) return { success: false, error: 'ルールの更新に失敗しました' };
  await writeAudit(supabase, actor, pairId, '更新', '仕分けルール', keyword, null, { keyword, category });
  return { success: true };
}

/**
 * 振込状況更新
 */
async function handleUpdateTransferStatus(supabase, data, actor) {
  const pairId = getTargetPairId(actor, data);
  const month = String(data.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) return { success: false, error: '月の指定が正しくありません' };

  const config = await getConfigData(supabase, pairId);
  const slot = resolvePayerSlot(data.slot || data.payer, config);
  if (slot !== 'husband' && slot !== 'wife') return { success: false, error: 'メンバー指定が正しくありません' };

  const field = slot === 'husband' ? 'transfer_status_user1' : 'transfer_status_user2';
  const isPaid = !!data.isPaid;

  const { error } = await supabase.from('monthly_budgets').upsert({
    pair_id: pairId,
    month: month,
    [field]: isPaid,
    updated_at: new Date().toISOString()
  }, { onConflict: 'pair_id, month' });

  if (error) return { success: false, error: '振込状況の更新に失敗しました' };
  await writeAudit(supabase, actor, pairId, '更新', '振込状況', `${month}:${slot}`, null, { slot, isPaid });
  return { success: true };
}

/**
 * 基本拠出額・表示名の更新
 */
async function handleUpdateBaseContribution(supabase, data, actor) {
  const pairId = getTargetPairId(actor, data);
  const hv = Number(data.husband);
  const wv = Number(data.wife);
  if (!Number.isInteger(hv) || !Number.isInteger(wv) || hv < 0 || wv < 0) {
    return { success: false, error: '基本拠出額が正しくありません' };
  }

  const before = await getConfigData(supabase, pairId);
  const hName = data.husbandName !== undefined ? String(data.husbandName || '').trim().slice(0, 15) : before.husbandName;
  const wName = data.wifeName !== undefined ? String(data.wifeName || '').trim().slice(0, 15) : before.wifeName;

  if (!hName || !wName) return { success: false, error: 'ふたりの表示名を入力してください' };
  if (hName === wName) return { success: false, error: 'ふたりの表示名は異なる名前にしてください' };
  if (['共同', 'all', '未認証', '自動計上'].some(k => [hName, wName].includes(k))) {
    return { success: false, error: 'システム予約語は表示名に使用できません' };
  }

  // 設定更新
  const settingsPromises = [
    supabase.from('app_settings').upsert({ pair_id: pairId, key: 'husbandBaseContribution', value: String(hv) }, { onConflict: 'pair_id, key' }),
    supabase.from('app_settings').upsert({ pair_id: pairId, key: 'wifeBaseContribution', value: String(wv) }, { onConflict: 'pair_id, key' }),
    supabase.from('app_settings').upsert({ pair_id: pairId, key: 'husbandName', value: hName }, { onConflict: 'pair_id, key' }),
    supabase.from('app_settings').upsert({ pair_id: pairId, key: 'wifeName', value: wName }, { onConflict: 'pair_id, key' })
  ];
  if (Array.isArray(data.members) && data.members.length > 0) {
    settingsPromises.push(
      supabase.from('app_settings').upsert({ pair_id: pairId, key: 'membersConfig', value: JSON.stringify(data.members) }, { onConflict: 'pair_id, key' })
    );
  }
  await Promise.all(settingsPromises);

  // usersテーブルの名前も更新（スロット表記 husband/slot1, wife/slot2 両対応）
  await Promise.all([
    supabase.from('users').update({ display_name: hName }).eq('pair_id', pairId).in('slot', ['husband', 'slot1']),
    supabase.from('users').update({ display_name: wName }).eq('pair_id', pairId).in('slot', ['wife', 'slot2'])
  ]);

  // 過去の支出の支払者名も同期更新
  if (before.husbandName !== hName) {
    await supabase.from('transactions').update({ payer_id: hName }).eq('pair_id', pairId).eq('payer_id', before.husbandName);
  }
  if (before.wifeName !== wName) {
    await supabase.from('transactions').update({ payer_id: wName }).eq('pair_id', pairId).eq('payer_id', before.wifeName);
  }

  await writeAudit(supabase, actor, pairId, '更新', 'メンバー・基本拠出設定', 'base', before, {
    husbandName: hName,
    wifeName: wName,
    husband: hv,
    wife: wv
  });

  return { success: true };
}

// Geminiモデルキャッシュ (10分間有効)
let geminiModelsCache = {
  timestamp: 0,
  models: []
};

/**
 * 利用可能なGeminiモデルをGoogle AI Studioから動的に取得しスコアリングして返す
 */
async function getAvailableGeminiModels(apiKey) {
  const now = Date.now();
  if (geminiModelsCache.models.length > 0 && (now - geminiModelsCache.timestamp < 10 * 60 * 1000)) {
    return geminiModelsCache.models;
  }

  const fallbackModels = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.5-flash'
  ];

  if (!apiKey) return fallbackModels;

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models';
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey }
    });

    if (!res.ok) {
      console.warn(`Gemini models.list failed: ${res.status}`);
      return fallbackModels;
    }

    const data = await res.json();
    const rawList = Array.isArray(data.models) ? data.models : [];

    // generateContent をサポートし、gemini 系かつ画像・特殊除外対象でないモデルを抽出
    const candidates = rawList
      .filter(m => {
        const canGenerate = Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent');
        const isGemini = /^models\/gemini/i.test(m.name || '');
        const isExcluded = /embedding|imagen|image|veo|aqa|tts|audio|live|robotics|computer-use|learnlm|gemma|thinking|customtools|bisheng/i.test(m.name || '');
        return canGenerate && isGemini && !isExcluded;
      })
      .map(m => (m.name || '').replace(/^models\//i, '').trim())
      .filter(Boolean);

    if (candidates.length === 0) {
      return fallbackModels;
    }

    // スコアリングソート関数（高速な標準Flash・Flash-liteを最優先）
    function scoreModel(name) {
      let score = 0;
      const lower = name.toLowerCase();

      // 純粋な標準 Flash モデル（正規表現に完全一致）に +5000 の最優先ボーナス
      if (/^gemini-\d+(?:\.\d+)?-flash(?:-lite)?(?:-001|-002|-latest)?$/i.test(lower)) {
        score += 5000;
      }

      // flash優先（思考モードがなく超高速な flash-lite や高速 flash を最優先）
      if (lower.includes('flash')) {
        score += 1000;
        if (lower.includes('flash-lite')) {
          score += 300; // 最速・タイムアウト知らず
        } else {
          score += 200;
        }
      } else if (lower.includes('pro')) {
        score += 500;
      }

      // バージョン番号
      const vMatch = lower.match(/gemini-(\d+(?:\.\d+)?)/);
      if (vMatch) {
        const vNum = parseFloat(vMatch[1]) || 0;
        score += vNum * 50;
      }

      // 安定版優先
      if (!lower.includes('exp') && !lower.includes('preview') && !lower.includes('thinking')) {
        score += 100;
      } else {
        score -= 500;
      }

      return score;
    }

    candidates.sort((a, b) => scoreModel(b) - scoreModel(a));

    geminiModelsCache = {
      timestamp: now,
      models: candidates
    };

    return candidates;
  } catch (err) {
    console.warn('Gemini models.list fetch error:', err.message);
    return fallbackModels;
  }
}

/**
 * 品名キーワードからの品目別カテゴリ自動推定フォールバック (v2.8.0)
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

/**
 * レシートOCR (Gemini API)
 */
async function handleScanReceipt(data, actor) {
  if (!actor || (!actor.allowed && !actor.verified && !isDemoAllowed())) {
    return { success: false, code: 'AUTH', error: 'レシート読み取りにはLINEログインとメンバー登録が必要です' };
  }
  const apiKey = normalizeEnvSecret(process.env.GEMINI_API_KEY);
  if (!apiKey) return { success: false, error: 'Vercelの環境変数 GEMINI_API_KEY が未設定です' };

  const mime = String(data.mimeType || 'image/jpeg');
  const b64 = String(data.imageBase64 || '');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    return { success: false, error: '対応していない画像形式です' };
  }
  if (!b64 || b64.length > 7000000) {
    return { success: false, error: '画像が空、または大きすぎます' };
  }

  const prompt =
    'これは日本のレシート画像です。店名、購入日、明細を精確に読み取ってください。\n' +
    '【重要ルール1: 単価・数量・金額の行ズレ防止（日本のスーパー、ベイシア・イオン等）】\n' +
    '- 商品名のみの行（右端に金額印字がない行）の直下の行に「@単価 数量 小計金額」（例: "@52 2 ¥104"）が印字されている場合、その数量と金額は【必ず直上の商品名（例: まろやか絹豆腐）】のものである。絶対に直下の別商品（例: 白菜）と結びつけたり分断しないこと！\n' +
    '【重要ルール2: クーポン値引き・末尾マイナス表記（コストコ・スーパー等）】\n' +
    '- 金額の末尾に「-」「-T」「-E」「-A」が付いている表記（例: "700-T", "897-E", "897-"）や、先頭に「▲」「△」「-」が付く表記は、すべて【負の整数（例: -700, -897）】として出力すること！\n' +
    '- "CPN"（クーポン）、"TPD"、"値引"、"割引"、"クーポン" の行、またはその直下の値引き金額行は必ず負の整数（例: -700）の price にすること。\n' +
    '【重要ルール3: 返品・返金レシート（REFUND / 返金 / 返品）】\n' +
    '- レシート内に「REFUND」「返金」「返品」「RFND」「買上げ点数 : -1」、または合計金額の末尾に「-」（例: "合計 897-"）がある場合、そのレシートは返金レシートである。total およびすべての商品の price は必ず【負の整数（例: total: -897, price: -897）】で出力すること。\n' +
    '【重要ルール4: 整数円・検算】\n' +
    '- price は「その行の税込合計金額（数量×単価）」の整数円（値引きや返金は負の整数）。\n' +
    '- quantity は数量（不明なら1）。\n' +
    '- 品名はレシート表記のまま。ポイント・小計・合計・お釣り・税額の行は明細に含めない。\n' +
    '- date は yyyy-MM-dd。読み取れなければ空文字。\n' +
    '- total はレシートに印字された最終支払合計（税込）の整数円（返金なら負の整数）。読み取れなければ0。\n' +
    '- 各明細の price の合計（プラス分とマイナス値引き分の和）が total と一致するか検算すること。\n' +
    '【重要ルール5: 品目別カテゴリ自動推測 (v2.8.0)】\n' +
    '- 各品目の品名から最も適したカテゴリを自動判定し category に指定してください:\n' +
    '  - 食料品・生鮮食品・調味料・飲料・お菓子・パン → "食費"\n' +
    '  - 日用品・洗剤・ティッシュ・トイレットペーパー・ラップ・ゴミ袋・掃除用品・キッチン雑貨 → "日用品"\n' +
    '  - 医薬品・目薬・湿布・サプリメント・マスク・絆創膏 → "医療・健康"\n' +
    '  - 化粧品・コスメ・スキンケア・シートマスク・衣料品・ヘアケア → "衣服・美容"\n' +
    '  - レストラン・カフェ・テイクアウト弁当等で明確に外食の場合 → "外食"\n' +
    '  - その他・不明・値引き行 → 前後の品目と同じ、または "食費" もしくは "日用品"\n' +
    '必ず以下のJSON形式のみで出力してください:\n' +
    '{"store":"店名","date":"yyyy-MM-dd","total":528,"isRefund":false,"items":[{"name":"品名","category":"食費","quantity":1,"price":390},{"name":"クレラップ","category":"日用品","quantity":1,"price":218},{"name":"CPN値引","category":"食費","quantity":1,"price":-80}]}';

  // 最速・高互換のリクエストBody（余計なresponseSchemaを持たせずresponseMimeTypeのみで超高速推論）
  const requestBody = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0
    }
  };

  const availableModels = await getAvailableGeminiModels(apiKey);
  const customModel = normalizeEnvSecret(process.env.GEMINI_MODEL);

  let modelsToTry = [];
  if (customModel) {
    if (availableModels.includes(customModel)) {
      modelsToTry = [customModel, ...availableModels.filter(m => m !== customModel)];
    } else {
      modelsToTry = [...availableModels, customModel];
    }
  } else {
    modelsToTry = [...availableModels];
  }
  modelsToTry = Array.from(new Set(modelsToTry)).slice(0, 5);

  let res = null;
  let lastErrorDetail = '';
  const triedDetails = [];

  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      // 各モデルごとに最大8秒でタイムアウトし、次のモデルへフォールバック
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(8000)
      });

      if (res.ok) break;

      const errText = await res.text();
      lastErrorDetail = `${model}: ${res.status} ${errText.slice(0, 100)}`;
      triedDetails.push(lastErrorDetail);
      console.warn(`Gemini try failed: ${lastErrorDetail}`);
      if (res.status === 400 && /API_KEY_INVALID|key not valid/i.test(errText)) break;
    } catch (err) {
      lastErrorDetail = `${model}: ${err.name === 'TimeoutError' ? 'タイムアウト(8s)' : err.message}`;
      triedDetails.push(lastErrorDetail);
    }
  }

  if (!res || !res.ok) {
    return {
      success: false,
      error: `AI読み取りに失敗しました (試行: ${triedDetails.join(' | ')}): ${lastErrorDetail.slice(0, 150)}`
    };
  }

  try {
    const json = await res.json();
    const parts = json?.candidates?.[0]?.content?.parts || [];
    const textPart = [...parts].reverse().find(p => !p.thought && typeof p.text === 'string') || parts[0];
    const rawText = (textPart?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(rawText);

    // 返金レシートの判定（REFUND / 返金 / 返品 / 末尾マイナス）
    const isRefund = parsed.isRefund === true ||
                     Number(parsed.total) < 0 ||
                     /返金|返品|REFUND|RFND/i.test(parsed.store || '') ||
                     /返金|返品|REFUND|RFND|買上げ点数\s*:\s*-1/i.test(rawText) ||
                     /合計\s*[\d,]+-/i.test(rawText);

    let total = parseInt(parsed.total, 10) || 0;
    if (isRefund && total > 0) total = -total;

    let items = (parsed.items || []).slice(0, 60).map(it => {
      let p = parseInt(it.price, 10) || 0;
      const name = String(it.name || '').trim().slice(0, 50);
      // 返金レシートなら全商品明細の金額もマイナス化
      if (isRefund && p > 0) p = -p;
      // 品名が値引き・クーポンの場合でプラスならマイナス化
      if (/CPN|TPD|値引|割引|クーポン|▲|△/i.test(name) && p > 0) p = -p;
      let cat = String(it.category || '').trim();
      if (!cat || cat === '未分類') {
        cat = inferItemCategory(name);
      }
      return {
        name,
        category: cat,
        quantity: Math.min(99, Math.max(1, parseInt(it.quantity, 10) || 1)),
        price: p
      };
    }).filter(it => it.name && it.price !== 0);

    // 差額自動検算・符号反転補正（クーポン値引き等がプラスとして誤読されたケースを自動是正）
    const itemSum = items.reduce((s, it) => s + it.price, 0);
    const diff = itemSum - total;
    if (diff > 0 && diff % 2 === 0) {
      const targetHalf = diff / 2;
      const fixCandidate = items.find(it => it.price === targetHalf);
      if (fixCandidate) {
        fixCandidate.price = -fixCandidate.price;
      }
    }

    let storeName = String(parsed.store || '').trim().slice(0, 50);
    if (isRefund && !/返金|返品|REFUND/i.test(storeName)) {
      storeName = `${storeName || '店舗'} (返金)`;
    }

    return {
      success: true,
      receipt: {
        store: storeName,
        date: isValidDateStr(parsed.date) ? parsed.date : todayStr(),
        total: total,
        isRefund: isRefund,
        items: items
      }
    };
  } catch (err) {
    console.error('レシートパースエラー:', err);
    return { success: false, error: 'レシートを読み取れませんでした。明るい場所で撮影してください' };
  }
}

/**
 * レシート保存（receipts + receipt_items + transactions へのアトミック保存）
 */
async function handleSaveReceipt(supabase, data, actor) {
  const pairId = getTargetPairId(actor, data);
  const store = String(data.store || '').trim().slice(0, 50);
  if (!store) return { success: false, error: '店名を入力してください' };
  const date = data.date || todayStr();
  if (!isValidDateStr(date)) return { success: false, error: '日付の形式が正しくありません' };
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 60) {
    return { success: false, error: '明細は1〜60件で入力してください' };
  }

  const items = [];
  const defaultCategory = String(data.category || '食費').slice(0, 20);
  for (const it of data.items) {
    const name = String(it.name || '').trim().slice(0, 50);
    const qty = Number(it.quantity);
    const price = Number(it.price);
    const isShared = it.isShared !== false && String(it.isShared) !== 'false';
    const owner = String(it.owner || it.payer || '').trim();
    const itCat = String(it.category || defaultCategory).trim().slice(0, 20) || defaultCategory;
    if (!name || !Number.isInteger(qty) || qty < 1 || !Number.isInteger(price) || price === 0) {
      return { success: false, error: '明細の入力内容が不正です: ' + name };
    }
    items.push({ name, qty, price, unitPrice: Math.round(price / qty), isShared, owner, category: itCat });
  }

  const total = items.reduce((s, it) => s + it.price, 0);
  if (total === 0) return { success: false, error: '合計金額が0円です' };

  const payer = String(data.payer || actor.name).trim();
  const paymentType = data.paymentType || 'shared_card';
  const category = defaultCategory;

  // 1. receipts 登録
  const { data: recRow, error: recErr } = await supabase.from('receipts').insert({
    pair_id: pairId,
    date: date,
    store_name: store,
    total_amount: total,
    scanned_by: actor.name
  }).select('id').single();

  if (recErr) {
    console.error('receipts登録失敗:', recErr);
    return { success: false, error: 'レシート保存に失敗しました' };
  }

  const receiptId = recRow.id;

  // 2. receipt_items 登録（品目別カテゴリ保存 v2.8.0）
  const itemRows = items.map(it => ({
    receipt_id: receiptId,
    item_name: it.name,
    normalized_name: normalizeName(it.name),
    quantity: it.qty,
    price: it.price,
    unit_price: it.unitPrice,
    category_id: it.category || category
  }));

  const { error: itemErr } = await supabase.from('receipt_items').insert(itemRows);
  if (itemErr) {
    console.error('receipt_items登録失敗:', itemErr);
  }

  // 3. transactions 登録（カテゴリ別 ＆ 共同/私物マルチ分割対応 v2.8.0）
  const createdTxIds = [];

  // A. 共同生活費分（カテゴリ別にグループ化）
  const sharedByCat = {};
  items.filter(it => it.isShared).forEach(it => {
    const cat = it.category || category;
    if (!sharedByCat[cat]) sharedByCat[cat] = [];
    sharedByCat[cat].push(it);
  });
  const sharedCatEntries = Object.entries(sharedByCat);

  for (const [cat, catItems] of sharedCatEntries) {
    const catTotal = catItems.reduce((s, it) => s + it.price, 0);
    if (catTotal === 0) continue;
    const txTitle = sharedCatEntries.length > 1 ? `${store} (${cat})` : store;
    const { data: txSharedData } = await supabase.from('transactions').insert({
      pair_id: pairId,
      date: date,
      title: txTitle,
      amount: catTotal,
      category_id: cat,
      is_shared: true,
      payment_type: paymentType,
      payer_id: (paymentType === 'shared_card' ? '共同' : payer),
      memo: `レシート読み取り（共同生活費・${cat}分）`,
      created_by: actor.name,
      receipt_id: receiptId
    }).select('id').single();
    if (txSharedData?.id) createdTxIds.push(txSharedData.id);
  }

  // B. 私物分（メンバー別 ＆ カテゴリ別にグループ化）
  const personalGroups = {};
  items.filter(it => !it.isShared).forEach(it => {
    const ownerName = String(it.owner || it.payer || payer).trim() || payer;
    const cat = it.category || category;
    const key = `${ownerName}___${cat}`;
    if (!personalGroups[key]) personalGroups[key] = { owner: ownerName, category: cat, items: [] };
    personalGroups[key].items.push(it);
  });
  const personalEntries = Object.values(personalGroups);

  for (const grp of personalEntries) {
    const ownerTotal = grp.items.reduce((s, it) => s + it.price, 0);
    if (ownerTotal === 0) continue;
    const txTitle = `${store} (${grp.owner}私物・${grp.category})`;
    const { data: txPersonalData } = await supabase.from('transactions').insert({
      pair_id: pairId,
      date: date,
      title: txTitle,
      amount: ownerTotal,
      category_id: grp.category,
      is_shared: false,
      payment_type: paymentType,
      payer_id: grp.owner,
      memo: `レシート読み取り（${grp.owner}私物・${grp.category}・要返還）`,
      created_by: actor.name,
      receipt_id: receiptId
    }).select('id').single();
    if (txPersonalData?.id) createdTxIds.push(txPersonalData.id);
  }

  const txId = createdTxIds[0] || null;
  await writeAudit(supabase, actor, pairId, '追加', 'レシート', txId, null, {
    receiptId, date, title: store, amount: total, items
  });

  // 4. 買い物リストの自動消込（設定が有効な場合）
  const autoCheckedShoppingItems = [];
  try {
    const config = await getConfigData(supabase, pairId);
    if (config.autoCheckShoppingOnReceipt !== false) {
      const { data: openShoppingItems } = await supabase
        .from('shopping_items')
        .select('*')
        .eq('pair_id', pairId)
        .eq('is_completed', false);

      if (openShoppingItems && openShoppingItems.length > 0) {
        const toCompleteIds = [];
        for (const shopItem of openShoppingItems) {
          const shopNorm = normalizeName(shopItem.title || shopItem.name || '');
          if (!shopNorm) continue;
          const isPurchased = items.some(it => {
            const recNorm = normalizeName(it.name);
            if (!recNorm) return false;
            if (recNorm === shopNorm) return true;
            if (shopNorm.length >= 2 && recNorm.includes(shopNorm)) return true;
            if (recNorm.length >= 2 && shopNorm.includes(recNorm)) return true;
            return false;
          });
          if (isPurchased) {
            toCompleteIds.push(shopItem.id);
            autoCheckedShoppingItems.push(shopItem.title || shopItem.name);
          }
        }

        if (toCompleteIds.length > 0) {
          await supabase
            .from('shopping_items')
            .update({ is_completed: true, completed_at: new Date().toISOString() })
            .in('id', toCompleteIds);
        }
      }
    }
  } catch (err) {
    console.warn('買い物リスト自動消込エラー (非致命的):', err);
  }

  return { success: true, receiptId, txId, total, autoCheckedShoppingItems };
}

/**
 * レシート・明細・内訳の更新 (手修正解禁 ＆ 変更履歴 audit_logs 記録)
 */
async function handleUpdateReceipt(supabase, data, actor) {
  const pairId = getTargetPairId(actor, data);
  const receiptId = String(data.receiptId || data.id || '').trim();
  if (!receiptId) return { success: false, error: 'レシートIDが指定されていません' };

  const store = String(data.store || '').trim().slice(0, 50);
  if (!store) return { success: false, error: '店名を入力してください' };
  const date = data.date || todayStr();
  if (!isValidDateStr(date)) return { success: false, error: '日付の形式が正しくありません' };

  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 60) {
    return { success: false, error: '明細は1〜60件で入力してください' };
  }

  // 既存レシートと明細を取得（Before の記録用）
  const { data: oldRec } = await supabase.from('receipts').select('*').eq('id', receiptId).eq('pair_id', pairId).single();
  if (!oldRec) return { success: false, error: '更新対象のレシートが見つかりません' };

  const { data: oldItems } = await supabase.from('receipt_items').select('*').eq('receipt_id', receiptId);

  const items = [];
  const defaultCategory = String(data.category || '食費').slice(0, 20);
  for (const it of data.items) {
    const name = String(it.name || '').trim().slice(0, 50);
    const qty = Number(it.quantity);
    const price = Number(it.price);
    const isShared = it.isShared !== false && String(it.isShared) !== 'false';
    const owner = String(it.owner || it.payer || '').trim();
    const itCat = String(it.category || defaultCategory).trim().slice(0, 20) || defaultCategory;
    if (!name || !Number.isInteger(qty) || qty < 1 || !Number.isInteger(price) || price === 0) {
      return { success: false, error: '明細の入力内容が不正です: ' + name };
    }
    items.push({ name, qty, price, unitPrice: Math.round(price / qty), isShared, owner, category: itCat });
  }

  const total = items.reduce((s, it) => s + it.price, 0);
  if (total === 0) return { success: false, error: '合計金額が0円です' };

  // 1. receipts テーブル更新
  await supabase.from('receipts').update({
    store_name: store,
    date: date,
    total_amount: total
  }).eq('id', receiptId).eq('pair_id', pairId);

  // 2. 既存の receipt_items を一旦削除して再挿入（品目別カテゴリ保存 v2.8.0）
  await supabase.from('receipt_items').delete().eq('receipt_id', receiptId);

  const payer = String(data.payer || actor.name).trim();
  const paymentType = data.paymentType || 'shared_card';
  const category = defaultCategory;

  const itemRows = items.map(it => ({
    receipt_id: receiptId,
    item_name: it.name,
    normalized_name: normalizeName(it.name),
    quantity: it.qty,
    price: it.price,
    unit_price: it.unitPrice,
    category_id: it.category || category
  }));
  await supabase.from('receipt_items').insert(itemRows);

  // 3. transactions の更新（カテゴリ別 ＆ 共同/私物マルチ分割対応 v2.8.0）
  await supabase.from('transactions').delete().eq('receipt_id', receiptId).eq('pair_id', pairId);

  // A. 共同生活費分（カテゴリ別にグループ化）
  const sharedByCat = {};
  items.filter(it => it.isShared).forEach(it => {
    const cat = it.category || category;
    if (!sharedByCat[cat]) sharedByCat[cat] = [];
    sharedByCat[cat].push(it);
  });
  const sharedCatEntries = Object.entries(sharedByCat);

  for (const [cat, catItems] of sharedCatEntries) {
    const catTotal = catItems.reduce((s, it) => s + it.price, 0);
    if (catTotal === 0) continue;
    const txTitle = sharedCatEntries.length > 1 ? `${store} (${cat})` : store;
    await supabase.from('transactions').insert({
      pair_id: pairId,
      date: date,
      title: txTitle,
      amount: catTotal,
      category_id: cat,
      is_shared: true,
      payment_type: paymentType,
      payer_id: (paymentType === 'shared_card' ? '共同' : payer),
      memo: `レシート修正（共同生活費・${cat}分）`,
      created_by: actor.name,
      receipt_id: receiptId
    });
  }

  // B. 私物分（メンバー別 ＆ カテゴリ別にグループ化）
  const personalGroups = {};
  items.filter(it => !it.isShared).forEach(it => {
    const ownerName = String(it.owner || it.payer || payer).trim() || payer;
    const cat = it.category || category;
    const key = `${ownerName}___${cat}`;
    if (!personalGroups[key]) personalGroups[key] = { owner: ownerName, category: cat, items: [] };
    personalGroups[key].items.push(it);
  });
  const personalEntries = Object.values(personalGroups);

  for (const grp of personalEntries) {
    const ownerTotal = grp.items.reduce((s, it) => s + it.price, 0);
    if (ownerTotal === 0) continue;
    const txTitle = `${store} (${grp.owner}私物・${grp.category})`;
    await supabase.from('transactions').insert({
      pair_id: pairId,
      date: date,
      title: txTitle,
      amount: ownerTotal,
      category_id: grp.category,
      is_shared: false,
      payment_type: paymentType,
      payer_id: grp.owner,
      memo: `レシート修正（${grp.owner}私物・${grp.category}・要返還）`,
      created_by: actor.name,
      receipt_id: receiptId
    });
  }

  // 4. 変更履歴 (audit_logs) 記録
  await writeAudit(supabase, actor, pairId, '更新', 'レシート', receiptId, {
    store: oldRec.store_name,
    date: oldRec.date,
    total: oldRec.total_amount,
    itemCount: oldItems?.length || 0
  }, {
    store,
    date,
    total,
    items,
    sharedAmount: totalShared,
    personalAmount: totalPersonal
  });

  return { success: true, receiptId, total };
}

/**
 * 価格検索 (searchPrices: 表記揺れ吸収型スマート検索 v2.8.0)
 */
async function handleSearchPrices(supabase, query, actor) {
  const pairId = getTargetPairId(actor, {});
  const keywords = expandSearchKeywords(query);
  if (keywords.length === 0) return { success: false, error: '検索する品名を入力してください' };

  const config = await getConfigData(supabase, pairId);
  const actorSlot = resolvePayerSlot(actor?.name, config);

  const { data: privTxs } = await supabase
    .from('transactions')
    .select('receipt_id, payer_id, is_shared')
    .eq('pair_id', pairId)
    .not('receipt_id', 'is', null)
    .eq('is_shared', false);

  const excludedReceiptIds = new Set();
  (privTxs || []).forEach(t => {
    const s = resolvePayerSlot(t.payer_id, config);
    if (s !== actorSlot && t.payer_id !== actor?.name) {
      excludedReceiptIds.add(t.receipt_id);
    }
  });

  // シノニム展開された全キーワードで OR 検索（白菜/はくさい/ハクサイ等すべての表記を網羅）
  const normKeywords = Array.from(new Set(keywords.map(k => normalizeName(k)).filter(Boolean)));
  const orConditions = normKeywords.map(k => `normalized_name.ilike.%${k}%`).join(',');

  let queryBuilder = supabase
    .from('receipt_items')
    .select('id, receipt_id, item_name, normalized_name, quantity, price, unit_price, receipts!inner(date, store_name, pair_id)')
    .eq('receipts.pair_id', pairId)
    .gt('price', 0)
    .gt('unit_price', 0);

  if (orConditions) {
    queryBuilder = queryBuilder.or(orConditions);
  }

  const { data: matchedItems } = await queryBuilder;

  const getReceiptData = (it) => {
    if (!it || !it.receipts) return { date: '', store_name: '不明' };
    if (Array.isArray(it.receipts)) return it.receipts[0] || { date: '', store_name: '不明' };
    return it.receipts;
  };

  const filtered = (matchedItems || [])
    .filter(it => !excludedReceiptIds.has(it.receipt_id))
    .sort((a, b) => {
      const dateA = getReceiptData(a).date || '';
      const dateB = getReceiptData(b).date || '';
      return dateA < dateB ? 1 : -1;
    });

  if (filtered.length === 0) {
    return { success: true, query, count: 0, stats: null, byStore: [], history: [] };
  }

  const prices = filtered.map(f => Number(f.unit_price) || 0);
  const minItem = filtered.slice().sort((a, b) => (Number(a.unit_price) || 0) - (Number(b.unit_price) || 0))[0];
  const latestItem = filtered[0];
  const latestRec = getReceiptData(latestItem);
  const minRec = getReceiptData(minItem);

  const stats = {
    latest: Number(latestItem.unit_price) || 0,
    latestStore: latestRec.store_name || '不明',
    latestDate: latestRec.date || '',
    min: Number(minItem.unit_price) || 0,
    minStore: minRec.store_name || '不明',
    minDate: minRec.date || '',
    max: Math.max(...prices),
    avg: Math.round(prices.reduce((s, p) => s + p, 0) / prices.length)
  };

  const storeMap = {};
  filtered.forEach(it => {
    const rec = getReceiptData(it);
    const sName = rec.store_name || '不明';
    const uPrice = Number(it.unit_price) || 0;
    if (!storeMap[sName]) {
      storeMap[sName] = {
        store: sName,
        latest: uPrice,
        latestDate: rec.date || '',
        min: uPrice,
        minUnitPrice: uPrice,
        count: 0,
        total: 0
      };
    }
    const sm = storeMap[sName];
    sm.min = Math.min(sm.min, uPrice);
    sm.minUnitPrice = sm.min;
    sm.count++;
    sm.total += uPrice;
    sm.avgUnitPrice = Math.round(sm.total / sm.count);
  });

  return {
    success: true,
    query,
    count: filtered.length,
    stats,
    byStore: Object.values(storeMap).sort((a, b) => a.min - b.min),
    history: filtered.slice(0, 100).map(it => {
      const rec = getReceiptData(it);
      return {
        date: rec.date || '',
        store: rec.store_name || '不明',
        name: it.item_name,
        quantity: Number(it.quantity) || 1,
        price: Number(it.price) || 0,
        unitPrice: Number(it.unit_price) || 0
      };
    })
  };
}

/**
 * 監査ログ取得
 */
async function handleGetAuditLog(supabase, params, actor) {
  const pairId = getTargetPairId(actor, params);
  const limit = Math.min(Math.max(Number(params?.limit) || 50, 1), 200);
  let query = supabase.from('audit_logs').select('*').eq('pair_id', pairId).order('timestamp', { ascending: false }).limit(limit);
  if (params?.targetId) {
    query = query.eq('target_id', String(params.targetId));
  }
  const { data, error } = await query;
  if (error) return { success: false, error: '監査ログの取得に失敗しました' };

  return {
    success: true,
    logs: (data || []).map(r => ({
      at: r.timestamp,
      actor: r.actor_id,
      verified: true,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      before: r.before_data,
      after: r.after_data
    }))
  };
}

// ==========================================
// 臨時お金管理・旅行イベント精算アクション
// ==========================================

/**
 * イベント一覧取得（有効期限内のもの、残り日数付き、30日経過自動パージ、完全分離）
 */
async function handleGetEvents(supabase, actor, params) {
  await purgeExpiredEvents(supabase);
  const pairId = getTargetPairId(actor, params);

  // 当該ペアのイベントを取得（完全分離）
  const { data: events, error } = await supabase
    .from('events')
    .select('*, event_expenses(id, amount)')
    .eq('pair_id', pairId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('イベント一覧取得エラー:', error);
    return { success: false, error: 'イベントの取得に失敗しました' };
  }

  const now = Date.now();
  const formatted = (events || []).map(e => {
    const expDate = new Date(e.expires_at).getTime();
    const daysLeft = Math.max(0, Math.ceil((expDate - now) / (1000 * 60 * 60 * 24)));
    const totalAmount = (e.event_expenses || []).reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
    const expenseCount = (e.event_expenses || []).length;

    return {
      id: e.id,
      title: e.title,
      members: e.members || [],
      createdAt: e.created_at?.slice(0, 10),
      expiresAt: e.expires_at?.slice(0, 10),
      daysLeft: daysLeft,
      totalAmount: totalAmount,
      expenseCount: expenseCount
    };
  });

  return { success: true, events: formatted };
}

/**
 * イベント新規作成
 */
async function handleCreateEvent(supabase, actor, data) {
  const pairId = getTargetPairId(actor, data);
  const title = String(data?.title || '').trim().slice(0, 50);
  if (!title) return { success: false, error: 'イベント名（タイトル）を入力してください' };

  let members = data?.members;
  if (typeof members === 'string') {
    members = members.split(/[,、\s]+/).map(m => m.trim()).filter(Boolean);
  }
  if (!Array.isArray(members) || members.length < 2) {
    return { success: false, error: '参加者は2名以上入力してください（例: 自分, パートナー, 友人A）' };
  }
  members = members.slice(0, 15).map(m => String(m).trim().slice(0, 20)).filter(Boolean);

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: inserted, error } = await supabase.from('events').insert({
    pair_id: pairId,
    title: title,
    members: members,
    expires_at: expiresAt
  }).select('*').single();

  if (error) {
    console.error('イベント作成エラー:', error);
    return { success: false, error: 'イベントの作成に失敗しました' };
  }

  await writeAudit(supabase, actor, pairId, '作成', 'イベント', inserted.id, null, { title, members });

  return {
    success: true,
    event: {
      id: inserted.id,
      title: inserted.title,
      members: inserted.members,
      createdAt: inserted.created_at?.slice(0, 10),
      expiresAt: inserted.expires_at?.slice(0, 10),
      daysLeft: 30,
      totalAmount: 0,
      expenseCount: 0
    }
  };
}

/**
 * イベント手動削除（IDOR防御: pair_idを厳格照合）
 */
async function handleDeleteEvent(supabase, actor, id) {
  const pairId = getTargetPairId(actor, {});
  if (!id) return { success: false, error: 'イベントIDが必要です' };

  const { data: before } = await supabase.from('events').select('*').eq('id', id).eq('pair_id', pairId).maybeSingle();
  if (!before) return { success: false, error: '削除対象のイベントが見つからないか、権限がありません' };

  const { error } = await supabase.from('events').delete().eq('id', id).eq('pair_id', pairId);
  if (error) return { success: false, error: 'イベントの削除に失敗しました' };

  await writeAudit(supabase, actor, pairId, '削除', 'イベント', id, before, null);
  return { success: true };
}

/**
 * イベント支出登録（IDOR防御: 親イベントが所属ペアのものか検証）
 */
async function handleAddEventExpense(supabase, actor, data) {
  const pairId = getTargetPairId(actor, data);
  const eventId = data?.eventId;
  if (!eventId) return { success: false, error: 'イベントIDが必要です' };

  // 親イベントの所属ペア検証
  const { data: evCheck } = await supabase.from('events').select('id').eq('id', eventId).eq('pair_id', pairId).maybeSingle();
  if (!evCheck) {
    return { success: false, error: '対象のイベントが見つからないか、権限がありません' };
  }

  const title = String(data?.title || '').trim().slice(0, 50);
  if (!title) return { success: false, error: '支出名を入力してください' };
  const amount = Number(data?.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 10000000) {
    return { success: false, error: '金額は1円以上の整数で入力してください' };
  }
  const payer = String(data?.payer || actor?.name || '').trim().slice(0, 20);
  if (!payer) return { success: false, error: '支払者を入力してください' };

  let beneficiaries = data?.beneficiaries;
  if (Array.isArray(beneficiaries) && beneficiaries.length === 0) {
    beneficiaries = null; // 全員均等割り
  }

  const { data: inserted, error } = await supabase.from('event_expenses').insert({
    event_id: eventId,
    title: title,
    amount: amount,
    payer: payer,
    beneficiaries: beneficiaries || null
  }).select('*').single();

  if (error) {
    console.error('イベント支出登録エラー:', error);
    return { success: false, error: 'イベント支出の登録に失敗しました' };
  }

  return { success: true, expense: inserted };
}

/**
 * イベント支出削除（IDOR防御: 支出の親イベントが所属ペアのものか検証）
 */
async function handleDeleteEventExpense(supabase, actor, id) {
  const pairId = getTargetPairId(actor, {});
  if (!id) return { success: false, error: '支出IDが必要です' };

  // 支出と親イベントの所属ペアを検証
  const { data: exp } = await supabase
    .from('event_expenses')
    .select('id, event_id, events!inner(pair_id)')
    .eq('id', id)
    .maybeSingle();

  if (!exp || exp.events?.pair_id !== pairId) {
    return { success: false, error: '削除対象の支出が見つからないか、権限がありません' };
  }

  const { error } = await supabase.from('event_expenses').delete().eq('id', id);
  if (error) return { success: false, error: '支出の削除に失敗しました' };
  return { success: true };
}

/**
 * イベント精算サマリー計算（IDOR防御: イベントが所属ペアのものか検証）
 */
async function handleGetEventSettlement(supabase, actor, eventId) {
  const pairId = getTargetPairId(actor, {});
  if (!eventId) return { success: false, error: 'イベントIDが必要です' };

  const [eventRes, expRes] = await Promise.all([
    supabase.from('events').select('*').eq('id', eventId).eq('pair_id', pairId).maybeSingle(),
    supabase.from('event_expenses').select('*').eq('event_id', eventId).order('created_at', { ascending: false })
  ]);

  if (!eventRes.data) return { success: false, error: '対象のイベントが見つからないか、権限がありません' };

  const event = eventRes.data;
  const expenses = expRes.data || [];
  const members = event.members || [];

  // 各メンバーの立替額 (paid) と 負担額 (shouldPay) の集計
  const paidMap = {};
  const shouldPayMap = {};
  members.forEach(m => {
    paidMap[m] = 0;
    shouldPayMap[m] = 0;
  });

  let totalEventExpense = 0;

  expenses.forEach(x => {
    const amt = Number(x.amount) || 0;
    totalEventExpense += amt;

    // 支払者への加算
    if (paidMap[x.payer] !== undefined) {
      paidMap[x.payer] += amt;
    } else {
      paidMap[x.payer] = amt;
    }

    // 負担者の計算
    const targetMembers = (Array.isArray(x.beneficiaries) && x.beneficiaries.length > 0)
      ? x.beneficiaries
      : members;

    if (targetMembers.length > 0) {
      const splitAmount = amt / targetMembers.length;
      targetMembers.forEach(tm => {
        if (shouldPayMap[tm] !== undefined) {
          shouldPayMap[tm] += splitAmount;
        } else {
          shouldPayMap[tm] = splitAmount;
        }
      });
    }
  });

  // 純残高 (balance = paid - shouldPay) の計算
  const balances = {};
  const allMembers = Array.from(new Set([...members, ...Object.keys(paidMap), ...Object.keys(shouldPayMap)]));

  const memberSummaries = allMembers.map(m => {
    const paid = Math.round(paidMap[m] || 0);
    const shouldPay = Math.round(shouldPayMap[m] || 0);
    const balance = paid - shouldPay;
    balances[m] = balance;
    return {
      name: m,
      paid: paid,
      shouldPay: shouldPay,
      balance: balance
    };
  });

  // 最小送金ステップを算出
  const transfers = simplifyDebts(balances);

  const daysLeft = Math.max(0, Math.ceil((new Date(event.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

  return {
    success: true,
    event: {
      id: event.id,
      title: event.title,
      members: members,
      createdAt: event.created_at?.slice(0, 10),
      expiresAt: event.expires_at?.slice(0, 10),
      daysLeft: daysLeft,
      totalAmount: totalEventExpense
    },
    expenses: expenses.map(x => ({
      id: x.id,
      title: x.title,
      amount: Number(x.amount),
      payer: x.payer,
      beneficiaries: x.beneficiaries,
      createdAt: x.created_at?.slice(0, 10)
    })),
    memberSummaries: memberSummaries,
    transfers: transfers // [{ from: '妻', to: '夫', amount: 3200 }, ...]
  };
}

// ==========================================
// LINE Bot Webhook メッセージ処理部
// ==========================================

// LINE対話型レシート編集セッション管理 (v2.7.0)
const lineReceiptEditSessions = new Map();

async function getReceiptEditSession(supabase, pairId, userId) {
  const cached = lineReceiptEditSessions.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  try {
    const { data: setting } = await supabase
      .from('app_settings')
      .select('value')
      .eq('pair_id', pairId)
      .eq('key', `lineReceiptEdit_${userId}`)
      .maybeSingle();
    if (setting && setting.value) {
      const sess = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
      if (sess && sess.expiresAt > Date.now()) {
        lineReceiptEditSessions.set(userId, sess);
        return sess;
      }
    }
  } catch (_) {}
  return null;
}

async function saveReceiptEditSession(supabase, pairId, userId, session) {
  if (session) {
    lineReceiptEditSessions.set(userId, session);
    await setAppSetting(supabase, pairId, `lineReceiptEdit_${userId}`, session);
  } else {
    lineReceiptEditSessions.delete(userId);
    await setAppSetting(supabase, pairId, `lineReceiptEdit_${userId}`, null);
  }
}

async function sendLineReply(replyToken, messagesOrText, token) {
  if (!token || !replyToken) return;
  try {
    let messages = [];
    if (Array.isArray(messagesOrText)) {
      messages = messagesOrText.slice(0, 5);
    } else if (typeof messagesOrText === 'object' && messagesOrText !== null) {
      messages = [messagesOrText];
    } else {
      messages = [{ type: 'text', text: String(messagesOrText).slice(0, 4900) }];
    }

    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        replyToken,
        messages
      })
    });
  } catch (err) {
    console.error('LINE返信エラー:', err);
  }
}

/**
 * 月次収支レポートデータ生成（Webモーダル & LINE共用）
 */
async function getMonthlyReportData(supabase, actor, pairId, targetMonth) {
  const m = targetMonth || currentMonthStr();
  const initData = await handleGetInitialData(supabase, m, actor, pairId);
  const s = initData.summary || {};
  const config = await getConfigData(supabase, pairId);

  // カテゴリ別支出集計
  const catSums = {};
  (initData.transactions || []).filter(t => t.isShared).forEach(t => {
    const c = t.category || '未分類';
    catSums[c] = (catSums[c] || 0) + Number(t.amount || 0);
  });

  const sortedCats = Object.entries(catSums).sort((a, b) => b[1] - a[1]);
  const catLabels = sortedCats.map(x => x[0]);
  const catValues = sortedCats.map(x => x[1]);

  const catColors = ['#10B981', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#6366F1', '#14B8A6'];

  // QuickChart ドーナツグラフURL生成
  let chartUrl = '';
  if (catValues.length > 0) {
    const chartConfig = {
      type: 'doughnut',
      data: {
        labels: catLabels,
        datasets: [{
          data: catValues,
          backgroundColor: catColors.slice(0, catValues.length)
        }]
      },
      options: {
        plugins: {
          legend: { position: 'right' },
          title: { display: true, text: `${m} 家計支出内訳 (計 ¥${s.totalExpense.toLocaleString()})` }
        }
      }
    };
    chartUrl = `https://quickchart.io/chart?w=600&h=360&bkg=white&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
  }

  // 共同積立貯金の最新残高
  const initialSavings = Number(config.savingsConfig?.initialSavings || 0);
  const monthlyInterests = config.savingsConfig?.monthlyInterests || {};
  const monthlyBalances = config.savingsConfig?.monthlyBalances || {};
  let totalSavings = initialSavings;
  (initData.monthlyTotals || []).forEach(t => {
    const hasManual = monthlyBalances[t.month] !== undefined && monthlyBalances[t.month] !== '' && !isNaN(Number(monthlyBalances[t.month]));
    const hasInt = Number(monthlyInterests[t.month] || 0) > 0;
    const isPast = t.month < currentMonthStr() && Number(t.shared || 0) > 0;
    if (hasManual || hasInt || isPast) {
      const bal = hasManual ? Number(monthlyBalances[t.month]) : (Number(t.budget || 240000) - Number(t.shared || 0));
      totalSavings += (bal + Number(monthlyInterests[t.month] || 0));
    }
  });

  // メンバー別支出集計（安全計算）
  const hName = config.husbandName || '夫';
  const wName = config.wifeName || '妻';
  let husbandSpent = 0;
  let wifeSpent = 0;
  (initData.transactions || []).forEach(t => {
    const amt = Number(t.amount || 0);
    const slot = resolvePayerSlot(t.payer, config);
    if (slot === 'husband' || t.payer === hName) {
      husbandSpent += amt;
    } else if (slot === 'wife' || t.payer === wName) {
      wifeSpent += amt;
    }
  });
  s.husbandSpent = husbandSpent;
  s.wifeSpent = wifeSpent;

  // テキストメッセージ作成
  const percent = s.budget > 0 ? Math.round((s.totalExpense / s.budget) * 100) : 0;
  const diff = s.remaining;
  const catLines = sortedCats.slice(0, 5).map(x => {
    const ratio = s.totalExpense > 0 ? Math.round((x[1] / s.totalExpense) * 100) : 0;
    return `・${x[0]}: ¥${x[1].toLocaleString()} (${ratio}%)`;
  }).join('\n');

  const [y, mm] = m.split('-');
  const monthTitle = `${Number(y)}年${Number(mm)}月`;

  const reportText = `📊【${monthTitle} 家計収支レポート】\n` +
    `━━━━━━━━━━━━━━\n` +
    `💰 生活費予算: ¥${(s.budget || 0).toLocaleString()}\n` +
    `💸 支出合計: ¥${(s.totalExpense || 0).toLocaleString()} (予算比 ${percent}%)\n` +
    `✨ 今月の収支: ${diff >= 0 ? `+¥${diff.toLocaleString()} (黒字)` : `-¥${Math.abs(diff).toLocaleString()} (赤字)`}\n\n` +
    `【部門別支出 TOP】\n` +
    (catLines || '・支出データなし') + `\n\n` +
    `【メンバー別支出】\n` +
    `・${hName}: ¥${husbandSpent.toLocaleString()}\n` +
    `・${wName}: ¥${wifeSpent.toLocaleString()}\n` +
    `━━━━━━━━━━━━━━\n` +
    `🏦 共同積立貯蓄残高: ¥${totalSavings.toLocaleString()}\n` +
    `💡 アプリ画面で過去月レポートやグラフも確認できます✨`;

  return {
    success: true,
    month: m,
    summary: s,
    chartUrl,
    categories: sortedCats.map(([name, amount]) => ({ name, amount })),
    reportText,
    totalSavings
  };
}

async function generateMonthlyReportMessage(supabase, actor, pairId, config) {
  const report = await getMonthlyReportData(supabase, actor, pairId, currentMonthStr());
  if (report.chartUrl) {
    return [
      {
        type: 'image',
        originalContentUrl: report.chartUrl,
        previewImageUrl: report.chartUrl
      },
      {
        type: 'text',
        text: report.reportText
      }
    ];
  }
  return report.reportText;
}

async function processNaturalLanguageMessage(supabase, text, userId) {
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  // ユーザー特定（所属ペアも取得）
  const { data: user } = await supabase.from('users').select('*, pairs(*)').eq('line_user_id', userId).maybeSingle();
  const pairId = user?.pair_id || DEFAULT_PAIR_ID;
  const config = await getConfigData(supabase, pairId);

  // 1. メンバー登録コマンド
  const regMatch = text.match(/^(.{1,15})として登録(?:\s+(.+))?$/);
  if (regMatch) {
    const customName = regMatch[1].trim();
    const codeArg = (regMatch[2] || '').trim();
    const reqCode = process.env.REGISTER_CODE;
    if (!reqCode) {
      return '🔒 セキュリティ保護のため、アカウント登録はLINE内の「ふたり家計簿」アプリを開いて登録ボタンを押してください✨';
    }
    if (codeArg !== reqCode) {
      return '合言葉が一致しません。「表示名として登録 合言葉」の形式で送信するか、アプリ画面から登録してください。';
    }
    if (['共同', 'all', '未認証', '自動計上'].includes(customName)) {
      return `「${customName}」はシステム予約語のため使用できません。`;
    }

    const { data: pairUsers } = await supabase.from('users').select('*').eq('pair_id', pairId);
    if ((pairUsers || []).some(u => u.line_user_id === userId)) {
      return 'このアカウントは既に登録されています。表示名の変更はアプリの「設定」タブから行えます。';
    }
    const hasHusband = (pairUsers || []).some(u => u.slot === 'husband' || u.slot === 'slot1');
    const hasWife = (pairUsers || []).some(u => u.slot === 'wife' || u.slot === 'slot2');
    const slot = !hasHusband ? 'husband' : (!hasWife ? 'wife' : '');
    if (!slot) return '2名分の枠が既に登録済みです。';

    await supabase.from('users').insert({ line_user_id: userId, pair_id: pairId, slot, display_name: customName });
    await supabase.from('app_settings').upsert({ pair_id: pairId, key: slot === 'husband' ? 'husbandName' : 'wifeName', value: customName }, { onConflict: 'pair_id, key' });
    await writeAudit(supabase, { name: customName }, pairId, '登録', 'メンバー', customName, null, { slot, role: customName });
    return `✅ このアカウントを「${customName}」として登録しました！`;
  }

  if (!user) {
    return '初回設定です。LINEのメニューから「ふたり家計簿」アプリを開いて、メンバー登録してください✨';
  }
  const actor = { allowed: true, verified: true, name: user.display_name, userId, slot: user.slot, pairId: user.pair_id };

  // 2. 保留中の重複確認への返答（登録 / キャンセル）
  const pending = await getAppSetting(supabase, pairId, 'pendingLineConfirmation', null);
  if (pending && pending.createdAt && (Date.now() - pending.createdAt < 15 * 60 * 1000)) {
    if (/^(?:登録|登録する|はい|ok|OK|お願いします)$/i.test(text)) {
      await setAppSetting(supabase, pairId, 'pendingLineConfirmation', null);
      if (pending.type === 'receipt') {
        const saveRes = await handleSaveReceipt(supabase, pending.payload, actor);
        if (!saveRes.success) return `保存に失敗しました: ${saveRes.error}`;
        let autoCheckMsg = '';
        if (saveRes.autoCheckedShoppingItems && saveRes.autoCheckedShoppingItems.length > 0) {
          autoCheckMsg = `\n✨ 買い物リストの「${saveRes.autoCheckedShoppingItems.join('」「')}」も自動で購入済みにしました！`;
        }
        return `✅ 確認ありがとうございます！レシートを家計簿に登録しました✨\n合計: ¥${saveRes.total.toLocaleString()}${autoCheckMsg}`;
      } else if (pending.type === 'expense') {
        await handleAddTransaction(supabase, pending.payload, actor);
        return `✅ 確認ありがとうございます！支出「${pending.payload.title}（¥${Number(pending.payload.amount).toLocaleString()}）」を登録しました✨`;
      }
    } else if (/^(?:キャンセル|やめる|いいえ|キャンセルする|no|NO)$/i.test(text)) {
      await setAppSetting(supabase, pairId, 'pendingLineConfirmation', null);
      return `🗑️ 登録をキャンセルしました。`;
    }
  }

  // メンバー名照合ヘルパー
  const resolveMemberQuery = (query) => {
    if (!query) return null;
    const q = String(query).trim();
    if (['夫', 'パパ', 'メンバー1', 'slot1'].includes(q)) return config.husbandName;
    if (['妻', 'ママ', 'メンバー2', 'slot2'].includes(q)) return config.wifeName;
    if (q === config.husbandName) return config.husbandName;
    if (q === config.wifeName) return config.wifeName;
    if (Array.isArray(config.members)) {
      const m = config.members.find(x => x.name === q || x.role === q);
      if (m) return m.name;
    }
    return null;
  };

  // LINE対話型レシート編集セッションの確認 (v2.7.0)
  const editSession = await getReceiptEditSession(supabase, pairId, userId);

  // キャンセルコマンド
  if (/^(?:キャンセル|やめる|終了|ストップ)$/i.test(text.trim())) {
    if (editSession) {
      await saveReceiptEditSession(supabase, pairId, userId, null);
      return '🧾 レシート編集をキャンセルしました✨';
    }
  }

  // ステップ2: レシート番号の選択処理
  if (editSession && editSession.step === 'SELECT_RECEIPT') {
    const numMatch = text.trim().match(/^([1-5])(?:番|番目)?$/);
    if (numMatch) {
      const selectedIdx = parseInt(numMatch[1], 10) - 1;
      const targetRec = editSession.candidateReceipts && editSession.candidateReceipts[selectedIdx];
      if (targetRec) {
        // 該当レシートの明細を取得
        const { data: rawItems } = await supabase
          .from('receipt_items')
          .select('*')
          .eq('receipt_id', targetRec.id)
          .order('id', { ascending: true });

        // 該当レシートのトランザクションを取得
        const { data: existingTxs } = await supabase
          .from('transactions')
          .select('*')
          .eq('receipt_id', targetRec.id);

        const itemsList = (rawItems || []).map((it, idx) => {
          let isShared = true;
          let owner = '';
          const privTx = (existingTxs || []).find(t => !t.is_shared && t.title.includes(it.item_name));
          if (privTx) {
            isShared = false;
            owner = privTx.payer_id || '';
          }
          return {
            index: idx + 1,
            name: it.item_name,
            quantity: it.quantity || 1,
            price: it.price || 0,
            isShared,
            owner
          };
        });

        let msg = `🧾 ${targetRec.store} (${targetRec.date} 合計 ¥${Number(targetRec.total).toLocaleString()}) の明細です。\n変更したい番号と割り振りを送信してください。\n\n`;
        itemsList.forEach(it => {
          const scopeLabel = it.isShared ? '👥共同' : `🔒${it.owner || '私物'}`;
          msg += `${it.index}. ${it.name} (${it.price < 0 ? '-' : ''}¥${Math.abs(it.price).toLocaleString()}) [${scopeLabel}]\n`;
        });
        msg += `\n【入力例】\n・「1を${config.husbandName}の私物」\n・「2を${config.wifeName}の私物」\n・「1を${config.husbandName}、2を${config.wifeName}」（まとめて指定もOK！）\n・「1を共同」\n※「キャンセル」で終了します`;

        await saveReceiptEditSession(supabase, pairId, userId, {
          step: 'SELECT_ITEMS',
          receiptId: targetRec.id,
          store: targetRec.store,
          date: targetRec.date,
          total: targetRec.total,
          category: targetRec.category || '食費',
          paymentType: targetRec.paymentType || 'shared_card',
          items: itemsList,
          expiresAt: Date.now() + 10 * 60 * 1000
        });

        return msg;
      }
    }
  }

  // ステップ3: 品目の割り振り変更の実行
  if (editSession && editSession.step === 'SELECT_ITEMS') {
    const parsedChanges = [];
    const changeRegex = /(\d+)\s*(?:番|行|品目)?\s*(?:を|は|:|=|：)?\s*(?:([^\s、,\n]+?)の?)?(私物|共同)/g;
    let m;
    while ((m = changeRegex.exec(text)) !== null) {
      const itemIdx = parseInt(m[1], 10);
      const namePart = (m[2] || '').trim();
      const typePart = m[3];

      let isShared = typePart === '共同';
      let owner = '';
      if (!isShared) {
        if (namePart) {
          owner = resolveMemberQuery(namePart) || namePart;
        } else {
          owner = actor.name;
        }
      }
      parsedChanges.push({ itemIdx, isShared, owner });
    }

    if (parsedChanges.length > 0) {
      const updatedItems = [...editSession.items];
      parsedChanges.forEach(ch => {
        const item = updatedItems.find(it => it.index === ch.itemIdx);
        if (item) {
          item.isShared = ch.isShared;
          item.owner = ch.owner;
        }
      });

      const updatePayload = {
        receiptId: editSession.receiptId,
        store: editSession.store,
        date: editSession.date,
        category: editSession.category || '食費',
        paymentType: editSession.paymentType || 'shared_card',
        payer: '共同',
        items: updatedItems.map(it => ({
          name: it.name,
          quantity: it.quantity,
          price: it.price,
          isShared: it.isShared,
          owner: it.owner
        }))
      };

      await handleUpdateReceipt(supabase, updatePayload, actor);
      await saveReceiptEditSession(supabase, pairId, userId, null);

      const sharedTotal = updatedItems.filter(it => it.isShared).reduce((s, it) => s + it.price, 0);
      const personalByOwner = {};
      updatedItems.filter(it => !it.isShared).forEach(it => {
        const o = it.owner || actor.name;
        personalByOwner[o] = (personalByOwner[o] || 0) + it.price;
      });

      let resMsg = `✅ レシートの明細を変更しました！\n\n🧾 ${editSession.store} (${editSession.date} 合計 ¥${Number(editSession.total).toLocaleString()})\n`;
      parsedChanges.forEach(ch => {
        const it = updatedItems.find(x => x.index === ch.itemIdx);
        if (it) {
          resMsg += `・${it.index}. ${it.name}: ${it.isShared ? '👥 共同生活費' : `🔒 ${it.owner}の私物`} (¥${Number(it.price).toLocaleString()})\n`;
        }
      });

      resMsg += `\n💰 【精算内訳】\n・共同生活費分: ¥${sharedTotal.toLocaleString()}\n`;
      for (const [oName, oTotal] of Object.entries(personalByOwner)) {
        resMsg += `・${oName}さん共同口座返還: +¥${oTotal.toLocaleString()}\n`;
      }

      return resMsg;
    }
  }

  // ステップ1: レシート変更トリガーワード
  if (/^(?:レシート変更|レシート修正|内容変更|レシート編集|明細変更)$/i.test(text.trim())) {
    const { data: recentReceipts } = await supabase
      .from('receipts')
      .select('*')
      .eq('pair_id', pairId)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(5);

    if (!recentReceipts || recentReceipts.length === 0) {
      return '登録されたレシートがまだありません。レシート写真を送信すると自動記帳されます✨';
    }

    let msg = '🧾 どのレシートを変更しますか？番号を送信してください。\n\n';
    recentReceipts.forEach((r, idx) => {
      msg += `${idx + 1}. ${r.store_name} ${r.date}: ¥${Number(r.total_amount).toLocaleString()}\n`;
    });
    msg += '\n※「キャンセル」で終了します';

    await saveReceiptEditSession(supabase, pairId, userId, {
      step: 'SELECT_RECEIPT',
      candidateReceipts: recentReceipts.map(r => ({
        id: r.id,
        store: r.store_name,
        date: r.date,
        total: r.total_amount
      })),
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    return msg;
  }

  // 3. 代理入力解除コマンド
  if (/^(?:代理解除|代理終了|代理モード解除)$/.test(text)) {
    await setAppSetting(supabase, pairId, 'lineProxyState', null);
    return '👥 代理入力モードを解除しました。通常モードに戻ります✨';
  }

  // 4. 代理入力コマンド（事後変更または事前宣言）
  const proxyMatch = text.match(/^(?:代理|支払者|登録者)\s+([^\d\s　]+)(?:\s+(.+))?$/);
  if (proxyMatch && !/\d+/.test(text)) {
    const targetQuery = proxyMatch[1].trim();
    const targetMember = resolveMemberQuery(targetQuery);
    if (!targetMember) {
      return `メンバー「${targetQuery}」が見つかりませんでした。「代理 ${config.husbandName}」または「代理 ${config.wifeName}」のように指定してください✨`;
    }

    // A. 事後変更: 直近5分以内に自分が登録した支出があれば支払者を変更
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: recentTxs } = await supabase
      .from('transactions')
      .select('*')
      .eq('pair_id', pairId)
      .eq('created_by', actor.name)
      .gte('created_at', fiveMinAgo)
      .order('created_at', { ascending: false })
      .limit(1);

    if (recentTxs && recentTxs.length > 0) {
      const recentTx = recentTxs[0];
      await supabase.from('transactions').update({ payer_id: targetMember }).eq('id', recentTx.id).eq('pair_id', pairId);
      await writeAudit(supabase, actor, pairId, '更新', '支出', recentTx.id, { payer: recentTx.payer_id }, { payer: targetMember, note: 'LINE代理事後変更' });
      return `✅ 直前の支出「${recentTx.title}（¥${Number(recentTx.amount).toLocaleString()}）」の支払者を【${targetMember}さん】に変更しました！`;
    }

    // B. 事前宣言モード: 今後10分間またはレシート送信まで代理入力モードを保持
    await setAppSetting(supabase, pairId, 'lineProxyState', {
      payer: targetMember,
      expiresAt: Date.now() + 10 * 60 * 1000
    });
    return `👥【代理入力モード開始】\n支払者を「${targetMember}さん」として設定しました！\n今後10分間、またはレシート写真送信まで、${targetMember}さんの支出として自動登録されます✨\n（解除するには「代理解除」と返信してください）`;
  }

  // 5. ヘルプ
  if (/^(ヘルプ|使い方|help)$/i.test(text)) {
    return '💡【家計簿Botの使い方】\n\n' +
      '■ かんたん支出登録\n・スーパー 3200\n・立替 2500 ドラッグストア\n・共同カード 私物 4800 服\n\n' +
      '■ 買い物リスト（まとめて追加もOK！）\n・買う 牛乳\n・買い物リスト見せて\n・牛乳と卵買ったよ〜\n・複数行で品名だけ送っても一括追加！\n\n' +
      '■ 状況・レポート\n・残金\n・振込額\n・収支報告（グラフ付き！）\n\n' +
      '■ 価格を調べる（AI不使用・DB相場）\n・卵の値段\n・牛乳いくら？\n\n' +
      '📷 レシート写真を送るだけでAI自動記帳もできます✨';
  }

  // 4. 残金確認
  if (/^(残金|予算|いくら|今月)$/.test(text)) {
    const initData = await handleGetInitialData(supabase, currentMonthStr(), actor, pairId);
    const s = initData.summary;
    return `📊【今月の家計状況】\n` +
      `・予算: ¥${s.budget.toLocaleString()}\n` +
      `・支出合計: ¥${s.totalExpense.toLocaleString()}\n` +
      `・残り残金: ¥${s.remaining.toLocaleString()}\n` +
      `・今日使える目安: ¥${s.dailyAllowance.toLocaleString()} / 日 (残${s.daysLeft}日)\n` +
      `※詳細はアプリで確認できます✨`;
  }

  // 5. 振込額確認
  if (/^(振込|振込額|精算|いくら振込)$/.test(text)) {
    const initData = await handleGetInitialData(supabase, currentMonthStr(), actor, pairId);
    const t = initData.transfers;
    return `🏦【今月の共同口座 振込予定額】\n` +
      `━━━━━━━━━━━━━━\n` +
      `🔵 ${config.husbandName}: ¥${t.husband.totalTransfer.toLocaleString()}\n` +
      ` (基本¥${t.husband.baseContribution.toLocaleString()} + 私物¥${t.husband.privateOnSharedCard.toLocaleString()} - 立替¥${t.husband.advancedForShared.toLocaleString()})\n\n` +
      `🩷 ${config.wifeName}: ¥${t.wife.totalTransfer.toLocaleString()}\n` +
      ` (基本¥${t.wife.baseContribution.toLocaleString()} + 私物¥${t.wife.privateOnSharedCard.toLocaleString()} - 立替¥${t.wife.advancedForShared.toLocaleString()})\n` +
      `━━━━━━━━━━━━━━`;
  }

  // 6. 月次収支報告（QuickChartグラフ付き）
  if (/^(?:収支報告|月次レポート|今月のまとめ|レポート|月次報告)(?:見せて|教えて|確認|お願い|だして|出して)?[！!〜ー♪✨\s]*$/i.test(text)) {
    return await generateMonthlyReportMessage(supabase, actor, pairId, config);
  }

  // 7. 買い物リスト確認（「買い物リスト見せて」「買い物リストだして！」）
  if (/^(?:買い物リスト|買うもの|買うリスト|何買う|リスト)(?:見せて|教えて|確認|一覧|だして|出して|ちょうだい|表示)?[！!〜ー♪✨\s]*$/i.test(text)) {
    const { data: openItems } = await supabase
      .from('shopping_items')
      .select('*')
      .eq('pair_id', pairId)
      .eq('is_completed', false)
      .order('created_at', { ascending: true });

    if (!openItems || openItems.length === 0) {
      return `🛒 いま買うものリストは空っぽです✨\n「買う 牛乳」や複数行メモでいつでも追加できます！`;
    }
    const lines = openItems.map((it, idx) => `${idx + 1}. ${it.title || it.name}`);
    return `🛒 現在の買うものリスト (${openItems.length}件):\n` +
      lines.join('\n') +
      `\n\n💡 買ったら「〇〇買ったよ」と送ると自動消込できます✨`;
  }

  // 8. 自然言語での買い物消込（「卵買ったよ〜」など）
  const boughtMatch = text.match(/^(.+?)(?:を|は|も)?\s*(?:買っ(?:た|たよ|たー|た〜|てきた|たよー|た！|た!)|購入(?:した|済|済み)?)[！!〜ー♪✨\s]*$/);
  if (boughtMatch && !/\d{3,}/.test(text.replace(/[¥,円]/g, ''))) {
    const rawItemsStr = boughtMatch[1].trim();
    const candidates = rawItemsStr.split(/[\s　と、,・]+/).map(s => s.trim()).filter(Boolean);

    const { data: openItems } = await supabase
      .from('shopping_items')
      .select('*')
      .eq('pair_id', pairId)
      .eq('is_completed', false);

    if (openItems && openItems.length > 0) {
      const matchedIds = [];
      const matchedNames = [];
      for (const candidate of candidates) {
        const normCand = normalizeName(candidate);
        if (!normCand) continue;
        for (const it of openItems) {
          const normIt = normalizeName(it.title || it.name || '');
          if (normIt && (normIt === normCand || normIt.includes(normCand) || (normCand.length >= 2 && normCand.includes(normIt)))) {
            if (!matchedIds.includes(it.id)) {
              matchedIds.push(it.id);
              matchedNames.push(it.title || it.name);
            }
          }
        }
      }

      if (matchedIds.length > 0) {
        await supabase
          .from('shopping_items')
          .update({ is_completed: true, completed_at: new Date().toISOString() })
          .in('id', matchedIds);

        return `✨ お買い物お疲れ様でした！\n買い物リストの「${matchedNames.join('」「')}」を購入済みにしました🛒`;
      }
    }
    return `買い物リストに「${rawItemsStr}」は見つかりませんでした💦\n「買い物リスト見せて」で現在のリストを確認できます✨`;
  }

  // 9. 改行区切りの複数行買い物リスト一括追加
  if (text.includes('\n')) {
    const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let lines = rawLines;
    if (/^(?:買う|買い物|買い物リスト|買うもの|買出|リスト|メモ)$/i.test(rawLines[0])) {
      lines = rawLines.slice(1);
    }
    const isPureShoppingList = lines.length >= 1 && lines.every(line => !/\d{3,}/.test(line.replace(/[¥,円]/g, '')));
    if (isPureShoppingList && lines.length > 0) {
      const addedItems = [];
      for (const line of lines) {
        const cleanName = line.replace(/^[・\-\*\s]+/, '').trim().slice(0, 50);
        if (cleanName) {
          await handleAddShoppingItem(supabase, { title: cleanName, category: '日用品' }, actor);
          addedItems.push(cleanName);
        }
      }
      if (addedItems.length > 0) {
        return `🛒 買うものリストに${addedItems.length}件まとめて追加しました！\n` +
          addedItems.map(it => `・${it}`).join('\n') +
          `\n\n💡「買い物リスト見せて」と送ると一覧が確認できます✨`;
      }
    }
  }

  // 10. 単一の買い物リスト追加（「買う 牛乳」）
  const buyMatch = text.match(/^(?:買う|買い物|買出)\s+(.+)$/);
  if (buyMatch) {
    const itemName = buyMatch[1].trim().slice(0, 50);
    await handleAddShoppingItem(supabase, { title: itemName, category: '日用品' }, actor);
    return `🛒 買い物リストに「${itemName}」を追加しました！`;
  }

  // 11. 価格検索（「卵の値段」「牛乳いくら？」「豆腐いくら？」）
  const priceMatch = text.match(/^(?:価格|値段|相場|いくら|最安|最安値)\s+(.+)$/) ||
                     text.match(/^(.+?)(?:の)?\s*(?:値段|価格|いくら|最安|最安値|相場)(?:は|教えて|？|\?)?$/);
  if (priceMatch && priceMatch[1] !== '今月') {
    const queryItem = priceMatch[1].trim();
    const r = await handleSearchPrices(supabase, queryItem, actor);
    if (!r.success) return r.error || '価格検索中にエラーが発生しました';
    if (r.count === 0 || !r.stats) return `🔎「${queryItem}」の購入履歴はまだありません。レシートを読み取ると自動で相場が蓄積されます📷`;

    const topStores = (r.byStore || []).slice(0, 3).map((s, idx) => {
      const avg = (s.avgUnitPrice ?? s.min ?? 0).toLocaleString();
      const min = (s.minUnitPrice ?? s.min ?? 0).toLocaleString();
      return `  ${idx + 1}. ${s.store}: 平均¥${avg} (最安¥${min})`;
    }).join('\n');

    const minPrice = Number(r.stats.min || 0).toLocaleString();
    const minStoreInfo = r.stats.minStore && r.stats.minStore !== '不明' ? ` (${r.stats.minStore}${r.stats.minDate ? ` / ${r.stats.minDate}` : ''})` : '';
    const latestPrice = Number(r.stats.latest || 0).toLocaleString();
    const latestStoreInfo = r.stats.latestStore && r.stats.latestStore !== '不明' ? ` (${r.stats.latestStore}${r.stats.latestDate ? ` / ${r.stats.latestDate}` : ''})` : '';
    const avgPrice = Number(r.stats.avg || 0).toLocaleString();

    return `🔎【${r.query}】の価格実績（過去${r.count}件）\n` +
      `━━━━━━━━━━━━━━\n` +
      `🏆 最安値: ¥${minPrice}${minStoreInfo}\n` +
      `🕒 直近価格: ¥${latestPrice}${latestStoreInfo}\n` +
      `📊 平均相場: ¥${avgPrice}\n` +
      (topStores ? `\n🏪 店舗別ランキング:\n${topStores}\n` : '') +
      `━━━━━━━━━━━━━━`;
  }

  // 12. 支出入力パーサー
  const parts = text.split(/[\s　]+/);
  if (parts.length < 2) {
    return '入力方法がわかりませんでした💦\n例:「スーパー 3200」「立替 1500 日用品」\n「ヘルプ」で使い方を表示します。';
  }

  let amount = null;
  let paymentType = 'shared_card';
  let isShared = true;

  // 事前宣言された代理入力モードを確認
  const proxyState = await getAppSetting(supabase, pairId, 'lineProxyState', null);
  let isProxy = false;
  let payer = actor.name;
  if (proxyState && proxyState.payer && proxyState.expiresAt > Date.now()) {
    payer = proxyState.payer;
    isProxy = true;
  }

  const remainingParts = [];

  parts.forEach(part => {
    const cleanNum = part.replace(/[¥,円]/g, '');
    if (/^\d+$/.test(cleanNum) && amount === null) { amount = parseInt(cleanNum, 10); return; }
    if (part === '立替') { paymentType = 'advanced_by_user'; return; }
    if (part === '私物' || part === '個人') { isShared = false; return; }
    if (part === '共同カード') { paymentType = 'shared_card'; return; }
    if (part === '代理') return;

    // メンバー名の判定（代理指定）
    const matched = resolveMemberQuery(part);
    if (matched) {
      payer = matched;
      if (payer !== actor.name) isProxy = true;
      return;
    }

    remainingParts.push(part);
  });

  if (!amount || amount <= 0 || amount > 10000000) {
    return '金額を正しく読み取れませんでした。例:「スーパー 3200」';
  }

  const title = (remainingParts.join(' ') || '未分類支出').slice(0, 50);

  // ルールからカテゴリ推測
  const { data: rules } = await supabase.from('rules').select('*').eq('pair_id', pairId);
  let category = '日用品';
  for (const r of rules || []) {
    if (title.includes(r.keyword)) {
      category = r.category_id;
      break;
    }
  }

  // 重複登録チェック: 同日かつ同額の支出がすでに存在するかチェック
  const today = todayStr();
  const { data: existingTx } = await supabase
    .from('transactions')
    .select('id, title, amount')
    .eq('pair_id', pairId)
    .eq('date', today)
    .eq('amount', amount);

  if (existingTx && existingTx.length > 0) {
    const existingTitle = existingTx[0].title || '支出';
    await setAppSetting(supabase, pairId, 'pendingLineConfirmation', {
      type: 'expense',
      payload: {
        date: today,
        title: title,
        amount: amount,
        category: category,
        isShared: isShared,
        paymentType: paymentType,
        payer: payer,
        memo: 'LINE Bot登録'
      },
      createdAt: Date.now()
    });

    return `⚠️【二重入力の確認】\n本日すでに同額「¥${amount.toLocaleString()}（${existingTitle}）」の支出が登録されています！\n\nそのまま登録しますか？\n👉 登録する場合は「登録する」（または「はい」）\n👉 やめる場合は「キャンセル」と返信してください`;
  }

  await handleAddTransaction(supabase, {
    date: today,
    title: title,
    amount: amount,
    category: category,
    isShared: isShared,
    paymentType: paymentType,
    payer: payer,
    memo: 'LINE Bot登録'
  }, actor);

  if (isProxy && proxyState) {
    await setAppSetting(supabase, pairId, 'lineProxyState', null);
  }

  let typeDesc = '共同費';
  if (!isShared && paymentType === 'shared_card') typeDesc = `⚠️共同カード私物（${payer}の振込額に加算）`;
  else if (isShared && paymentType === 'advanced_by_user') typeDesc = `✨個人立替（${payer}の振込額から控除）`;

  const proxyBanner = isProxy ? `👥 代理入力（支払者: ${payer}さん）\n━━━━━━━━━━━━━━\n` : '';
  return `${proxyBanner}✅ 記録しました！\n━━━━━━━━━━━━━━\n品名: ${title}\n金額: ¥${amount.toLocaleString()}\nカテゴリ: ${category}\n種別: ${typeDesc}\n支払者: ${payer}\n━━━━━━━━━━━━━━`;
}

/**
 * LINE経由で送られたレシート画像を取得・AI解析し、家計簿へ自動保存
 */
async function processLineImageMessage(supabase, messageId, userId, lineToken) {
  if (!lineToken) return 'LINE連携トークンが未設定です';

  // 1. ユーザー特定
  const { data: user } = await supabase.from('users').select('*, pairs(*)').eq('line_user_id', userId).maybeSingle();
  const pairId = user?.pair_id || DEFAULT_PAIR_ID;
  const actor = {
    allowed: true,
    verified: true,
    name: user?.display_name || 'LINEメンバー',
    userId,
    slot: user?.slot || 'husband',
    pairId
  };

  // 2. レート制限チェック（1日20枚上限 & 連続5枚超の待機・クールダウン）
  const today = todayStr();
  const rateLimit = await getAppSetting(supabase, pairId, 'lineReceiptRateLimit', { date: today, countToday: 0, recentTimestamps: [] });
  if (rateLimit.date !== today) {
    rateLimit.date = today;
    rateLimit.countToday = 0;
    rateLimit.recentTimestamps = [];
  }

  if (rateLimit.countToday >= 20) {
    return `🌙 本日のLINEレシート読み取り上限（1日20枚）に達しました（20/20枚）！\n無料AI枠をふたりで大切に使うための制限です。明日また送るか、Webアプリから手動で登録してね🌱`;
  }

  const now = Date.now();
  rateLimit.recentTimestamps = (rateLimit.recentTimestamps || []).filter(ts => now - ts < 60000);

  let waitNotice = '';
  if (rateLimit.recentTimestamps.length >= 5) {
    const oldestRecent = rateLimit.recentTimestamps[rateLimit.recentTimestamps.length - 5];
    const waitMs = 60000 - (now - oldestRecent);
    if (waitMs > 0 && waitMs <= 45000) {
      await new Promise(r => setTimeout(r, waitMs));
      waitNotice = `⏳ 5枚連続送信のため、無料枠保護で少し待機してから読み取りました（本日 ${rateLimit.countToday + 1}/20枚）\n\n`;
    } else if (waitMs > 45000) {
      return `⏳ 短時間に5枚以上のレシートが送られたため、無料枠保護のクールダウン中です！あと約1分待ってから6枚目を送ってね🙏（本日 ${rateLimit.countToday}/20枚）`;
    }
  }

  // 3. LINEサーバーから画像バイナリを取得
  const contentUrl = `https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`;
  const imgRes = await fetch(contentUrl, {
    headers: { Authorization: `Bearer ${lineToken}` }
  });
  if (!imgRes.ok) {
    throw new Error(`LINE画像取得失敗: ${imgRes.status}`);
  }
  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
  const arrayBuffer = await imgRes.arrayBuffer();
  const base64Image = Buffer.from(arrayBuffer).toString('base64');

  // レート制限カウント加算
  rateLimit.countToday++;
  rateLimit.recentTimestamps.push(Date.now());
  await setAppSetting(supabase, pairId, 'lineReceiptRateLimit', rateLimit);

  // 4. Gemini OCR 解析
  const scanResult = await handleScanReceipt({
    imageBase64: base64Image,
    mimeType: contentType
  }, actor);

  if (!scanResult.success || !scanResult.receipt) {
    return 'レシートをうまく読み取れませんでした💦 明るい場所で全体が写るように撮り直してみてください📷';
  }

  const receipt = scanResult.receipt;
  if (!receipt.items || receipt.items.length === 0) {
    return `店名「${receipt.store || '不明'}」は検出されましたが、購入明細が読み取れませんでした💦`;
  }

  // 5. 重複レシートチェック（同日・同額・店名/品名被り）
  const { data: dupTx } = await supabase
    .from('transactions')
    .select('id, title, amount, date')
    .eq('pair_id', pairId)
    .eq('date', receipt.date)
    .eq('amount', receipt.total);

  if (dupTx && dupTx.length > 0) {
    const isStoreDup = dupTx.some(t => t.title && (t.title.includes(receipt.store) || receipt.store.includes(t.title)));
    if (isStoreDup) {
      await setAppSetting(supabase, pairId, 'pendingLineConfirmation', {
        type: 'receipt',
        payload: {
          store: receipt.store || 'レシート店舗',
          date: receipt.date || todayStr(),
          items: receipt.items,
          isShared: true,
          paymentType: 'shared_card',
          payer: actor.name,
          category: '食費'
        },
        createdAt: Date.now()
      });

      const firstItem = receipt.items[0]?.name || receipt.store;
      return `⚠️【重複レシートの確認】\n同じ日付（${receipt.date}）・同額（¥${receipt.total.toLocaleString()}）・同じ店名/品目（${firstItem}）のレシートが既に登録されています！\n\n二重登録ではありませんか？\n👉 登録する場合は「登録する」（または「はい」）\n👉 やめる場合は「キャンセル」と返信してください`;
    }
  }

  // 代理入力モードの確認
  const proxyState = await getAppSetting(supabase, pairId, 'lineProxyState', null);
  let payer = actor.name;
  let isProxy = false;
  if (proxyState && proxyState.payer && proxyState.expiresAt > Date.now()) {
    payer = proxyState.payer;
    isProxy = true;
    await setAppSetting(supabase, pairId, 'lineProxyState', null);
  }

  // 6. 家計簿への自動保存（receipts + receipt_items + transactions + 買い物リスト消込）
  const saveRes = await handleSaveReceipt(supabase, {
    store: receipt.store || 'レシート店舗',
    date: receipt.date || todayStr(),
    items: receipt.items,
    isShared: true,
    paymentType: 'shared_card',
    payer: payer,
    category: '食費'
  }, actor);

  if (!saveRes.success) {
    return `レシートの読み取りには成功しましたが、保存に失敗しました: ${saveRes.error}`;
  }

  const itemsPreview = receipt.items.slice(0, 4).map(it => `・${it.name}: ¥${it.price.toLocaleString()}`).join('\n');
  const moreCount = receipt.items.length > 4 ? `\n...他 ${receipt.items.length - 4}件` : '';

  let autoCheckMsg = '';
  if (saveRes.autoCheckedShoppingItems && saveRes.autoCheckedShoppingItems.length > 0) {
    autoCheckMsg = `\n\n✨ 買い物リストの「${saveRes.autoCheckedShoppingItems.join('」「')}」も自動で購入済みにしました！`;
  }

  const proxyBanner = isProxy ? `👥 代理入力（支払者: ${payer}さん）\n━━━━━━━━━━━━━━\n` : '';

  return waitNotice + proxyBanner + `🧾 レシートを自動記録しました！\n` +
    `━━━━━━━━━━━━━━\n` +
    `🏪 店名: ${receipt.store || '未設定'}\n` +
    `📅 日付: ${receipt.date}\n` +
    `💰 合計: ¥${receipt.total.toLocaleString()}（明細 ${receipt.items.length}件）\n` +
    `💳 支払: 共同カード / ${payer}\n` +
    `━━━━━━━━━━━━━━\n` +
    itemsPreview + moreCount +
    autoCheckMsg + `\n\n` +
    `アプリの「履歴」タブに反映されました✨\n\n` +
    `💡 パートナーの代理登録にする場合は「代理 〇〇」と返信してください`;
}

// ==========================================
// ヘルスチェック ＆ 設定漏れ自己診断
// ==========================================
async function handleHealthCheck(req) {
  const rawUrl = process.env.SUPABASE_URL;
  const rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  const resolvedUrl = normalizeSupabaseUrl(rawUrl);
  const resolvedKey = normalizeEnvSecret(rawKey);
  const keyType = getKeyType(resolvedKey);

  const envCheck = {
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    LINE_CHANNEL_SECRET: !!process.env.LINE_CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
    DEMO_MODE: process.env.DEMO_MODE || 'false'
  };

  let dbStatus = '未接続';
  let dbError = null;

  if (resolvedUrl && resolvedKey) {
    try {
      const client = getSupabase(resolvedUrl, resolvedKey);
      const { data, error } = await client.from('pairs').select('id').limit(1);
      if (error) {
        dbStatus = 'エラー';
        let hint = error.hint || null;
        if (keyType === 'sb_publishable') {
          hint = '※Publishableキー（sb_publishable_...）が設定されています。サーバー用には必ず Service Role Key（sb_secret_... または JWT secret）を設定してください。';
        } else if (error.message && error.message.includes('relation') && error.message.includes('does not exist')) {
          hint = '※テーブルが見つかりません。Supabaseの SQL Editor で schema.sql を実行してください。';
        }
        dbError = {
          code: error.code || 'UNKNOWN',
          message: error.message || '不明なエラー',
          hint: hint,
          details: error.details || null
        };
      } else {
        dbStatus = '正常接続 (OK)';
      }
    } catch (e) {
      dbStatus = '接続例外エラー';
      dbError = {
        code: 'CLIENT_EXCEPTION',
        message: e.message,
        hint: 'URLまたはキーの形式を確認してください'
      };
    }
  } else {
    dbStatus = '環境変数が未設定のため未接続';
  }

  // Gemini APIモデル接続チェック
  const geminiApiKey = normalizeEnvSecret(process.env.GEMINI_API_KEY);
  const geminiInfo = {
    apiKeyConfigured: !!geminiApiKey,
    availableModels: [],
    primaryModel: null,
    error: null
  };

  if (geminiApiKey) {
    try {
      const gModels = await getAvailableGeminiModels(geminiApiKey);
      geminiInfo.availableModels = gModels.slice(0, 8);
      geminiInfo.primaryModel = gModels[0] || null;
    } catch (gErr) {
      geminiInfo.error = gErr.message;
    }
  }

  return {
    success: true,
    version: 'v2.8.0',
    resolvedUrl: resolvedUrl ? resolvedUrl.replace(/\/\/[^@]+@/, '//***@') : '未設定',
    keyType: keyType,
    env: envCheck,
    database: {
      status: dbStatus,
      error: dbError ? (typeof dbError === 'object' ? `${dbError.message}${dbError.hint ? ' [' + dbError.hint + ']' : ''}` : String(dbError)) : null,
      errorDetail: dbError
    },
    gemini: geminiInfo,
    timestamp: new Date().toISOString()
  };
}

// ==========================================
// Vercel Serverless Function メインハンドラ
// ==========================================

export default async function handler(req, res) {
  // CORSヘッダー設定
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, x-line-signature'
  );

  // OPTIONS プリフライト対応
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // ヘルスチェック・設定診断（Supabase未接続でも安全に応答可能）
  const queryAction = req.query?.action;
  let bodyAction = null;
  if (req.body) {
    if (typeof req.body === 'string') {
      try { bodyAction = JSON.parse(req.body)?.action; } catch (_) {}
    } else {
      bodyAction = req.body?.action;
    }
  }
  if (queryAction === 'healthCheck' || bodyAction === 'healthCheck') {
    const report = await handleHealthCheck(req);
    return res.status(200).json(report);
  }

  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }

  // 1. GET リクエスト（初期データ取得・イベント一覧等）
  if (req.method === 'GET') {
    try {
      const action = req.query.action || 'getInitialData';

      // 認証ガード: DEMO_MODE が true か、またはクエリ / ヘッダーのトークンを検証
      const queryToken = req.query.idToken || req.query.token;
      const authHeader = req.headers.authorization;
      const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const idToken = queryToken || bearerToken;
      const requestedPairId = req.query.pairId || null;

      let actor = { name: '未認証', verified: false, slot: 'husband', pairId: requestedPairId || DEFAULT_PAIR_ID };
      if (idToken) {
        const verifiedActor = await resolveActor(idToken, supabase, requestedPairId);
        if (verifiedActor.allowed) {
          actor = verifiedActor;
        } else if (!isDemoAllowed()) {
          return res.status(401).json({
            success: false,
            code: verifiedActor.code || 'AUTH',
            error: verifiedActor.error || '認証に失敗しました'
          });
        }
      } else if (!isDemoAllowed()) {
        return res.status(401).json({
          success: false,
          code: 'AUTH',
          error: 'LINEアプリ内の「ふたり家計簿」からアクセスしてください（直接URLを開いてデータを見ることはできません）'
        });
      }

      if (action === 'getInitialData') {
        const result = await handleGetInitialData(supabase, req.query.month, actor, requestedPairId);
        return res.status(200).json(result);
      }
      if (action === 'getEvents') {
        const result = await handleGetEvents(supabase, actor, req.query);
        return res.status(200).json(result);
      }
      if (action === 'getEventSettlement') {
        const result = await handleGetEventSettlement(supabase, actor, req.query.eventId);
        return res.status(200).json(result);
      }
      if (action === 'getMonthlyReport') {
        const result = await getMonthlyReportData(supabase, actor, requestedPairId || actor.pairId, req.query.month);
        return res.status(200).json(result);
      }

      return res.status(400).json({ success: false, error: `不明なアクションです: ${action}` });
    } catch (err) {
      console.error('GETエラー:', err);
      return res.status(500).json({ success: false, error: '内部エラーが発生しました' });
    }
  }

  // 2. POST リクエスト
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch (_) {}
      }

      // LINE Messaging API Webhook
      if (body && Array.isArray(body.events)) {
        const signature = req.headers['x-line-signature'];
        const channelSecret = process.env.LINE_CHANNEL_SECRET;
        const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

        if (channelSecret && signature) {
          const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
          if (!verifyLineSignature(rawBody, signature, channelSecret)) {
            console.warn('LINE Webhook署名検証失敗');
            return res.status(401).json({ error: '署名が無効です' });
          }
        }

        for (const ev of body.events) {
          if (ev.type === 'message' && ev.message?.type === 'text') {
            try {
              const reply = await processNaturalLanguageMessage(supabase, ev.message.text.trim(), ev.source.userId);
              await sendLineReply(ev.replyToken, reply, lineToken);
            } catch (err) {
              console.error('LINEイベント処理エラー:', err);
              await sendLineReply(ev.replyToken, 'エラーが発生しました🙏', lineToken);
            }
          } else if (ev.type === 'message' && ev.message?.type === 'image') {
            try {
              const reply = await processLineImageMessage(supabase, ev.message.id, ev.source.userId, lineToken);
              await sendLineReply(ev.replyToken, reply, lineToken);
            } catch (err) {
              console.error('LINE画像イベント処理エラー:', err);
              await sendLineReply(ev.replyToken, 'レシート画像の読み取りに失敗しました。明るい場所で全体を撮影してもう一度お送りください🙏', lineToken);
            }
          }
        }
        return res.status(200).json({ status: 'ok' });
      }

      const action = body?.action;
      const data = body?.data || {};
      const idToken = body?.idToken;
      const requestedPairId = body?.pairId || data?.pairId || null;

      // ペア作成アクション
      if (action === 'createPair') {
        const createRes = await handleCreatePair(supabase, idToken, data);
        return res.status(200).json(createRes);
      }

      // 招待コード合流アクション
      if (action === 'joinPair') {
        const joinRes = await handleJoinPair(supabase, idToken, data);
        return res.status(200).json(joinRes);
      }

      // メンバー登録アクション
      if (action === 'registerMember') {
        const regRes = await handleRegisterMember(supabase, idToken, data);
        return res.status(200).json(regRes);
      }

      // LIFF通常リクエスト: 操作者確定
      const actor = await resolveActor(idToken, supabase, requestedPairId);
      if (!actor.allowed) {
        return res.status(200).json({
          success: false,
          version: 'v2.8.0',
          code: actor.code,
          error: actor.error,
          userId: actor.userId || '',
          pairId: actor.pairId || DEFAULT_PAIR_ID,
          availableRoles: actor.availableRoles || null
        });
      }

      let result;
      switch (action) {
        case 'getEvents':
          result = await handleGetEvents(supabase, actor, data);
          break;
        case 'createEvent':
          result = await handleCreateEvent(supabase, actor, data);
          break;
        case 'deleteEvent':
          result = await handleDeleteEvent(supabase, actor, data.id || data.eventId);
          break;
        case 'addEventExpense':
          result = await handleAddEventExpense(supabase, actor, data);
          break;
        case 'deleteEventExpense':
          result = await handleDeleteEventExpense(supabase, actor, data.id || data.expenseId);
          break;
        case 'getEventSettlement':
          result = await handleGetEventSettlement(supabase, actor, data.eventId);
          break;
        case 'getInitialData':
          result = await handleGetInitialData(supabase, data.month || body.month, actor, requestedPairId);
          break;
        case 'addTransaction':
          result = await handleAddTransaction(supabase, data, actor);
          break;
        case 'updateTransaction':
          result = await handleUpdateTransaction(supabase, data, actor);
          break;
        case 'deleteTransaction':
          result = await handleDeleteTransaction(supabase, data.id, actor);
          break;
        case 'addShoppingItem':
          result = await handleAddShoppingItem(supabase, data, actor);
          break;
        case 'updateShoppingItem':
          result = await handleUpdateShoppingItem(supabase, data, actor);
          break;
        case 'deleteShoppingItem':
          result = await handleDeleteShoppingItem(supabase, data.id, actor);
          break;
        case 'updateShoppingPurgeDays':
          result = await handleUpdateShoppingPurgeDays(supabase, data, actor);
          break;
        case 'updateCategoryBudgets':
          result = await handleUpdateCategoryBudgets(supabase, data, actor);
          break;
        case 'updateCustomCategories':
          result = await handleUpdateCustomCategories(supabase, data, actor);
          break;
        case 'updateSurplusPolicy':
          result = await handleUpdateSurplusPolicy(supabase, data, actor);
          break;
        case 'updateSavingsConfig':
          result = await handleUpdateSavingsConfig(supabase, data, actor);
          break;
        case 'updateMonthlyBudget':
          result = await handleUpdateMonthlyBudget(supabase, data, actor);
          break;
        case 'updateFixedExpense':
          result = await handleUpdateFixedExpense(supabase, data, actor);
          break;
        case 'deleteFixedExpense':
          result = await handleDeleteFixedExpense(supabase, data.id, actor);
          break;
        case 'updateCategory':
          result = await handleUpdateCategory(supabase, data, actor);
          break;
        case 'updateRule':
          result = await handleUpdateRule(supabase, data, actor);
          break;
        case 'updateTransferStatus':
          result = await handleUpdateTransferStatus(supabase, data, actor);
          break;
        case 'updateBaseContribution':
          result = await handleUpdateBaseContribution(supabase, data, actor);
          break;
        case 'scanReceipt':
          result = await handleScanReceipt(data, actor);
          break;
        case 'saveReceipt':
          result = await handleSaveReceipt(supabase, data, actor);
          break;
        case 'updateReceipt':
          result = await handleUpdateReceipt(supabase, data, actor);
          break;
        case 'searchPrices':
          result = await handleSearchPrices(supabase, data.query, actor);
          break;
        case 'updateAutoCheckShopping':
          const autoCheckVal = data.enabled !== false;
          await setAppSetting(supabase, requestedPairId || actor.pairId, 'autoCheckShoppingOnReceipt', autoCheckVal);
          result = { success: true, enabled: autoCheckVal };
          break;
        case 'getMonthlyReport':
          result = await getMonthlyReportData(supabase, actor, requestedPairId || actor.pairId, data.month);
          break;
        case 'getAuditLog':
          result = await handleGetAuditLog(supabase, data, actor);
          break;
        default:
          result = { success: false, error: `未定義のアクション: ${action}` };
      }

      // returnInitialData フラグがある場合、最新の初期データを同レスポンスに含めて返却
      if (result && result.success && body.returnInitialData && action !== 'getInitialData') {
        const freshActor = await resolveActor(idToken, supabase, requestedPairId);
        result.initialData = await handleGetInitialData(supabase, body.viewMonth || data.month, freshActor, requestedPairId);
      }

      return res.status(200).json(result);
    } catch (err) {
      console.error('API実行エラー:', err);
      return res.status(500).json({ success: false, error: err.message || '内部エラーが発生しました' });
    }
  }

  return res.status(405).json({ success: false, error: 'Method Not Allowed' });
}
