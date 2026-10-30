-- ==============================================================================
-- ふたり家計簿 (PairBudget) Supabase PostgreSQL スキーマ
-- マルチペア対応（世帯分離）＆ 臨時イベント精算（30日TTLパージ）
-- ==============================================================================

-- 拡張機能の有効化
create extension if not exists "pgcrypto";

-- ==============================================================================
-- 1. ペア管理（世帯完全分離） (pairs)
-- ==============================================================================
create table if not exists pairs (
    id uuid primary key default gen_random_uuid(),
    name text not null default 'ふたりの家計簿',
    invite_code text unique not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

comment on table pairs is '家計簿を共有する世帯（ペア）管理テーブル';
comment on column pairs.invite_code is 'パートナー合流用のユニーク招待コード（6〜8桁英数）';

-- デフォルトペア（初期データおよび後方互換用）
insert into pairs (id, name, invite_code) values
    ('00000000-0000-0000-0000-000000000001', '公式デモ・メイン世帯', 'PAIR2026')
on conflict (id) do nothing;

-- ==============================================================================
-- 2. ユーザー管理 (users)
-- ==============================================================================
create table if not exists users (
    id uuid primary key default gen_random_uuid(),
    pair_id uuid not null default '00000000-0000-0000-0000-000000000001' references pairs(id) on delete cascade,
    line_user_id text unique not null,
    slot text not null check (slot in ('husband', 'wife', 'slot1', 'slot2')),
    display_name text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

comment on table users is '家計簿共有メンバー（各ペア2枠限定: husband/wife または slot1/slot2）';
comment on column users.pair_id is '所属する世帯ペアID';
comment on column users.line_user_id is 'LINEユーザーID（U始まりの英数字）';
comment on column users.slot is 'スロット識別子（husband: メンバー1, wife: メンバー2）';
comment on column users.display_name is 'アプリ上の表示名（例: 夫, 妻, ニックネーム）';

-- ==============================================================================
-- 3. カテゴリマスタ (categories)
-- ==============================================================================
create table if not exists categories (
    id text primary key,
    name text not null,
    color text not null default '#6B7280',
    icon text not null default 'tag',
    sort_order integer not null default 0,
    created_at timestamptz not null default now()
);

comment on table categories is '支出カテゴリマスタ（共通）';

-- ==============================================================================
-- 4. 仕分けルールマスタ (rules)
-- ==============================================================================
create table if not exists rules (
    id uuid primary key default gen_random_uuid(),
    pair_id uuid not null default '00000000-0000-0000-0000-000000000001' references pairs(id) on delete cascade,
    keyword text not null,
    category_id text not null references categories(id) on update cascade on delete cascade,
    created_at timestamptz not null default now(),
    unique (pair_id, keyword)
);

comment on table rules is '品名キーワードからカテゴリを自動推測するルール（ペア別）';

-- ==============================================================================
-- 5. レシートヘッダ (receipts)
-- ==============================================================================
create table if not exists receipts (
    id uuid primary key default gen_random_uuid(),
    pair_id uuid not null default '00000000-0000-0000-0000-000000000001' references pairs(id) on delete cascade,
    date date not null,
    store_name text not null,
    total_amount numeric not null,
    scanned_by text not null,
    image_url text,
    created_at timestamptz not null default now()
);

comment on table receipts is 'AIレシートOCR読み取り親データ';

-- ==============================================================================
-- 6. レシート明細 (receipt_items)
-- ==============================================================================
create table if not exists receipt_items (
    id uuid primary key default gen_random_uuid(),
    receipt_id uuid not null references receipts(id) on delete cascade,
    item_name text not null,
    normalized_name text not null,
    quantity numeric not null default 1,
    price numeric not null,
    unit_price numeric not null default 0,
    category_id text references categories(id) on update cascade on delete set null,
    created_at timestamptz not null default now()
);

comment on table receipt_items is 'レシート内の個別品名明細（価格履歴検索用）';
comment on column receipt_items.normalized_name is '全角半角正規化・カタカナ統一済みの検索用品名';

-- ==============================================================================
-- 7. 支出トランザクション (transactions)
-- ==============================================================================
create table if not exists transactions (
    id uuid primary key default gen_random_uuid(),
    pair_id uuid not null default '00000000-0000-0000-0000-000000000001' references pairs(id) on delete cascade,
    date date not null,
    title text not null,
    amount numeric not null,
    category_id text not null default 'その他',
    is_shared boolean not null default true,
    payment_type text not null default 'shared_card',
    payer_id text not null,
    memo text not null default '',
    receipt_id uuid references receipts(id) on delete set null,
    is_private boolean not null default false,
    created_by text not null default '',
    created_at timestamptz not null default now(),
    updated_by text not null default '',
    updated_at timestamptz not null default now()
);

comment on table transactions is '日々の支出レコード（ペア別完全分離）';
comment on column transactions.payment_type is '決済手段 (shared_card: 共同カード/口座, personal_advance: 個人立替, personal_self: 個人自腹)';
comment on column transactions.payer_id is '支払者スロットまたは表示名';

-- ==============================================================================
-- 8. 買い物リスト (shopping_list)
-- ==============================================================================
create table if not exists shopping_list (
    id uuid primary key default gen_random_uuid(),
    pair_id uuid not null default '00000000-0000-0000-0000-000000000001' references pairs(id) on delete cascade,
    title text not null,
    category_id text default '日用品',
    is_completed boolean not null default false,
    requested_by text not null default '',
    created_at timestamptz not null default now(),
    completed_at timestamptz
);

comment on table shopping_list is 'ふたりで共有する買い物リスト';

-- ==============================================================================
-- 9. 固定費 (fixed_expenses)
-- ==============================================================================
create table if not exists fixed_expenses (
    id uuid primary key default gen_random_uuid(),
    pair_id uuid not null default '00000000-0000-0000-0000-000000000001' references pairs(id) on delete cascade,
    title text not null,
    amount numeric not null,
    category_id text not null default 'その他',
    billing_day integer not null default 1 check (billing_day >= 1 and billing_day <= 31),
    is_active boolean not null default true,
    payment_type text not null default 'shared_card',
    payer text not null default '共同カード',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

comment on table fixed_expenses is '毎月の固定費マスタ（家賃、水道光熱費等）';

-- ==============================================================================
-- 10. 月次予算と精算ステータス (monthly_budgets)
-- ==============================================================================
create table if not exists monthly_budgets (
    id uuid primary key default gen_random_uuid(),
    pair_id uuid not null default '00000000-0000-0000-0000-000000000001' references pairs(id) on delete cascade,
    month text not null check (month ~ '^\d{4}-\d{2}$'),
    budget_amount numeric not null default 240000,
    base_contribution_user1 numeric not null default 60000,
    base_contribution_user2 numeric not null default 60000,
    transfer_status_user1 boolean not null default false,
    transfer_status_user2 boolean not null default false,
    note text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (pair_id, month)
);

comment on table monthly_budgets is '月次予算および各メンバーの振込完了状態（ペア別）';

-- ==============================================================================
-- 11. 監査ログ (audit_logs)
-- ==============================================================================
create table if not exists audit_logs (
    id uuid primary key default gen_random_uuid(),
    pair_id uuid not null default '00000000-0000-0000-0000-000000000001' references pairs(id) on delete cascade,
    timestamp timestamptz not null default now(),
    actor_id text not null,
    action text not null,
    target_type text not null,
    target_id text,
    before_data jsonb,
    after_data jsonb
);

comment on table audit_logs is '全変更操作の追跡・監査ログ';

-- ==============================================================================
-- 12. アプリ設定 (app_settings)
-- ==============================================================================
create table if not exists app_settings (
    pair_id uuid not null default '00000000-0000-0000-0000-000000000001' references pairs(id) on delete cascade,
    key text not null,
    value text not null,
    updated_at timestamptz not null default now(),
    primary key (pair_id, key)
);

comment on table app_settings is '世帯ペアごとの設定値キーバリューストア';

-- ==============================================================================
-- 13. 臨時お金管理・旅行イベント (events)
-- ==============================================================================
create table if not exists events (
    id uuid primary key default gen_random_uuid(),
    pair_id uuid not null default '00000000-0000-0000-0000-000000000001' references pairs(id) on delete cascade,
    title text not null,
    members jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '30 days')
);

comment on table events is '旅行・BBQ等の臨時精算イベント（30日間TTL自動パージ）';
comment on column events.members is '参加者名リスト (例: ["自分", "パートナー", "友人A"])';
comment on column events.expires_at is '自動削除予定日時（作成から30日後）';

-- ==============================================================================
-- 14. イベント支出明細 (event_expenses)
-- ==============================================================================
create table if not exists event_expenses (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references events(id) on delete cascade,
    title text not null,
    amount numeric not null,
    payer text not null,
    beneficiaries jsonb,
    created_at timestamptz not null default now()
);

comment on table event_expenses is 'イベント内の個別立替支出';
comment on column event_expenses.beneficiaries is '割り勘対象者リスト（null/空の場合はイベント全参加者で均等割り）';

-- ==============================================================================
-- 30日TTL自動パージ用ストアドプロシージャ
-- ==============================================================================
create or replace function purge_expired_events() returns integer as $$
declare
    deleted_count integer;
begin
    delete from events where expires_at < now();
    get diagnostics deleted_count = row_count;
    return deleted_count;
end;
$$ language plpgsql security definer;

comment on function purge_expired_events is '有効期限（30日）を過ぎたイベントおよび関連支出を完全パージ';

-- ==============================================================================
-- インデックス作成
-- ==============================================================================
create index if not exists idx_pairs_invite_code on pairs(invite_code);
create index if not exists idx_users_pair_id on users(pair_id);
create index if not exists idx_transactions_pair_date on transactions(pair_id, date desc);
create index if not exists idx_transactions_receipt_id on transactions(receipt_id);
create index if not exists idx_transactions_payer_id on transactions(payer_id);
create index if not exists idx_receipts_pair_id on receipts(pair_id);
create index if not exists idx_receipt_items_receipt_id on receipt_items(receipt_id);
create index if not exists idx_receipt_items_norm_name on receipt_items(normalized_name);
create index if not exists idx_audit_logs_pair_time on audit_logs(pair_id, timestamp desc);
create index if not exists idx_shopping_list_pair on shopping_list(pair_id, is_completed, created_at desc);
create index if not exists idx_events_expires_at on events(expires_at);
create index if not exists idx_events_pair_id on events(pair_id);
create index if not exists idx_event_expenses_event_id on event_expenses(event_id);

-- ==============================================================================
-- 行レベルセキュリティ (RLS) の設定
-- ==============================================================================
-- 外部（anon / public キー）からの直接読み書き・情報漏洩を完全に遮断し、
-- バックエンドのサービスロールキー経由のアクセスのみ許可。

alter table pairs enable row level security;
alter table users enable row level security;
alter table categories enable row level security;
alter table rules enable row level security;
alter table receipts enable row level security;
alter table receipt_items enable row level security;
alter table transactions enable row level security;
alter table shopping_list enable row level security;
alter table fixed_expenses enable row level security;
alter table monthly_budgets enable row level security;
alter table audit_logs enable row level security;
alter table app_settings enable row level security;
alter table events enable row level security;
alter table event_expenses enable row level security;

-- サービスロールに対する全権限ポリシー（anon/publicからの直接アクセスは完全遮断）
create policy "Service role full access on pairs" on pairs for all to service_role using (true) with check (true);
create policy "Service role full access on users" on users for all to service_role using (true) with check (true);
create policy "Service role full access on categories" on categories for all to service_role using (true) with check (true);
create policy "Service role full access on rules" on rules for all to service_role using (true) with check (true);
create policy "Service role full access on receipts" on receipts for all to service_role using (true) with check (true);
create policy "Service role full access on receipt_items" on receipt_items for all to service_role using (true) with check (true);
create policy "Service role full access on transactions" on transactions for all to service_role using (true) with check (true);
create policy "Service role full access on shopping_list" on shopping_list for all to service_role using (true) with check (true);
create policy "Service role full access on fixed_expenses" on fixed_expenses for all to service_role using (true) with check (true);
create policy "Service role full access on monthly_budgets" on monthly_budgets for all to service_role using (true) with check (true);
create policy "Service role full access on audit_logs" on audit_logs for all to service_role using (true) with check (true);
create policy "Service role full access on app_settings" on app_settings for all to service_role using (true) with check (true);
create policy "Service role full access on events" on events for all to service_role using (true) with check (true);
create policy "Service role full access on event_expenses" on event_expenses for all to service_role using (true) with check (true);

-- ==============================================================================
-- 初期シードデータ投入
-- ==============================================================================

-- カテゴリ初期データ
insert into categories (id, name, color, icon, sort_order) values
    ('食費', '食費', '#10B981', 'utensils', 10),
    ('日用品', '日用品', '#3B82F6', 'shopping-bag', 20),
    ('外食', '外食', '#F59E0B', 'coffee', 30),
    ('住居費', '住居費', '#6366F1', 'home', 40),
    ('水道光熱費', '水道光熱費', '#06B6D4', 'zap', 50),
    ('通信費', '通信費', '#8B5CF6', 'wifi', 60),
    ('趣味・衣服', '趣味・衣服', '#EC4899', 'heart', 70),
    ('その他', 'その他', '#6B7280', 'more-horizontal', 80)
on conflict (id) do update set
    name = excluded.name,
    color = excluded.color,
    icon = excluded.icon,
    sort_order = excluded.sort_order;

-- デフォルトペア用仕分けルール
insert into rules (pair_id, keyword, category_id) values
    ('00000000-0000-0000-0000-000000000001', 'イオン', '食費'),
    ('00000000-0000-0000-0000-000000000001', 'ライフ', '食費'),
    ('00000000-0000-0000-0000-000000000001', '西友', '食費'),
    ('00000000-0000-0000-0000-000000000001', 'サミット', '食費'),
    ('00000000-0000-0000-0000-000000000001', 'マツモトキヨシ', '日用品'),
    ('00000000-0000-0000-0000-000000000001', 'ウエルシア', '日用品'),
    ('00000000-0000-0000-0000-000000000001', 'スギ薬局', '日用品'),
    ('00000000-0000-0000-0000-000000000001', 'ドラッグ', '日用品'),
    ('00000000-0000-0000-0000-000000000001', 'スターバックス', '外食'),
    ('00000000-0000-0000-0000-000000000001', 'カフェ', '外食')
on conflict (pair_id, keyword) do nothing;

-- デフォルトペア用固定費
insert into fixed_expenses (pair_id, title, amount, category_id, billing_day, is_active, payment_type, payer) values
    ('00000000-0000-0000-0000-000000000001', '家賃', 110000, '住居費', 27, true, 'shared_card', '共同カード'),
    ('00000000-0000-0000-0000-000000000001', '水道光熱費 (概算)', 15000, '水道光熱費', 20, true, 'shared_card', '共同カード'),
    ('00000000-0000-0000-0000-000000000001', 'ネット光回線', 5200, '通信費', 15, true, 'shared_card', '共同カード')
on conflict do nothing;

-- デフォルトペア用設定
insert into app_settings (pair_id, key, value) values
    ('00000000-0000-0000-0000-000000000001', 'husbandName', 'メンバー1'),
    ('00000000-0000-0000-0000-000000000001', 'wifeName', 'メンバー2'),
    ('00000000-0000-0000-0000-000000000001', 'husbandBaseContribution', '60000'),
    ('00000000-0000-0000-0000-000000000001', 'wifeBaseContribution', '60000')
on conflict (pair_id, key) do nothing;
