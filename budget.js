/**
 * ふたり家計簿 (PairBudget) - Vercel Serverless Function
 * 単一エンドポイント (/api/budget)
 * Supabase PostgreSQL + Gemini API + LINE Messaging API
 * マルチペア対応（世帯分離）＆ 臨時イベント精算（30日TTLパージ・最小送金回数アルゴリズム）
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

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
 * Supabaseクライアントの初期化（サービスロールキー使用）
 */
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('Supabaseの環境変数 (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) が設定されていません');
  }
  return createClient(url, key, {
    auth: { persistSession: false }
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
  return process.env.DEMO_MODE === 'true';
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

/**
 * リクエスト操作者を確定
 */
async function resolveActor(idToken, supabase, requestedPairId = null) {
  const channelId = process.env.LINE_CHANNEL_ID;
  if (!channelId) {
    if (isDemoAllowed()) {
      return { allowed: true, verified: false, name: '未認証', userId: '', slot: 'husband', pairId: requestedPairId || DEFAULT_PAIR_ID };
    }
    return {
      allowed: false,
      code: 'SETUP_REQUIRED',
      error: '環境変数 LINE_CHANNEL_ID が設定されていません。'
    };
  }

  if (!idToken) {
    if (isDemoAllowed()) {
      return { allowed: true, verified: false, name: '未認証', userId: '', slot: 'husband', pairId: requestedPairId || DEFAULT_PAIR_ID };
    }
    return {
      allowed: false,
      code: 'AUTH',
      error: 'LINEのIDトークンが取得できませんでした（LINE DevelopersのLIFF設定で「openid」スコープがONか確認してください）'
    };
  }

  const v = await verifyIdTokenDetail(idToken, channelId);
  if (!v.sub) {
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
    const targetPairId = requestedPairId || DEFAULT_PAIR_ID;
    const { data: pairUsers } = await supabase.from('users').select('*').eq('pair_id', targetPairId);
    const registeredSlots = (pairUsers || []).map(u => u.slot);
    const husbandTaken = registeredSlots.includes('husband') || registeredSlots.includes('slot1');
    const wifeTaken = registeredSlots.includes('wife') || registeredSlots.includes('slot2');

    return {
      allowed: false,
      code: 'UNREGISTERED',
      userId: userId,
      pairId: targetPairId,
      availableRoles: {
        husband: !husbandTaken,
        wife: !wifeTaken,
        husbandName: (pairUsers || []).find(u => u.slot === 'husband' || u.slot === 'slot1')?.display_name || 'メンバー1',
        wifeName: (pairUsers || []).find(u => u.slot === 'wife' || u.slot === 'slot2')?.display_name || 'メンバー2'
      },
      error: 'このLINEアカウントはまだ登録されていません。画面でお好きな表示名を入力して登録してください。'
    };
  }

  return {
    allowed: true,
    verified: true,
    name: user.display_name,
    userId: user.line_user_id,
    slot: user.slot,
    pairId: user.pair_id || requestedPairId || DEFAULT_PAIR_ID,
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
    return actor.pairId;
  }
  return requestData?.pairId || actor?.pairId || DEFAULT_PAIR_ID;
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
    wifeName: 'メンバー2'
  };

  (settingsRes.data || []).forEach(s => {
    if (s.key === 'husbandBaseContribution') config.husbandBaseContribution = Number(s.value) || 60000;
    if (s.key === 'wifeBaseContribution') config.wifeBaseContribution = Number(s.value) || 60000;
    if (s.key === 'husbandName') config.husbandName = s.value;
    if (s.key === 'wifeName') config.wifeName = s.value;
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
      .select('date, amount, is_shared, payer_id')
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

  // 予算額の決定
  const curBudgetObj = (budgetsRes.data || []).find(b => b.month === month);
  let resolvedBudget = DEFAULT_BUDGET;
  if (curBudgetObj) {
    resolvedBudget = Number(curBudgetObj.budget_amount) || DEFAULT_BUDGET;
  } else {
    const past = (budgetsRes.data || []).filter(b => b.month < month).sort((a, b) => (a.month < b.month ? 1 : -1));
    if (past.length > 0) resolvedBudget = Number(past[0].budget_amount) || DEFAULT_BUDGET;
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
    totalsMap[m] = { month: m, shared: 0, personal: personalObj, budget: resolvedBudget };
    totalsOrder.push(m);
  }

  (allTxRes.data || []).forEach(tx => {
    const m = tx.date.slice(0, 7);
    const b = totalsMap[m];
    if (!b) return;
    const amt = Number(tx.amount) || 0;
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
    version: '2.1.0-multipair',
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
      wifeName: config.wifeName
    },
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

  // ペア内の既存メンバー状況を確認
  const { data: members } = await supabase.from('users').select('*').eq('pair_id', pairId);
  const husbandTaken = (members || []).some(m => m.slot === 'husband' || m.slot === 'slot1');
  const wifeTaken = (members || []).some(m => m.slot === 'wife' || m.slot === 'slot2');

  const slot = !wifeTaken ? 'wife' : (!husbandTaken ? 'husband' : '');
  if (!slot) {
    return { success: false, error: 'この世帯ペアは既に2名満員です。' };
  }

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
  if (!Number.isInteger(amount) || amount <= 0 || amount > 10000000) {
    return { success: false, error: '金額は1円以上の整数で入力してください' };
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
  if (!Number.isInteger(amount) || amount <= 0) return { success: false, error: '金額が正しくありません' };
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
  }

  const { error } = await supabase.from('shopping_list').update(updateFields).eq('id', item.id).eq('pair_id', pairId);
  if (error) return { success: false, error: '更新に失敗しました' };
  return { success: true };
}

async function handleDeleteShoppingItem(supabase, id, actor) {
  const pairId = getTargetPairId(actor, {});
  if (!id) return { success: false, error: 'IDが必要です' };
  const { error } = await supabase.from('shopping_list').delete().eq('id', id).eq('pair_id', pairId);
  if (error) return { success: false, error: '削除に失敗しました' };
  return { success: true };
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
  await Promise.all([
    supabase.from('app_settings').upsert({ pair_id: pairId, key: 'husbandBaseContribution', value: String(hv) }, { onConflict: 'pair_id, key' }),
    supabase.from('app_settings').upsert({ pair_id: pairId, key: 'wifeBaseContribution', value: String(wv) }, { onConflict: 'pair_id, key' }),
    supabase.from('app_settings').upsert({ pair_id: pairId, key: 'husbandName', value: hName }, { onConflict: 'pair_id, key' }),
    supabase.from('app_settings').upsert({ pair_id: pairId, key: 'wifeName', value: wName }, { onConflict: 'pair_id, key' })
  ]);

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

/**
 * レシートOCR (Gemini API)
 */
async function handleScanReceipt(data, actor) {
  if ((!actor || !actor.verified) && !isDemoAllowed()) {
    return { success: false, code: 'AUTH', error: 'レシート読み取りにはLINEログインとメンバー登録が必要です' };
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { success: false, error: 'GEMINI_API_KEY が未設定です' };

  const mime = String(data.mimeType || 'image/jpeg');
  const b64 = String(data.imageBase64 || '');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    return { success: false, error: '対応していない画像形式です' };
  }
  if (!b64 || b64.length > 7000000) {
    return { success: false, error: '画像が空、または大きすぎます' };
  }

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

  const modelsToTry = [
    process.env.GEMINI_MODEL,
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash'
  ].filter(Boolean);

  let res = null;
  let lastErrorDetail = '';
  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey.trim()
        },
        body: JSON.stringify(body)
      });
      if (res.ok) break;
      lastErrorDetail = await res.text();
      console.warn(`Gemini try failed (${model}): ${res.status} ${lastErrorDetail}`);
      if (res.status !== 404) break;
    } catch (err) {
      lastErrorDetail = err.message;
    }
  }

  if (!res || !res.ok) {
    return { success: false, error: `AI読み取りに失敗しました: ${lastErrorDetail.slice(0, 100)}` };
  }

  try {
    const json = await res.json();
    const rawText = json.candidates[0].content.parts[0].text;
    const parsed = JSON.parse(rawText);

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
  for (const it of data.items) {
    const name = String(it.name || '').trim().slice(0, 50);
    const qty = Number(it.quantity);
    const price = Number(it.price);
    if (!name || !Number.isInteger(qty) || qty < 1 || !Number.isInteger(price) || price === 0) {
      return { success: false, error: '明細の入力内容が不正です: ' + name };
    }
    items.push({ name, qty, price, unitPrice: Math.round(price / qty) });
  }

  const total = items.reduce((s, it) => s + it.price, 0);
  if (total <= 0) return { success: false, error: '合計金額が0円以下です' };

  const payer = String(data.payer || actor.name).trim();

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

  // 2. receipt_items 登録
  const itemRows = items.map(it => ({
    receipt_id: receiptId,
    item_name: it.name,
    normalized_name: normalizeName(it.name),
    quantity: it.qty,
    price: it.price,
    unit_price: it.unitPrice,
    category_id: String(data.category || '食費')
  }));

  const { error: itemErr } = await supabase.from('receipt_items').insert(itemRows);
  if (itemErr) {
    console.error('receipt_items登録失敗:', itemErr);
  }

  // 3. transactions 登録（支出親レコード）
  const txRow = {
    pair_id: pairId,
    date: date,
    title: store,
    amount: total,
    category_id: String(data.category || '食費').slice(0, 20),
    is_shared: data.isShared !== false && String(data.isShared) !== 'false',
    payment_type: data.paymentType || 'shared_card',
    payer_id: payer,
    memo: 'レシート読み取り',
    created_by: actor.name,
    receipt_id: receiptId
  };

  const { data: txData, error: txErr } = await supabase.from('transactions').insert(txRow).select('id').single();
  if (txErr) {
    console.error('transactions登録失敗:', txErr);
  }

  const txId = txData ? txData.id : null;
  await writeAudit(supabase, actor, pairId, '追加', 'レシート', txId, null, {
    receiptId, date, title: store, amount: total, items
  });

  return { success: true, receiptId, txId, total };
}

/**
 * 価格検索 (searchPrices)
 */
async function handleSearchPrices(supabase, query, actor) {
  const pairId = getTargetPairId(actor, {});
  const q = normalizeName(query);
  if (!q) return { success: false, error: '検索する品名を入力してください' };

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

  // 品名のあいまい検索（当該ペアのレシートに限定）
  const { data: matchedItems } = await supabase
    .from('receipt_items')
    .select('id, receipt_id, item_name, normalized_name, quantity, price, unit_price, receipts!inner(date, store_name, pair_id)')
    .eq('receipts.pair_id', pairId)
    .gt('price', 0)
    .gt('unit_price', 0)
    .ilike('normalized_name', `%${q}%`);

  const filtered = (matchedItems || [])
    .filter(it => !excludedReceiptIds.has(it.receipt_id))
    .sort((a, b) => (a.receipts.date < b.receipts.date ? 1 : -1));

  if (filtered.length === 0) {
    return { success: true, query, count: 0, stats: null, byStore: [], history: [] };
  }

  const prices = filtered.map(f => Number(f.unit_price));
  const stats = {
    latest: prices[0],
    min: Math.min(...prices),
    max: Math.max(...prices),
    avg: Math.round(prices.reduce((s, p) => s + p, 0) / prices.length)
  };

  const storeMap = {};
  filtered.forEach(it => {
    const sName = it.receipts.store_name;
    const uPrice = Number(it.unit_price);
    if (!storeMap[sName]) {
      storeMap[sName] = { store: sName, latest: uPrice, latestDate: it.receipts.date, min: uPrice, count: 0 };
    }
    const sm = storeMap[sName];
    sm.min = Math.min(sm.min, uPrice);
    sm.count++;
  });

  return {
    success: true,
    query,
    count: filtered.length,
    stats,
    byStore: Object.values(storeMap).sort((a, b) => a.min - b.min),
    history: filtered.slice(0, 100).map(it => ({
      date: it.receipts.date,
      store: it.receipts.store_name,
      name: it.item_name,
      quantity: Number(it.quantity) || 1,
      price: Number(it.price) || 0,
      unitPrice: Number(it.unit_price) || 0
    }))
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
    return { success: false, error: '参加者は2名以上入力してください（例: 夫, 妻, 友人A）' };
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

async function sendLineReply(replyToken, text, token) {
  if (!token || !replyToken) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: 'text', text: String(text).slice(0, 4900) }]
      })
    });
  } catch (err) {
    console.error('LINE返信エラー:', err);
  }
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

  // ヘルプ
  if (/^(ヘルプ|使い方|help)$/i.test(text)) {
    return '💡【家計簿Botの使い方】\n\n' +
      '■ かんたん支出登録\n・スーパー 3200\n・立替 2500 ドラッグストア\n・共同カード 私物 4800 服\n\n' +
      '■ 買い物リスト\n・買う 牛乳\n\n' +
      '■ 状況確認\n・残金\n・振込額\n\n' +
      '■ 価格を調べる\n・ネギ いくら\n・価格 豆腐\n\n' +
      '✈️ 旅行・イベント精算やレシート読み取りはアプリ画面から行えます';
  }

  // 残金確認
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

  // 振込額確認
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

  // 買い物リスト追加
  const buyMatch = text.match(/^(?:買う|買い物|買出)\s+(.+)$/);
  if (buyMatch) {
    const itemName = buyMatch[1].trim().slice(0, 50);
    await handleAddShoppingItem(supabase, { title: itemName, category: '日用品' }, actor);
    return `🛒 買い物リストに「${itemName}」を追加しました！`;
  }

  // 価格検索
  const priceMatch = text.match(/^(?:価格|値段|相場)\s+(.+)$/) || text.match(/^(.+?)\s*(?:の値段|の価格|の相場|いくら)$/);
  if (priceMatch && priceMatch[1] !== '今月') {
    const r = await handleSearchPrices(supabase, priceMatch[1].trim(), actor);
    if (!r.success) return r.error;
    if (r.count === 0) return `「${priceMatch[1].trim()}」の購入履歴はまだありません。レシートを読み取ると記録されます📷`;
    const lines = r.history.slice(0, 5).map(h => `・${h.date} ${h.store} ¥${h.unitPrice.toLocaleString()}`);
    return `🔎「${r.query}」の価格履歴（${r.count}件）\n` +
      lines.join('\n') + `\n━━━━━━━━━━━━━━\n` +
      `直近 ¥${r.stats.latest.toLocaleString()} / 最安 ¥${r.stats.min.toLocaleString()} / 平均 ¥${r.stats.avg.toLocaleString()} / 最高 ¥${r.stats.max.toLocaleString()}`;
  }

  // 支出入力パーサー
  const parts = text.split(/[\s　]+/);
  if (parts.length < 2) {
    return '入力方法がわかりませんでした💦\n例:「スーパー 3200」「立替 1500 日用品」\n「ヘルプ」で使い方を表示します。';
  }

  let amount = null;
  let paymentType = 'shared_card';
  let isShared = true;
  let payer = actor.name;
  const remainingParts = [];

  parts.forEach(part => {
    const cleanNum = part.replace(/[¥,円]/g, '');
    if (/^\d+$/.test(cleanNum) && amount === null) { amount = parseInt(cleanNum, 10); return; }
    if (part === '立替') { paymentType = 'advanced_by_user'; return; }
    if (part === '私物' || part === '個人') { isShared = false; return; }
    if (part === '共同カード') { paymentType = 'shared_card'; return; }
    if (part === config.husbandName || part === '夫' || part === 'パパ') { payer = config.husbandName; return; }
    if (part === config.wifeName || part === '妻' || part === 'ママ') { payer = config.wifeName; return; }
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

  await handleAddTransaction(supabase, {
    date: todayStr(),
    title: title,
    amount: amount,
    category: category,
    isShared: isShared,
    paymentType: paymentType,
    payer: payer,
    memo: 'LINE Bot登録'
  }, actor);

  let typeDesc = '共同費';
  if (!isShared && paymentType === 'shared_card') typeDesc = `⚠️共同カード私物（${payer}の振込額に加算）`;
  else if (isShared && paymentType === 'advanced_by_user') typeDesc = `✨個人立替（${payer}の振込額から控除）`;

  return `✅ 記録しました！\n━━━━━━━━━━━━━━\n品名: ${title}\n金額: ¥${amount.toLocaleString()}\nカテゴリ: ${category}\n種別: ${typeDesc}\n支払者: ${payer}\n━━━━━━━━━━━━━━`;
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
        case 'searchPrices':
          result = await handleSearchPrices(supabase, data.query, actor);
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
