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
// ==========================================
// 暗号学的ソルト付きハッシュ (PBKDF2-HMAC-SHA256) 設定 (v2.12.0)
// ==========================================
const HASH_PEPPER = normalizeEnvSecret(process.env.HASH_PEPPER) || 'pair_budget_secure_pepper_2026_salt_v2';
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';

const ALLOWED_PAYMENT_TYPES = [
  'shared_card',
  'shared_account',
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
    // すでに対象ペア（DEFAULT_PAIR_ID等）に2名以上の正規LINEメンバーが登録済みの場合は、
    // 外部の未登録LINEアカウント（友だち追加しただけの第三者）からのデータ閲覧・操作を厳格にブロックする (v2.16.1)
    const { data: existingMembers } = await supabase
      .from('users')
      .select('line_user_id, slot')
      .eq('pair_id', safePairId);

    const hasBothSlots = (existingMembers || []).some(m => m.slot === 'husband' || m.slot === 'slot1') &&
                         (existingMembers || []).some(m => m.slot === 'wife' || m.slot === 'slot2');

    if (hasBothSlots || (existingMembers && existingMembers.length >= 2)) {
      return {
        allowed: false,
        verified: false,
        code: 'UNAUTHORIZED_LINE_USER',
        error: '🔒 この家計簿はすでにパートナー2名でロックされています。招待コードをお持ちでない第三者のアカウントからは閲覧・操作できません。'
      };
    }

    // まだペアの2枠が埋まっていない初期セットアップ中のみオンボーディングを許可
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
/**
 * 128bit (16バイト) の安全な暗号学的ソルトを生成 (hex文字列)
 */
function generateSalt(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * ソルト付きPBKDF2-HMAC-SHA256ハッシュを生成 (v2.12.0)
 * フォーマット: pbkdf2_sha256$<iterations>$<salt>$<hash>
 */
function hashSecretWithSalt(secret, customSalt = null, iterations = PBKDF2_ITERATIONS) {
  if (secret === undefined || secret === null || secret === '') return '';
  const salt = customSalt || generateSalt(16);
  const saltedSecret = String(secret) + HASH_PEPPER;
  const hash = crypto.pbkdf2Sync(saltedSecret, salt, iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

/**
 * ソルト付きハッシュの定数時間比較検証（タイミング攻撃耐性）
 */
function verifySecretWithSalt(secret, storedHashRecord) {
  if (!secret || !storedHashRecord) return false;
  try {
    const parts = String(storedHashRecord).split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') {
      if (storedHashRecord === crypto.createHash('sha256').update(String(secret)).digest('hex') || storedHashRecord === String(secret)) {
        return true;
      }
      return false;
    }
    const iterations = parseInt(parts[1], 10) || PBKDF2_ITERATIONS;
    const salt = parts[2];
    const expectedHash = parts[3];

    const saltedSecret = String(secret) + HASH_PEPPER;
    const computedHash = crypto.pbkdf2Sync(saltedSecret, salt, iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');

    const expectedBuf = Buffer.from(expectedHash, 'hex');
    const computedBuf = Buffer.from(computedHash, 'hex');
    if (expectedBuf.length !== computedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, computedBuf);
  } catch (err) {
    console.error('ハッシュ検証エラー:', err);
    return false;
  }
}

/**
 * デフォルト口座構成の生成ヘルパー (v2.13.1: ふたりの共有口座・カードを正の残高で初期化)
 */
function getDefaultBankAccounts() {
  const now = new Date().toISOString();
  return [
    {
      id: 'acc_shared_pair_bank',
      name: 'ふたりの共有口座',
      type: 'shared_bank',
      balance: 161421,
      institution: '共有銀行口座',
      note: '普段の生活費・引落用口座',
      updatedAt: now
    },
    {
      id: 'acc_shared_savings',
      name: '別口座貯金（余り繰越用）',
      type: 'shared_savings',
      balance: 0,
      institution: '貯蓄用別口座',
      note: '余った分の繰越・共同貯金',
      updatedAt: now
    },
    {
      id: 'acc_shared_pair_card',
      name: 'ふたりの共有カード',
      type: 'shared_card',
      balance: 0,
      institution: 'クレジットカード',
      note: '日常の生活費決済用',
      updatedAt: now
    }
  ];
}

async function writeAudit(supabase, actor, pairId, action, targetType, targetId, before, after) {
  try {
    const afterData = after ? { ...after } : {};
    // ソルト付き改ざん防止整合性署名を付与 (PBKDF2 10,000回・v2.12.0)
    const salt = generateSalt(8);
    const signPayload = JSON.stringify({
      pairId: pairId || DEFAULT_PAIR_ID,
      actor: actor ? actor.name : 'system',
      action: action,
      targetType: targetType,
      targetId: String(targetId || ''),
      before: before || null,
      after: afterData
    });
    const integrityHash = hashSecretWithSalt(signPayload, salt, 10000);
    afterData._salt = salt;
    afterData._integrityHash = integrityHash;

    await supabase.from('audit_logs').insert({
      pair_id: pairId || DEFAULT_PAIR_ID,
      actor_id: actor ? actor.name : 'system',
      action: action,
      target_type: targetType,
      target_id: String(targetId || ''),
      before_data: before || null,
      after_data: afterData
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
    autoCheckShoppingOnReceipt: true,
    bankAccounts: null,
    securityPinHash: null
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
    if (s.key === 'bankAccounts') {
      try {
        let accs = JSON.parse(s.value);
        if (Array.isArray(accs)) {
          config.bankAccounts = sanitizeAndDedupeBankAccounts(accs, config.savingsConfig);
        }
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
    const isPriv = !tx.isShared && (tx.paymentType === 'shared_card' || tx.paymentType === 'shared_account');
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
  // 口座入金・収入・クレカ引落振替・マイナス金額は生活費の支出合計から除外 (v2.13.1 簿記照合)
  const nonExpenseCats = ['口座入金', '収入', 'クレカ引落振替', '振替'];
  const totalExpense = txs
    .filter(t => t.isShared && !nonExpenseCats.includes(t.category_id) && !nonExpenseCats.includes(t.category) && Number(t.amount) > 0)
    .reduce((s, t) => s + Number(t.amount), 0);
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
      .select('date, amount, is_shared, payment_type, payer_id, category_id')
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

  const fixedExpenses = (fixedRes.data || []).map(f => {
    let pType = f.payment_type;
    if (!pType) {
      if (f.payer === '共同カード' || (f.title && (f.title.includes('サブスク') || f.title.includes('カード')))) {
        pType = 'shared_card';
      } else {
        pType = 'shared_account';
      }
    }
    return {
      id: f.id,
      title: f.title,
      amount: Number(f.amount) || 0,
      category: f.category_id,
      billingDay: f.billing_day,
      isActive: f.is_active,
      paymentType: pType,
      payer: f.payer || (pType === 'shared_card' ? '共同カード' : '共同口座')
    };
  });

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
      sharedCardPersonal: 0,
      sharedAccount: 0,
      sharedAccountLiving: 0,
      sharedAccountPersonal: 0
    };
    totalsOrder.push(m);
  }

  (allTxRes.data || []).forEach(tx => {
    const m = tx.date.slice(0, 7);
    const b = totalsMap[m];
    if (!b) return;
    const amt = Number(tx.amount) || 0;
    const isSharedCard = tx.payment_type === 'shared_card';
    const isSharedAccount = tx.payment_type === 'shared_account';
    const nonExpenseCats = ['口座入金', '収入', 'クレカ引落振替', '振替'];
    const isLivingExpense = !nonExpenseCats.includes(tx.category_id);

    if (isSharedCard) {
      b.sharedCard += amt;
      if (tx.is_shared && isLivingExpense) {
        b.sharedCardLiving += amt;
      } else {
        b.sharedCardPersonal += amt;
      }
    } else if (isSharedAccount) {
      b.sharedAccount += amt;
      if (tx.is_shared && isLivingExpense) {
        b.sharedAccountLiving += amt;
      } else {
        b.sharedAccountPersonal += amt;
      }
    }
    if (tx.is_shared && isLivingExpense) {
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
    version: 'v2.17.0',
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
    bankAccounts: config.bankAccounts,
    securitySettings: {
      hasSecurityPin: !!config.securityPinHash,
      algorithm: 'PBKDF2-HMAC-SHA256',
      iterations: PBKDF2_ITERATIONS,
      saltBits: 128,
      status: 'active'
    },
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
      { pair_id: pairId, title: '家賃', amount: 110000, category_id: '住居費', billing_day: 27, is_active: true, payment_type: 'shared_account', payer: '共同口座' }
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

  let pType = item.paymentType || item.payment_type;
  if (!pType) {
    if (item.payer === '共同カード' || (title && (title.includes('サブスク') || title.includes('カード')))) {
      pType = 'shared_card';
    } else {
      pType = 'shared_account';
    }
  }

  const payload = {
    pair_id: pairId,
    title: title,
    amount: amount,
    category_id: String(item.category || 'その他').slice(0, 20),
    billing_day: Math.min(31, Math.max(1, Number(item.billingDay) || 1)),
    is_active: item.isActive !== false,
    payment_type: pType,
    payer: String(item.payer || (pType === 'shared_card' ? '共同カード' : '共同口座')).slice(0, 20),
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
    '【大原則: 99%以上のレシートは通常の購入（支出）である】\n' +
    '- 通常の買い物レシートは、必ず isRefund: false、total は正の整数（例: 840）で出力すること。\n' +
    '- 値引き行（CPNや割引）が一部含まれていても、レシート全体は通常の購入（isRefund: false）である。\n' +
    '- レシート全体が「返金・返品レシート」になるのは、レシートのタイトルに「返金」「返品」「REFUND」と印字され、全商品が返品されている極めて稀なケースのみである。\n' +
    '【重要ルール1: 単価・数量・金額の行ズレ防止（日本のスーパー、ベイシア・イオン等）】\n' +
    '- 商品名のみの行（右端に金額印字がない行）の直下の行に「@単価 数量 小計金額」（例: "@52 2 ¥104"）が印字されている場合、その数量と金額は【必ず直上の商品名（例: まろやか絹豆腐）】のものである。絶対に直下の別商品（例: 白菜）と結びつけたり分断しないこと！\n' +
    '【重要ルール2: クーポン値引き・税区分表記（コストコ・スーパー等）】\n' +
    '- 「180 E」「480 E」「3498 T」「520 A」のように、金額の右に英字（E=軽減税率8%、T/A=標準税率10%等）が付いている表記で、マイナス記号「-」がないものは【通常の正の整数（例: 180, 480）】である！絶対に負の数にしてはならない！\n' +
    '- 負の整数（マイナス）になるのは、金額の直後に明確にハイフンが付いている場合（例: "700-T", "897-E", "897-"）や、先頭に「▲」「△」「-」が付く値引きのみ！\n' +
    '- "CPN"（クーポン）、"TPD"、"値引"、"割引" の行は必ず負の整数（例: -700）の price にすること。\n' +
    '【重要ルール3: 返金レシートの出力基準】\n' +
    '- 通常の購入は必ず isRefund: false、total は正の整数。\n' +
    '- タイトルや全明細に明示的に「返金」「返品」「REFUND」とある場合のみ isRefund: true。\n' +
    '【重要ルール4: 整数円・検算】\n' +
    '- price は「その行の税込合計金額（数量×単価）」の整数円（値引きのみ負の整数）。\n' +
    '- quantity は数量（不明なら1）。\n' +
    '- 品名はレシート表記のまま。ポイント・小計・合計・お釣り・税額の行は明細に含めない。\n' +
    '- date は yyyy-MM-dd。読み取れなければ空文字。\n' +
    '- total はレシートに印字された最終支払合計（税込）の整数円（通常購入は必ず正の整数）。読み取れなければ0。\n' +
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

    // 返金レシートの厳密判定 (v2.9.0: 通常の購入デフォルトの徹底・誤判定の完全撲滅)
    // 店名、または明細の品名に明示的な「返金」「返品」「REFUND」「RFND」キーワードが存在するかチェック
    const rawItems = parsed.items || [];
    const storeHasRefund = /返金|返品|REFUND|RFND/i.test(parsed.store || '');
    const refundItemsCount = rawItems.filter(it => /返金|返品|REFUND|RFND/i.test(it.name || '')).length;
    const isMajorityRefundItems = rawItems.length > 0 && (refundItemsCount / rawItems.length >= 0.5);

    // 明確な証拠（店名に返金/返品、または明細の過半数が返品/返金）がある場合「のみ」返金レシートとして認める
    let isRefund = false;
    if (storeHasRefund || isMajorityRefundItems) {
      isRefund = true;
    } else {
      // それ以外はAIが isRefund: true や負の total を返してきても、AIの誤判定・誤読として通常の購入（isRefund: false）に強制修復！
      isRefund = false;
    }

    let total = parseInt(parsed.total, 10) || 0;
    if (isRefund) {
      if (total > 0) total = -total;
    } else {
      total = Math.abs(total);
    }

    let items = rawItems.slice(0, 60).map(it => {
      let p = parseInt(it.price, 10) || 0;
      const name = String(it.name || '').trim().slice(0, 50);
      const isDiscountItem = /CPN|TPD|値引|割引|クーポン|▲|△/i.test(name);

      if (isRefund) {
        if (p > 0) p = -p;
      } else {
        // 通常購入レシート: 値引き行以外は必ず正の金額（税区分E/Tの誤読やAIのマイナス誤判定を完全自動修復）
        if (isDiscountItem) {
          if (p > 0) p = -p;
        } else {
          p = Math.abs(p);
        }
      }

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
      payer_id: ((paymentType === 'shared_card' || paymentType === 'shared_account') ? '共同' : payer),
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
      payer_id: ((paymentType === 'shared_card' || paymentType === 'shared_account') ? '共同' : payer),
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

  // 3. 代理入力解除コマンド (v2.9.0: 永続代理モードの解除)
  if (/^(?:代理解除|代理終了|代理モード解除|自分に戻す|通常モード)$/i.test(text)) {
    await setAppSetting(supabase, pairId, `lineProxyState_${userId}`, null);
    await setAppSetting(supabase, pairId, 'lineProxyState', null);
    return '👥 代理モードを解除しました！\nこれ以降は通常通り【ご自身の支出】として記録されます✨';
  }

  // 3-B. 支払いモード切替・確認コマンド (v2.9.0)
  if (/^(?:立替モード|立て替えモード|立替で登録|立替モードに変更|立替に変更)$/i.test(text)) {
    await setAppSetting(supabase, pairId, `linePaymentMode_${userId}`, 'advanced_by_user');
    return `👤【立替モードに切り替えました】\nこれ以降に送信するレシート画像や支出は、次に変更するまで自動的に【個人立替（共同口座から後で精算）】として記録されます✨\n\n💡 共同カードに戻すには「共同カードモード」と送信してください。`;
  }
  if (/^(?:共同カードモード|カードモード|共同カードで登録|共同カードに変更|カードに変更)$/i.test(text)) {
    await setAppSetting(supabase, pairId, `linePaymentMode_${userId}`, 'shared_card');
    return `💳【共同カードモードに切り替えました】\nこれ以降に送信するレシート画像や支出は、次に変更するまで自動的に【共同カード（クレカ払）】として記録されます✨\n\n💡 立替にするには「立替モード」と送信してください。`;
  }
  if (/^(?:共同口座モード|口座振替モード|口座引落モード|共同口座に変更)$/i.test(text)) {
    await setAppSetting(supabase, pairId, `linePaymentMode_${userId}`, 'shared_account');
    return `🏦【共同口座振替モードに切り替えました】\nこれ以降に送信するレシート画像や支出は、次に変更するまで自動的に【共同口座振替（口座直引落）】として記録されます✨\n\n💡 戻すには「共同カードモード」または「立替モード」と送信してください。`;
  }
  if (/^(?:支払いモード|支払モード|モード確認|現在のモード|モード)$/i.test(text)) {
    const currentMode = await getAppSetting(supabase, pairId, `linePaymentMode_${userId}`, 'shared_card');
    const proxyState = await getAppSetting(supabase, pairId, `lineProxyState_${userId}`, null)
      || await getAppSetting(supabase, pairId, 'lineProxyState', null);
    let modeText = '💳 共同カード（クレカ払）';
    if (currentMode === 'advanced_by_user') modeText = '👤 個人立替（共同口座から後で精算）';
    else if (currentMode === 'shared_account') modeText = '🏦 共同口座振替（直接引落）';

    let proxyText = '通常（自分名義）';
    if (proxyState && proxyState.payer) {
      proxyText = `👥 代理中: ${proxyState.payer}さん名義`;
    }

    return `⚙️【現在のLINE登録設定】\n━━━━━━━━━━━━━━\n支払方法: 【${modeText}】\n支払名義: 【${proxyText}】\n━━━━━━━━━━━━━━\n💡 切り替えコマンド:\n・「立替モード」/「共同カードモード」/「共同口座モード」\n・「代理 〇〇」/「代理解除」`;
  }

  // 4. 代理入力コマンド（事後変更または永続事前設定） (v2.9.0)
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

    // B. 永続代理モード: 次回「代理解除」が送られるまで永続的に代理モードを維持 (v2.9.0)
    await setAppSetting(supabase, pairId, `lineProxyState_${userId}`, {
      payer: targetMember,
      active: true
    });
    return `👥【代理モード開始】\n支払者を「${targetMember}さん」として設定しました！\nこれ以降に送信するレシート画像や支出は、解除するまでずっと【${targetMember}さんの支出】として自動登録されます✨\n\n💡 自分に戻すには「代理解除」または「通常モード」と送信してください。`;
  }

  // 5. ヘルプ
  if (/^(ヘルプ|使い方|help)$/i.test(text)) {
    return '💡【家計簿Botの使い方】\n\n' +
      '■ かんたん支出登録\n・スーパー 3200\n・立替 2500 ドラッグストア\n・共同カード 私物 4800 服\n・口座引落 110000 家賃\n\n' +
      '■ 支払いモード切替（次回変更まで継続）\n・立替モード（レシートや支出を立替で自動登録）\n・共同カードモード（共同カード払いに戻す）\n・共同口座モード（口座引落で登録）\n・モード確認（現在の設定を確認）\n\n' +
      '■ 代理入力モード（解除するまで継続）\n・代理 夫（夫名義で連続登録）\n・代理解除（自分名義に戻す）\n\n' +
      '■ 買い物リスト（まとめて追加もOK！）\n・買う 牛乳\n・買い物リスト見せて\n・牛乳と卵買ったよ〜\n・複数行で品名だけ送っても一括追加！\n\n' +
      '■ レシート対話編集\n・レシート変更（直近レシートの私物・共同を対話修正）\n\n' +
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

  // 11-2. 口座残高即時更新コマンド (v2.12.0 おしどり連携)
  // 例:「口座残高 350000」「残高更新 385000」「残高 35万」「預金残高 300,000円」
  const balanceUpdateMatch = text.match(/^(?:口座残高|残高更新|預金残高|残高)\s*[:：]?\s*([0-9０-９,，万億.\s]+)\s*円?$/i);
  if (balanceUpdateMatch) {
    let rawAmountStr = balanceUpdateMatch[1].replace(/[,，]/g, '').replace(/\s+/g, '');
    rawAmountStr = rawAmountStr.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
    let parsedAmount = 0;
    if (rawAmountStr.includes('万')) {
      const parts = rawAmountStr.split('万');
      parsedAmount = (parseFloat(parts[0]) || 0) * 10000 + (parseFloat(parts[1]) || 0);
    } else if (rawAmountStr.includes('億')) {
      const parts = rawAmountStr.split('億');
      parsedAmount = (parseFloat(parts[0]) || 0) * 100000000 + (parseFloat(parts[1]) || 0);
    } else {
      parsedAmount = parseInt(rawAmountStr, 10) || 0;
    }

    if (isNaN(parsedAmount) || parsedAmount < 0) {
      return '残高には0以上の数値を指定してください🙏\n例:「口座残高 350000」「残高 35万」';
    }

    let bankAccounts = config.bankAccounts || [];
    if (!Array.isArray(bankAccounts) || bankAccounts.length === 0) {
      bankAccounts = getDefaultBankAccounts();
    }

    let targetAcc = bankAccounts.find(a => a.type === 'shared_bank');
    if (!targetAcc) {
      targetAcc = bankAccounts[0];
    }
    if (!targetAcc) {
      targetAcc = { id: 'bank_default_shared', name: '共有メイン口座', type: 'shared_bank', balance: parsedAmount, updatedAt: new Date().toISOString() };
      bankAccounts.push(targetAcc);
    } else {
      targetAcc.balance = parsedAmount;
      targetAcc.updatedAt = new Date().toISOString();
    }

    await setAppSetting(supabase, pairId, 'bankAccounts', bankAccounts);
    await writeAudit(supabase, actor, pairId, '残高更新', '口座残高ボード', targetAcc.id, null, { balance: parsedAmount, accountName: targetAcc.name });

    // 次回引落予定額（当月利用分: 共同カード + 共同口座振替）を計算
    const curMonth = getMonthDateRange(getCurrentMonth()).startDate.slice(0, 7);
    const { startDate, endDate } = getMonthDateRange(curMonth);
    const { data: monthTxs } = await supabase
      .from('transactions')
      .select('amount, payment_type, is_shared')
      .eq('pair_id', pairId)
      .gte('date', startDate)
      .lte('date', endDate);

    const sharedBankTotal = bankAccounts
      .filter(a => a.type === 'shared_bank')
      .reduce((sum, a) => sum + (Number(a.balance) || 0), 0);

    const sharedCardUsage = (monthTxs || [])
      .filter(t => t.is_shared && t.payment_type === 'shared_card')
      .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

    const sharedTransferUsage = (monthTxs || [])
      .filter(t => t.is_shared && t.payment_type === 'shared_account')
      .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

    const nextBillingTotal = sharedCardUsage + sharedTransferUsage;
    const projectedBalance = sharedBankTotal - nextBillingTotal;

    let reply = `🏦 ${targetAcc.name}の預金残高を【¥${parsedAmount.toLocaleString()}】に更新しました！✨\n\n`;
    reply += `💳 次回引落予定: ¥${nextBillingTotal.toLocaleString()} (カード¥${sharedCardUsage.toLocaleString()} + 口座振替¥${sharedTransferUsage.toLocaleString()})\n`;
    reply += `💰 引落後予想残高: ¥${projectedBalance.toLocaleString()}`;

    if (projectedBalance < 0) {
      reply += `\n⚠️【残高不足警告】引落後に ¥${Math.abs(projectedBalance).toLocaleString()} 不足します！早めの口座入金が必要です。`;
    } else if (projectedBalance < 10000) {
      reply += `\n⚠️【残高注意】引落後の残高が1万円未満になります。`;
    }

    return reply;
  }

    // 11-3. 口座残高照会 ＆ 家計Q&A自然言語応答コマンド (v2.16.1 おしどり連携＆LINE会話質問対応)
  // 例:「口座残高」「残高教えて」「今月いくら使った？」「レシート何枚？」「カード利用額は？」「別口座貯金いくら？」「今日いくら使える？」
  const isAccountOrBudgetQuestion =
    /^(?:口座残高|残高確認|預金残高|口座確認|引落予定|引き落とし予定|カード明細|クレカ明細|口座|残高|貯金|別口座|積立)$/i.test(text) ||
    /(?:今月.*(?:いくら|どのくらい|何円|使った|支出|利用|残金|残り|予算)|(?:レシート|明細).*(?:何枚|何件|いくつ|枚数)|(?:口座|預金|貯金|積立|カード|クレカ|引落|引き落とし).*(?:いくら|残高|教えて|確認|見せて|どう|状況|合計|累計)|(?:今日|1日|一日).*(?:いくら使える|目安))/.test(text);

  if (isAccountOrBudgetQuestion) {
    const curMonth = getMonthDateRange(getCurrentMonth()).startDate.slice(0, 7);
    const initData = await handleGetInitialData(supabase, curMonth, actor, pairId);
    const s = initData.summary || { budget: 240000, totalExpense: 0, remaining: 240000, dailyAllowance: 0, daysLeft: 0 };
    const monthTxs = initData.transactions || [];
    const nonExpenseCats = ['口座入金', '収入', 'クレカ引落振替', '振替'];

    const bankAccounts = sanitizeAndDedupeBankAccounts(config.bankAccounts || getDefaultBankAccounts(), config.savingsConfig);
    const sharedBankTotal = bankAccounts
      .filter(a => a.type === 'shared_bank')
      .reduce((sum, a) => sum + (Number(a.balance) || 0), 0);
    const sharedSavingsAccBal = bankAccounts
      .filter(a => a.type === 'shared_savings')
      .reduce((sum, a) => sum + (Number(a.balance) || 0), 0);
    const separateSavingsTotal = sharedSavingsAccBal > 0
      ? sharedSavingsAccBal
      : Number(config.savingsConfig?.initialSavings || 0);
    const totalCombinedAssets = sharedBankTotal + separateSavingsTotal;

    const expenseTxs = monthTxs.filter(t => t.isShared !== false && !nonExpenseCats.includes(t.category) && Number(t.amount) > 0);
    const sharedCardUsage = expenseTxs
      .filter(t => t.paymentType === 'shared_card')
      .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    const sharedTransferUsage = expenseTxs
      .filter(t => t.paymentType === 'shared_account')
      .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

    // レシート枚数集計
    const receiptIds = new Set();
    let manualReceiptCount = 0;
    expenseTxs.forEach(t => {
      if (t.receiptId) {
        receiptIds.add(String(t.receiptId));
      } else if (!String(t.memo || '').includes('明細取込')) {
        manualReceiptCount += 1;
      }
    });
    const totalReceiptCount = receiptIds.size + manualReceiptCount;

    const nextBillingTotal = sharedCardUsage + sharedTransferUsage;
    const projectedBalance = sharedBankTotal - nextBillingTotal;

    let reply = `📊【今月の家計＆口座まとめ (${curMonth})】\n`;
    reply += `━━━━━━━━━━━━━━\n`;
    reply += `💸 今月使ったお金: ¥${Number(s.totalExpense || 0).toLocaleString()}\n`;
    reply += `💰 生活費予算 残金: ¥${Number(s.remaining || 0).toLocaleString()} (予算 ¥${Number(s.budget || 0).toLocaleString()})\n`;
    reply += `📅 1日あたり目安: ¥${Number(s.dailyAllowance || 0).toLocaleString()}/日 (残り${s.daysLeft || 0}日)\n`;
    reply += `🧾 レシート登録数: ${totalReceiptCount}枚 (明細 計${expenseTxs.length}件)\n`;
    reply += `━━━━━━━━━━━━━━\n`;
    reply += `🏦【共同口座・別口座貯金】\n`;
    reply += `・合計残高: ¥${totalCombinedAssets.toLocaleString()}\n`;
    reply += `  ① 普段の生活費口座: ¥${sharedBankTotal.toLocaleString()}\n`;
    reply += `  ② 別口座貯金(繰越): ¥${separateSavingsTotal.toLocaleString()}\n\n`;
    reply += `💳【カード・次回引落予定】\n`;
    reply += `・今月のカード利用累計: ¥${sharedCardUsage.toLocaleString()}\n`;
    reply += `・口座振替(固定費等): ¥${sharedTransferUsage.toLocaleString()}\n`;
    reply += `・次回引落予定合計: ¥${nextBillingTotal.toLocaleString()}\n`;
    reply += `・引落後予想残高: ¥${projectedBalance.toLocaleString()}\n`;

    if (projectedBalance < 0) {
      reply += `\n⚠️【残高不足警告】引落後に ¥${Math.abs(projectedBalance).toLocaleString()} 不足します！早めの口座入金をおすすめします。`;
    } else if (projectedBalance < 10000 && nextBillingTotal > 0) {
      reply += `\n⚠️【残高注意】引落後の残高が1万円未満になります。`;
    } else {
      reply += `\n✨ 次回引落も残高十分で安心です！`;
    }

    reply += `\n\n💡 残高更新は「口座残高 161421」のように送信すると即時反映されます。`;
    return reply;
  }

  // 11-4. AI家計分析・データベース抽出ファイル出力コマンド (v2.17.0)
  // 例:「AI分析」「データ抽出」「AI用データ」「ファイル抽出」「エクスポート」「CSV出力」「無駄遣い分析」
  const isAiExportRequest =
    /^(?:AI分析|AI診断|AIデータ|データ抽出|ファイル抽出|データ出力|エクスポート|CSV出力|CSV抽出|DB抽出|データベース抽出|家計分析|無駄遣い分析)$/i.test(text) ||
    /(?:(?:AI|ChatGPT|Claude|Gemini|データ|データベース|ファイル|CSV|まとめ).*(?:抽出|出力|エクスポート|ダウンロード|渡す|投げる|分析|診断)|(?:無駄遣い|お金の使い方).*(?:分析|診断|チェック))/.test(text);

  if (isAiExportRequest) {
    const curMonth = getMonthDateRange(getCurrentMonth()).startDate.slice(0, 7);
    const tokenRec = await createAiExportDownloadToken(supabase, pairId, curMonth);
    const exportData = await buildAiAnalysisExportData(supabase, pairId, curMonth);
    const baseUrl = process.env.PUBLIC_APP_URL || 'https://futari-kakeibo.vercel.app';
    const mdUrl = `${baseUrl}/api/budget?action=downloadAiExport&format=md&pairId=${encodeURIComponent(pairId)}&exportToken=${encodeURIComponent(tokenRec.token)}`;
    const csvUrl = `${baseUrl}/api/budget?action=downloadAiExport&format=csv&pairId=${encodeURIComponent(pairId)}&exportToken=${encodeURIComponent(tokenRec.token)}`;

    let msg1 = `🤖【AI家計診断・データベース抽出ファイル (${curMonth})】\n`;
    msg1 += `━━━━━━━━━━━━━━\n`;
    msg1 += `ChatGPT・Claude・Gemini等のAIにそのまま渡して「無駄遣い診断」や「上手なやりくり分析」ができる専用ファイルを生成しました！✨\n\n`;
    msg1 += `📥 ① AI分析プロンプト付きまとめファイル (.md)\n`;
    msg1 += `${mdUrl}\n\n`;
    msg1 += `📊 ② 全取引明細データ (.csv)\n`;
    msg1 += `${csvUrl}\n\n`;
    msg1 += `🔒 ※セキュリティ保護のため、上記ダウンロードURLは【30分間のみ有効】なワンタイムリンクです。\n`;
    msg1 += `💡 下の2通目のメッセージをそのままコピーしてAIに貼り付けるだけでも、すぐに精密な家計診断が受けられます！`;

    // 2通目: そのままコピーしてAIに貼り付けられる構造化プロンプト＆データ（4800文字以内に収める）
    const copyablePrompt = exportData.markdown.slice(0, 4800);

    return [
      { type: 'text', text: msg1 },
      { type: 'text', text: copyablePrompt }
    ];
  }

  // 12. 支出入力パーサー
  const parts = text.split(/[\s　]+/);
  if (parts.length < 2) {
    return '入力方法がわかりませんでした💦\n例:「スーパー 3200」「立替 1500 日用品」\n「ヘルプ」で使い方を表示します。';
  }

  let amount = null;
  // ユーザーのデフォルト支払いモードを取得 (v2.9.0)
  const savedPaymentMode = await getAppSetting(supabase, pairId, `linePaymentMode_${userId}`, 'shared_card');
  let paymentType = savedPaymentMode;
  let isShared = true;

  // 永続代理入力モードを確認 (v2.9.0)
  const proxyState = await getAppSetting(supabase, pairId, `lineProxyState_${userId}`, null)
    || await getAppSetting(supabase, pairId, 'lineProxyState', null);
  let isProxy = false;
  let payer = actor.name;
  if (proxyState && proxyState.payer) {
    payer = proxyState.payer;
    isProxy = true;
  }

  const remainingParts = [];

  parts.forEach(part => {
    const cleanNum = part.replace(/[¥,円]/g, '');
    if (/^\d+$/.test(cleanNum) && amount === null) { amount = parseInt(cleanNum, 10); return; }
    if (part === '立替') { paymentType = 'advanced_by_user'; return; }
    if (part === '私物' || part === '個人') { isShared = false; return; }
    if (part === '共同カード' || part === 'クレカ' || part === 'カード') { paymentType = 'shared_card'; return; }
    if (part === '共同口座' || part === '口座振替' || part === '口座引落' || part === '引落' || part === '口座') { paymentType = 'shared_account'; return; }
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

  // 永続代理モードのため lineProxyState は自動解除しない (v2.9.0)

  let typeDesc = '共同費（共同カード）';
  if (paymentType === 'shared_account') {
    typeDesc = isShared ? '🏦 共同口座振替' : `⚠️共同口座私物（${payer}の振込額に加算）`;
  } else if (!isShared && paymentType === 'shared_card') {
    typeDesc = `⚠️共同カード私物（${payer}の振込額に加算）`;
  } else if (isShared && paymentType === 'advanced_by_user') {
    typeDesc = `✨個人立替（${payer}の振込額から控除）`;
  } else if (!isShared && paymentType === 'advanced_by_user') {
    typeDesc = `🔒 個人私物自腹`;
  }

  const proxyBanner = isProxy ? `👥 代理入力中（支払者: ${payer}さん）\n━━━━━━━━━━━━━━\n` : '';
  return `${proxyBanner}✅ 記録しました！\n━━━━━━━━━━━━━━\n品名: ${title}\n金額: ¥${amount.toLocaleString()}\nカテゴリ: ${category}\n種別: ${typeDesc}\n支払者: ${payer}\n━━━━━━━━━━━━━━\n💡 支払切替:「立替モード」「共同カードモード」${isProxy ? '\n💡 代理解除:「代理解除」' : ''}`;
}

/**
 * LINE経由で送られたレシート画像を取得・AI解析し、家計簿へ自動保存
 */
async function processLineImageMessage(supabase, messageId, userId, lineToken) {
  if (!lineToken) return 'LINE連携トークンが未設定です';

  // 1. ユーザー特定（未登録の第三者LINEアカウントからの画像送信は即時ブロック v2.16.1）
  const { data: user } = await supabase.from('users').select('*, pairs(*)').eq('line_user_id', userId).maybeSingle();
  if (!user) {
    return '🔒 このLINEアカウントは「ふたり家計簿」のメンバーとして登録されていません。\n招待コードをお持ちの方のみ、アプリ画面からペアに参加できます。第三者の方が家計簿データを閲覧・登録することはできません。';
  }
  const pairId = user.pair_id || DEFAULT_PAIR_ID;
  const actor = {
    allowed: true,
    verified: true,
    name: user.display_name || 'LINEメンバー',
    userId,
    slot: user.slot || 'husband',
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

  // ユーザーの支払いモード（永続設定）を取得 (v2.9.0)
  const savedPaymentMode = await getAppSetting(supabase, pairId, `linePaymentMode_${userId}`, 'shared_card');
  const receiptPaymentType = (savedPaymentMode === 'advanced_by_user' || savedPaymentMode === 'shared_account') ? savedPaymentMode : 'shared_card';

  // 永続代理入力モードの確認 (v2.9.0: 自動解除せず維持)
  const proxyState = await getAppSetting(supabase, pairId, `lineProxyState_${userId}`, null)
    || await getAppSetting(supabase, pairId, 'lineProxyState', null);
  let payer = actor.name;
  let isProxy = false;
  if (proxyState && proxyState.payer) {
    payer = proxyState.payer;
    isProxy = true;
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
          paymentType: receiptPaymentType,
          payer: payer,
          category: '食費'
        },
        createdAt: Date.now()
      });

      const firstItem = receipt.items[0]?.name || receipt.store;
      return `⚠️【重複レシートの確認】\n同じ日付（${receipt.date}）・同額（¥${receipt.total.toLocaleString()}）・同じ店名/品目（${firstItem}）のレシートが既に登録されています！\n\n二重登録ではありませんか？\n👉 登録する場合は「登録する」（または「はい」）\n👉 やめる場合は「キャンセル」と返信してください`;
    }
  }

  // 6. 家計簿への自動保存（receipts + receipt_items + transactions + 買い物リスト消込）
  const saveRes = await handleSaveReceipt(supabase, {
    store: receipt.store || 'レシート店舗',
    date: receipt.date || todayStr(),
    items: receipt.items,
    isShared: true,
    paymentType: receiptPaymentType,
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

  let paymentLabel = '💳 共同カード（クレカ払）';
  if (receiptPaymentType === 'advanced_by_user') {
    paymentLabel = `👤 個人立替（${payer}立替・要精算）`;
  } else if (receiptPaymentType === 'shared_account') {
    paymentLabel = '🏦 共同口座振替（直接引落）';
  }

  const proxyBanner = isProxy ? `👥 代理入力中（支払者: ${payer}さん）\n━━━━━━━━━━━━━━\n` : '';
  const currentModeFooter = `\n━━━━━━━━━━━━━━\n（現在の設定: ${isProxy ? `👥 支払者: ${payer}さん ｜ ` : ''}支払方法: ${receiptPaymentType === 'advanced_by_user' ? '👤 個人立替' : (receiptPaymentType === 'shared_account' ? '🏦 口座振替' : '💳 共同カード')}）\n💡 切替:「立替モード」「共同カードモード」${isProxy ? ' ｜ 「代理解除」' : ''}`;

  const isRefundReceipt = receipt.isRefund || receipt.total < 0;
  const headerTitle = isRefundReceipt ? '💸 返金レシートを記録しました' : '🧾 レシートを自動記録しました！';
  const totalDisplay = isRefundReceipt
    ? `-¥${Math.abs(receipt.total).toLocaleString()}（返金計上）`
    : `¥${Math.abs(receipt.total).toLocaleString()}`;

  return waitNotice + proxyBanner + `${headerTitle}\n` +
    `━━━━━━━━━━━━━━\n` +
    `🏪 店名: ${receipt.store || '未設定'}\n` +
    `📅 日付: ${receipt.date}\n` +
    `💰 合計: ${totalDisplay}（明細 ${receipt.items.length}件）\n` +
    `💳 支払: ${paymentLabel}\n` +
    `━━━━━━━━━━━━━━\n` +
    itemsPreview + moreCount +
    autoCheckMsg + `\n\n` +
    `アプリの「履歴」タブに反映されました✨` +
    currentModeFooter;
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
    version: 'v2.17.0',
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


// ==========================================
// 口座預金＆クレカ明細・セキュリティ新機能ハンドラ (v2.12.0)
// ==========================================

/**
 * 口座配列の正規化・重複排除ヘルパー (v2.16.1: shared_savings 強制変換バグで増殖した重複口座をクリーンアップ)
 */
function sanitizeAndDedupeBankAccounts(rawAccounts, savingsConfig = null) {
  if (!Array.isArray(rawAccounts)) return getDefaultBankAccounts();

  const initSavings = Number(savingsConfig?.initialSavings || 0);
  const filtered = rawAccounts.filter(a =>
    a && !((a.id === 'acc_shared_main' && a.name && a.name.includes('三井住友')) ||
          (a.id === 'acc_shared_card' && a.name && a.name.includes('楽天カード')))
  );

  const normalized = filtered.map((acc, index) => {
    const id = acc.id || `acc_${Date.now()}_${index}`;
    const name = String(acc.name || '口座名未設定').trim();
    // 名前やIDから本来 shared_savings だった口座を復元
    const isSavingsByName = id === 'acc_shared_savings' || name.includes('別口座') || name.includes('繰越') || name.includes('貯金') || name.includes('貯蓄');
    let type = ['shared_bank', 'shared_savings', 'personal_bank', 'shared_card', 'personal_card'].includes(acc.type)
      ? acc.type
      : 'shared_bank';
    if (isSavingsByName && type === 'shared_bank') {
      type = 'shared_savings';
    }
    let balance = Number(acc.balance) || 0;
    if (type === 'shared_savings' && balance === 0 && initSavings > 0 && initSavings !== 161421) {
      balance = initSavings;
    }
    return {
      id,
      name,
      type,
      balance,
      institution: String(acc.institution || '').trim(),
      note: String(acc.note || '').trim(),
      updatedAt: acc.updatedAt || new Date().toISOString()
    };
  });

  // 重複排除:
  // - id が 'acc_shared_savings' または名前が「別口座貯金（余り繰越用）」の重複は残高が最大の1件に統合
  // - id が 'acc_shared_pair_bank' または名前が「ふたりの共有口座」の重複は残高が最大の1件に統合
  // - id が 'acc_shared_pair_card' または名前が「ふたりの共有カード」の重複は1件に統合
  const result = [];
  const seenKeys = new Map();

  for (const acc of normalized) {
    let dedupeKey = acc.id;
    if (acc.type === 'shared_savings' && (acc.id === 'acc_shared_savings' || acc.name.includes('別口座貯金'))) {
      dedupeKey = '__singleton_shared_savings__';
    } else if (acc.type === 'shared_bank' && (acc.id === 'acc_shared_pair_bank' || acc.name === 'ふたりの共有口座')) {
      dedupeKey = '__singleton_shared_pair_bank__';
    } else if (acc.type === 'shared_card' && (acc.id === 'acc_shared_pair_card' || acc.name === 'ふたりの共有カード')) {
      dedupeKey = '__singleton_shared_pair_card__';
    }

    if (seenKeys.has(dedupeKey)) {
      const existingIdx = seenKeys.get(dedupeKey);
      const existing = result[existingIdx];
      // 残高が大きい方（0円ではない方）を優先して残す
      if (Math.abs(Number(acc.balance) || 0) > Math.abs(Number(existing.balance) || 0)) {
        result[existingIdx] = {
          ...acc,
          id: dedupeKey === '__singleton_shared_savings__' ? 'acc_shared_savings' : existing.id
        };
      }
    } else {
      const fixedAcc = dedupeKey === '__singleton_shared_savings__'
        ? { ...acc, id: 'acc_shared_savings', type: 'shared_savings' }
        : acc;
      seenKeys.set(dedupeKey, result.length);
      result.push(fixedAcc);
    }
  }

  return result.length > 0 ? result : getDefaultBankAccounts();
}

/**
 * 口座リスト・残高の更新 (updateBankAccounts)
 */
async function handleUpdateBankAccounts(supabase, actor, data) {
  const pairId = getTargetPairId(actor, data);
  const accounts = Array.isArray(data.bankAccounts) ? data.bankAccounts : [];

  const sanitizedAccounts = sanitizeAndDedupeBankAccounts(accounts);

  await setAppSetting(supabase, pairId, 'bankAccounts', sanitizedAccounts);
  await writeAudit(supabase, actor, pairId, '更新', '口座残高ボード', 'bankAccounts', null, { count: sanitizedAccounts.length });

  return { success: true, bankAccounts: sanitizedAccounts };
}

/**
 * クレカ/銀行明細の一括取り込み (importCardStatements)
 */
async function handleImportCardStatements(supabase, actor, data) {
  const pairId = getTargetPairId(actor, data);
  const items = Array.isArray(data.items) ? data.items : [];

  if (items.length === 0) {
    return { success: false, error: '登録する明細がありません' };
  }

  const actorSlot = resolvePayerSlot(actor?.name) || 'husband';
  const defaultPayer = actorSlot === 'husband' ? '夫' : '妻';

  const rowsToInsert = items
    .map(item => {
      const rawDate = String(item.date || '').trim();
      let validDate = todayStr();
      const m = rawDate.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
      if (m) {
        validDate = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
      } else if (isValidDateStr(rawDate.slice(0, 10))) {
        validDate = rawDate.slice(0, 10);
      }

      const isDeposit = item.txType === 'deposit' || item.category === '口座入金' || item.category === '収入';
      const isCardTransfer = item.txType === 'card_transfer' || item.category === 'クレカ引落振替' || item.category === '振替';
      const amt = Math.abs(parseInt(String(item.amount).replace(/[,¥円\s]/g, ''), 10));
      const cleanTitle = String(item.title || (isDeposit ? '口座入金' : (isCardTransfer ? 'カード代金引落' : '明細インポート'))).trim().slice(0, 50) || '明細';
      const cleanCat = isDeposit ? '口座入金' : (isCardTransfer ? 'クレカ引落振替' : (String(item.category || '食費').trim().slice(0, 20) || 'その他'));
      const cleanMemo = String(item.memo || (isDeposit ? '銀行通帳入金' : (isCardTransfer ? '簿記相殺: クレカ引落' : 'クレカ/明細取込'))).trim().slice(0, 100);

      const pType = (isDeposit || isCardTransfer)
        ? 'shared_account'
        : (['shared_card', 'shared_account', 'advanced_by_user'].includes(item.paymentType)
          ? item.paymentType
          : 'shared_card');

      let payer = String(item.payer || '').trim();
      if (!payer) {
        payer = (isDeposit || isCardTransfer) ? '共同口座' : (pType === 'shared_card' ? '共同カード' : (pType === 'shared_account' ? '共同口座' : defaultPayer));
      }

      return {
        pair_id: pairId,
        date: validDate,
        title: cleanTitle,
        amount: amt,
        category_id: cleanCat,
        is_shared: item.isShared !== false,
        payment_type: pType,
        payer_id: payer,
        memo: cleanMemo,
        created_by: actor?.name || '明細インポート'
      };
    })
    .filter(row => row.amount > 0 && isValidDateStr(row.date));

  if (rowsToInsert.length === 0) {
    return { success: false, error: '登録可能な有効な明細（金額が1円以上）がありませんでした' };
  }

  const { data: inserted, error } = await supabase.from('transactions').insert(rowsToInsert).select();
  if (error) {
    console.error('明細一括インポートエラー:', error);
    return { success: false, error: '明細の保存に失敗しました: ' + error.message };
  }

  await writeAudit(supabase, actor, pairId, '一括取込', '取引', 'batch_import', null, { count: rowsToInsert.length });

  return { success: true, count: rowsToInsert.length, transactions: inserted || [] };
}

/**
 * 口座残高画面またはクレカ明細スクショのAI解析 (scanStatementOrBalance)
 */
async function handleScanStatementOrBalance(data, actor) {
  if (!actor || (!actor.allowed && !actor.verified && !isDemoAllowed())) {
    return { success: false, code: 'AUTH', error: '画像解析にはLINEログインとメンバー登録が必要です' };
  }
  const apiKey = normalizeEnvSecret(process.env.GEMINI_API_KEY);
  if (!apiKey) return { success: false, error: 'Vercelの環境変数 GEMINI_API_KEY が未設定です' };

  const mime = String(data.mimeType || 'image/jpeg');
  const b64 = String(data.imageBase64 || '');
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(mime)) {
    return { success: false, error: '対応していないファイル形式です（JPEG, PNG, WebP, PDFに対応）' };
  }
  if (!b64 || b64.length > 10000000) {
    return { success: false, error: 'ファイルが空、または大きすぎます' };
  }

  const prompt =
    'これは日本の銀行アプリの残高画面、通帳明細、またはクレジットカード利用明細のキャプチャ画像・PDF文書です。\n' +
    '画面や文書の内容を精緻に判別し、以下のJSON形式で出力してください。\n' +
    '【判別基準】\n' +
    '1. 通帳の預金残高や口座残高が大きく表示されている場合 -> screenType: "balance"\n' +
    '2. 利用履歴、支払明細、引落明細のリストが並んでいる場合 -> screenType: "statement"\n' +
    '3. 残高と直近明細の両方が含まれる場合 -> screenType: "both"\n' +
    '【出力JSONフォーマット】\n' +
    '{\n' +
    '  "screenType": "balance" または "statement" または "both",\n' +
    '  "balanceInfo": {\n' +
    '    "institution": "金融機関名またはカード会社名（不明なら空文字）",\n' +
    '    "accountName": "普通預金 または 口座名",\n' +
    '    "balance": 161421（残高の正の整数円。読み取れなければ null）\n' +
    '  },\n' +
    '  "detectedCard": "楽天カード / 三井住友カード / JCB等（推定できれば）",\n' +
    '  "statements": [\n' +
    '    {\n' +
    '      "date": "yyyy-MM-dd",\n' +
    '      "title": "利用店名・利用先・振込元",\n' +
    '      "amount": 3480（正の整数円）,\n' +
    '      "txType": "expense" または "deposit" または "card_transfer",\n' +
    '      "category": "食費 / 口座入金 / クレカ引落振替 / 日用品 / 光熱費 / 外食 / 交通費 / その他 から最適推定",\n' +
    '      "isShared": true\n' +
    '    }\n' +
    '  ]\n' +
    '}\n' +
    '必ず上記JSONのみを出力してください。';

  const requestBody = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0
    }
  };

  const availableModels = await getAvailableGeminiModels(apiKey);
  const customModel = normalizeEnvSecret(process.env.GEMINI_MODEL);
  let modelsToTry = customModel ? [customModel, ...availableModels.filter(m => m !== customModel)] : availableModels;

  let lastError = null;
  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(requestBody),
        signal: ctrl.signal
      });
      clearTimeout(timer);

      if (!res.ok) {
        lastError = new Error(`Gemini HTTP ${res.status}`);
        continue;
      }

      const json = await res.json();
      const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) continue;

      let parsed = null;
      try {
        parsed = JSON.parse(rawText);
      } catch (pe) {
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
      }

      if (parsed) {
        return {
          success: true,
          screenType: parsed.screenType || 'statement',
          balanceInfo: parsed.balanceInfo || null,
          detectedCard: parsed.detectedCard || '',
          statements: Array.isArray(parsed.statements) ? parsed.statements : []
        };
      }
    } catch (err) {
      lastError = err;
    }
  }

  return { success: false, error: '明細・残高画像の解析に失敗しました: ' + (lastError?.message || '不明なエラー') };
}

/**
 * セキュリティPINの更新 (updateSecurityPin)
 */
async function handleUpdateSecurityPin(supabase, actor, data) {
  const pairId = getTargetPairId(actor, data);
  const pin = String(data.pin || '').trim();

  if (!pin || pin.length < 4 || pin.length > 8) {
    return { success: false, error: 'PINは4〜8桁の数字で指定してください' };
  }

  // 暗号学的ソルト付きハッシュ化 (PBKDF2-HMAC-SHA256, 100,000回)
  const salt = generateSalt(16);
  const hashedPin = hashSecretWithSalt(pin, salt, PBKDF2_ITERATIONS);

  await setAppSetting(supabase, pairId, 'securityPinHash', hashedPin);
  await writeAudit(supabase, actor, pairId, '変更', 'セキュリティPIN', 'securityPin', null, { algorithm: 'PBKDF2-HMAC-SHA256', iterations: PBKDF2_ITERATIONS });

  return { success: true, message: 'セキュリティPINをソルト付きPBKDF2で安全に保存しました' };
}

/**
 * セキュリティPINの照合・検証 (verifySecurityPin)
 */
async function handleVerifySecurityPin(supabase, actor, data) {
  const pairId = getTargetPairId(actor, data);
  const pin = String(data.pin || '').trim();

  const storedHash = await getAppSetting(supabase, pairId, 'securityPinHash', null);
  if (!storedHash) {
    // PIN未設定の場合は常にOK
    return { success: true, isConfigured: false, isValid: true };
  }

  const isValid = verifySecretWithSalt(pin, storedHash);
  return { success: true, isConfigured: true, isValid };
}

/**
 * AI分析用 家計データベース一括抽出ファイル（Markdown / CSV）生成ヘルパー (v2.17.0)
 * - LINEのワンタイムトークン発行・ダウンロード、およびWeb画面からの即時抽出で共通利用
 */
async function buildAiAnalysisExportData(supabase, pairId, targetMonth = null) {
  const m = sanitizeMonth(targetMonth || currentMonthStr());
  const config = await getConfigData(supabase, pairId);
  const initData = await handleGetInitialData(supabase, m, { name: config.husbandName || 'メンバー1', verified: true, pairId }, pairId);

  const s = initData.summary || { budget: 240000, totalExpense: 0, remaining: 240000, dailyAllowance: 0, daysLeft: 0 };
  const txs = initData.transactions || [];
  const fixedList = initData.fixedExpenses || [];
  const monthlyTotals = initData.monthlyTotals || [];
  const receiptItems = initData.receiptItems || [];
  const bankAccounts = sanitizeAndDedupeBankAccounts(config.bankAccounts || getDefaultBankAccounts(), config.savingsConfig);

  const nonExpenseCats = ['口座入金', '収入', 'クレカ引落振替', '振替'];
  const expenseTxs = txs.filter(t => t.isShared !== false && !nonExpenseCats.includes(t.category) && Number(t.amount) > 0);
  const incomeTxs = txs.filter(t => t.category === '口座入金' || t.category === '収入' || Number(t.amount) < 0);

  // 口座残高集計
  const livingBankBal = bankAccounts.filter(a => a.type === 'shared_bank').reduce((sum, a) => sum + (Number(a.balance) || 0), 0);
  const sepSavingsAccBal = bankAccounts.filter(a => a.type === 'shared_savings').reduce((sum, a) => sum + (Number(a.balance) || 0), 0);
  const separateSavingsBal = sepSavingsAccBal > 0 ? sepSavingsAccBal : Number(config.savingsConfig?.initialSavings || 0);
  const totalAssets = livingBankBal + separateSavingsBal;

  // レシート枚数集計
  const receiptIds = new Set();
  let manualReceipts = 0;
  expenseTxs.forEach(t => {
    if (t.receiptId) receiptIds.add(String(t.receiptId));
    else if (!String(t.memo || '').includes('明細取込')) manualReceipts += 1;
  });
  const totalReceiptCount = receiptIds.size + manualReceipts;

  // カテゴリ別集計 ＆ 部門予算対比
  const catMap = {};
  expenseTxs.forEach(t => {
    const c = t.category || '未分類';
    if (!catMap[c]) catMap[c] = { amount: 0, count: 0 };
    catMap[c].amount += Number(t.amount || 0);
    catMap[c].count += 1;
  });
  const catBudgets = (config.categoryBudgetsByMonth && config.categoryBudgetsByMonth[m]) || config.categoryBudgets || {};
  const sortedCats = Object.entries(catMap).sort((a, b) => b[1].amount - a[1].amount);

  // 店舗・支払先別ランキング（上位15件：無駄遣い・高頻度支出の発見用）
  const storeMap = {};
  expenseTxs.forEach(t => {
    const name = String(t.title || '不明').trim();
    if (!storeMap[name]) storeMap[name] = { amount: 0, count: 0, category: t.category || '未分類' };
    storeMap[name].amount += Number(t.amount || 0);
    storeMap[name].count += 1;
  });
  const topStores = Object.entries(storeMap).sort((a, b) => b[1].amount - a[1].amount).slice(0, 15);

  // 1. AI（ChatGPT / Claude / Gemini）にそのまま渡せる構造化Markdownレポート
  let md = `# 📊 ふたり家計簿 AI家計診断・無駄遣い分析用データセット (${m})\n\n`;
  md += `> **🤖 AIへの分析プロンプト（このままAIに貼り付けるか、ファイルを添付して送信してください）**\n`;
  md += `> あなたはプロのファイナンシャルプランナー（FP）兼 家計改善アドバイザーです。以下の「ふたり家計簿」のデータベース抽出データをもとに、次の4点を具体的かつ辛口・親切に診断してください。\n`;
  md += `> 1. **上手にお金を使えている点（褒めるべきポイント・黒字/貯蓄ペースの評価）**\n`;
  md += `> 2. **無駄遣い・使いすぎの可能性がある要注意ポイント（特定店舗・カテゴリ・頻度・固定費の偏り）**\n`;
  md += `> 3. **月間予算（¥${Number(s.budget || 0).toLocaleString()}）および口座残高（①生活費口座 / ②別口座貯金）に対するキャッシュフロー健全性**\n`;
  md += `> 4. **来月から無理なく毎月あと1〜3万円貯蓄を増やせる具体的なアクションプラン3つ**\n\n`;

  md += `---\n\n`;
  md += `## 1. 当月（${m}）の家計サマリー ＆ 口座残高\n`;
  md += `- **生活費月間予算**: ¥${Number(s.budget || 0).toLocaleString()}\n`;
  md += `- **今月使ったお金（共同生活費支出合計）**: ¥${Number(s.totalExpense || 0).toLocaleString()}（予算消化率 ${s.progressRate || 0}%）\n`;
  md += `- **生活費予算 残金**: ¥${Number(s.remaining || 0).toLocaleString()}（1日あたり使える目安: ¥${Number(s.dailyAllowance || 0).toLocaleString()}/日・残り${s.daysLeft || 0}日）\n`;
  md += `- **レシート登録枚数**: ${totalReceiptCount}枚（支出明細総数: ${expenseTxs.length}件）\n`;
  md += `- **共同口座・別口座貯金 合計残高**: ¥${totalAssets.toLocaleString()}\n`;
  md += `  - ① 普段の生活費口座: ¥${livingBankBal.toLocaleString()}\n`;
  md += `  - ② 別口座貯金（余り繰越分）: ¥${separateSavingsBal.toLocaleString()}\n`;
  md += `- **ふたりの基本拠出額設定**: ${config.husbandName || 'メンバー1'} ¥${Number(config.husbandBaseContribution || 60000).toLocaleString()} / ${config.wifeName || 'メンバー2'} ¥${Number(config.wifeBaseContribution || 60000).toLocaleString()}\n\n`;

  md += `## 2. カテゴリ別支出内訳 ＆ 部門予算との比較\n`;
  md += `| カテゴリ | 支出合計 | 件数 | 構成比 | 部門予算 | 予算比 |\n`;
  md += `| :--- | ---: | ---: | ---: | ---: | :--- |\n`;
  sortedCats.forEach(([catName, info]) => {
    const ratio = s.totalExpense > 0 ? Math.round((info.amount / s.totalExpense) * 100) : 0;
    const cBudget = Number(catBudgets[catName] || 0);
    const budgetDiffStr = cBudget > 0
      ? (info.amount > cBudget ? `⚠️ +¥${(info.amount - cBudget).toLocaleString()} 超過` : `✅ 残¥${(cBudget - info.amount).toLocaleString()}`)
      : '-';
    md += `| ${catName} | ¥${info.amount.toLocaleString()} | ${info.count}件 | ${ratio}% | ${cBudget > 0 ? `¥${cBudget.toLocaleString()}` : '未設定'} | ${budgetDiffStr} |\n`;
  });
  md += `\n`;

  md += `## 3. 支出先・店舗別ランキング TOP15（頻度・金額分析用）\n`;
  md += `| 順位 | 店舗・内容 | カテゴリ | 利用回数 | 合計金額 | 1回あたり平均 |\n`;
  md += `| ---: | :--- | :--- | ---: | ---: | ---: |\n`;
  topStores.forEach(([storeName, info], idx) => {
    const avg = info.count > 0 ? Math.round(info.amount / info.count) : 0;
    md += `| ${idx + 1} | ${storeName} | ${info.category} | ${info.count}回 | ¥${info.amount.toLocaleString()} | ¥${avg.toLocaleString()} |\n`;
  });
  md += `\n`;

  md += `## 4. 登録済み固定費マスタ一覧\n`;
  if (fixedList.length === 0) {
    md += `- 登録されている固定費はありません\n\n`;
  } else {
    md += `| 固定費名 | カテゴリ | 金額 | 引落日 | 支払方法 | 状態 |\n`;
    md += `| :--- | :--- | ---: | :--- | :--- | :--- |\n`;
    fixedList.forEach(f => {
      md += `| ${f.title} | ${f.category} | ¥${Number(f.amount || 0).toLocaleString()} | 毎月${f.billingDay}日 | ${f.paymentType === 'shared_card' ? '共同カード' : '共同口座振替'} | ${f.isActive !== false ? '有効' : '停止中'} |\n`;
    });
    md += `\n`;
  }

  md += `## 5. 過去月別の支出推移（直近12ヶ月）\n`;
  md += `| 年月 | 共同生活費支出 | 月間予算 | 月次収支（予算−支出） |\n`;
  md += `| :--- | ---: | ---: | ---: |\n`;
  monthlyTotals.slice(-12).forEach(mt => {
    const mBudget = Number(mt.budget || 240000);
    const mShared = Number(mt.shared || 0);
    const mDiff = mBudget - mShared;
    md += `| ${mt.month} | ¥${mShared.toLocaleString()} | ¥${mBudget.toLocaleString()} | ${mDiff >= 0 ? `+¥${mDiff.toLocaleString()}` : `-¥${Math.abs(mDiff).toLocaleString()}`} |\n`;
  });
  md += `\n`;

  md += `## 6. 当月（${m}）の全取引明細データ（全${txs.length}件）\n`;
  md += `| 日付 | 内容・店舗名 | カテゴリ | 金額 | 種別 | 支払方法 | 支払者 | メモ |\n`;
  md += `| :--- | :--- | :--- | ---: | :--- | :--- | :--- | :--- |\n`;
  txs.forEach(t => {
    const scopeStr = t.isShared !== false ? '家族(共有)' : '個人(私物)';
    const payStr = t.paymentType === 'shared_card' ? '共同カード' : (t.paymentType === 'shared_account' ? '共同口座' : '個人立替');
    md += `| ${t.date} | ${String(t.title || '').replace(/\|/g, '｜')} | ${t.category || ''} | ¥${Number(t.amount || 0).toLocaleString()} | ${scopeStr} | ${payStr} | ${t.payer || ''} | ${String(t.memo || '').replace(/\|/g, '｜')} |\n`;
  });

  if (receiptItems.length > 0) {
    md += `\n## 7. レシート購入品目データ（直近${Math.min(100, receiptItems.length)}品目）\n`;
    md += `| 品名 | 数量 | 単価 | 金額 |\n`;
    md += `| :--- | ---: | ---: | ---: |\n`;
    receiptItems.slice(0, 100).forEach(it => {
      md += `| ${String(it.name || '').replace(/\|/g, '｜')} | ${it.quantity || 1} | ¥${Number(it.unitPrice || it.price || 0).toLocaleString()} | ¥${Number(it.price || 0).toLocaleString()} |\n`;
    });
  }

  // 2. CSV形式（Excel / Python / ChatGPT Advanced Data Analysis 用）
  const csvRows = [
    ['日付', '内容・店舗名', 'カテゴリ', '金額', '家族/個人', '支払方法', '支払者', 'レシートID', 'メモ']
  ];
  txs.forEach(t => {
    const scopeStr = t.isShared !== false ? '家族(共有)' : '個人(私物)';
    const payStr = t.paymentType === 'shared_card' ? '共同カード' : (t.paymentType === 'shared_account' ? '共同口座' : '個人立替');
    csvRows.push([
      t.date || '',
      t.title || '',
      t.category || '',
      String(Number(t.amount || 0)),
      scopeStr,
      payStr,
      t.payer || '',
      t.receiptId || '',
      t.memo || ''
    ]);
  });
  const csvContent = '\uFEFF' + csvRows.map(row =>
    row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\r\n');

  return {
    month: m,
    markdown: md,
    csv: csvContent,
    summary: {
      budget: s.budget,
      totalExpense: s.totalExpense,
      remaining: s.remaining,
      totalAssets,
      livingBankBal,
      separateSavingsBal,
      totalReceiptCount,
      txCount: txs.length
    }
  };
}

/**
 * LINE等から安全にAI分析用ファイルをダウンロードするためのワンタイムトークン発行 (v2.17.0)
 */
async function createAiExportDownloadToken(supabase, pairId, monthStr) {
  const token = crypto.randomBytes(24).toString('hex');
  const record = {
    token,
    pairId,
    month: sanitizeMonth(monthStr || currentMonthStr()),
    expiresAt: Date.now() + 30 * 60 * 1000 // 30分間有効
  };
  await setAppSetting(supabase, pairId, `aiExportToken_${token}`, record);
  return record;
}

/**
 * ソルト付きハッシュのシミュレーション・体験API (testSaltedHash)
 */
async function handleTestSaltedHash(data, actor) {
  const input = String(data.input || 'sample_secret_pin_1234');
  const t0 = Date.now();

  // 1回目のソルト付きハッシュ生成
  const salt1 = generateSalt(16);
  const hashRecord1 = hashSecretWithSalt(input, salt1, PBKDF2_ITERATIONS);

  // 2回目のソルト付きハッシュ生成（同じ入力なのに全く異なるハッシュになることを証明）
  const salt2 = generateSalt(16);
  const hashRecord2 = hashSecretWithSalt(input, salt2, PBKDF2_ITERATIONS);

  const durationMs = Date.now() - t0;

  return {
    success: true,
    input: input,
    algorithm: 'PBKDF2-HMAC-SHA256',
    iterations: PBKDF2_ITERATIONS,
    saltLengthBits: 128,
    durationMs: durationMs,
    sample1: {
      salt: salt1,
      hashRecord: hashRecord1
    },
    sample2: {
      salt: salt2,
      hashRecord: hashRecord2
    },
    explanation: '同一の入力であっても、毎回生成される128bitランダムソルトによりハッシュ値が完全に異なります。これによりレインボーテーブル辞書攻撃を100%無力化します。'
  };
}

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

  // 1. GET リクエスト（初期データ取得・イベント一覧・AI分析ファイルダウンロード等）
  if (req.method === 'GET') {
    try {
      const action = req.query.action || 'getInitialData';

      // 1-A. LINE経由のワンタイムトークン付きAI分析ファイルダウンロード (v2.17.0)
      if (action === 'downloadAiExport') {
        const exportToken = String(req.query.exportToken || '').trim();
        const format = String(req.query.format || 'md').toLowerCase();
        const requestedPairIdForExport = sanitizePairId(req.query.pairId || DEFAULT_PAIR_ID);

        let validPairId = null;
        let targetMonth = req.query.month || currentMonthStr();

        if (exportToken && /^[0-9a-f]{48}$/i.test(exportToken)) {
          const savedRecord = await getAppSetting(supabase, requestedPairIdForExport, `aiExportToken_${exportToken}`, null);
          if (savedRecord && savedRecord.token === exportToken && Number(savedRecord.expiresAt) > Date.now()) {
            validPairId = savedRecord.pairId || requestedPairIdForExport;
            targetMonth = req.query.month || savedRecord.month || currentMonthStr();
          }
        }

        // トークンがない場合は通常のLINE IDトークン検証で許可
        if (!validPairId) {
          const qToken = req.query.idToken || req.query.token;
          if (qToken) {
            const vActor = await resolveActor(qToken, supabase, requestedPairIdForExport);
            if (vActor && vActor.allowed && vActor.verified) {
              validPairId = vActor.pairId;
            }
          }
        }

        if (!validPairId) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          return res.status(403).send('🔒 ダウンロードリンクの有効期限（30分）が切れているか、権限がありません。LINEで再度「AI分析ファイル」と送信して新しいリンクを発行してください。');
        }

        const exportData = await buildAiAnalysisExportData(supabase, validPairId, targetMonth);
        if (format === 'csv') {
          const fileName = `futari-kakeibo-ai-data-${exportData.month}.csv`;
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
          return res.status(200).send(exportData.csv);
        } else {
          const fileName = `futari-kakeibo-ai-analysis-${exportData.month}.md`;
          res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
          return res.status(200).send(exportData.markdown);
        }
      }

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
        } else if (verifiedActor.code === 'UNAUTHORIZED_LINE_USER' || !isDemoAllowed()) {
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
          version: 'v2.17.0',
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
        case 'updateBankAccounts':
          result = await handleUpdateBankAccounts(supabase, actor, data);
          break;
        case 'importCardStatements':
          result = await handleImportCardStatements(supabase, actor, data);
          break;
        case 'scanStatementOrBalance':
          result = await handleScanStatementOrBalance(data, actor);
          break;
        case 'updateSecurityPin':
          result = await handleUpdateSecurityPin(supabase, actor, data);
          break;
        case 'verifySecurityPin':
          result = await handleVerifySecurityPin(supabase, actor, data);
          break;
        case 'exportAiAnalysisData':
          const expData = await buildAiAnalysisExportData(supabase, requestedPairId || actor.pairId, data.month);
          result = { success: true, ...expData };
          break;
        case 'testSaltedHash':
          result = await handleTestSaltedHash(data, actor);
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
