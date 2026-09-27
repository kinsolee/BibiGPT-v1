-- KIN-47: 统一导出与集成管线（自用版）
-- 设计要点：
--   * export_integrations 按 (user_id, provider) 唯一；webhook URL / API secret 以
--     AES-256-GCM 密文存 secret_encrypted，明文永不出服务端。notion/feishu_doc 凭据走 env，不落库。
--   * export_deliveries 每次投递尝试落一行（含重试），保留完整尝试历史；错误消息先脱敏再入库。
--   * export_audit_logs 仅追加（只授予 select/insert），content_id 不加外键，内容删除后审计仍留存。
--   * 迁移可重复执行：DDL 全部 IF NOT EXISTS，策略先 DROP 再 CREATE。

-- ============================================================ export_integrations
create table if not exists public.export_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  provider text not null check (provider in ('flomo', 'lark_webhook', 'notion', 'feishu_doc', 'ima', 'email')),
  display_name text,
  config jsonb not null default '{}'::jsonb,
  secret_encrypted text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint export_integrations_user_provider_unique unique nulls not distinct (user_id, provider)
);

-- ============================================================ export_deliveries
create table if not exists public.export_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  integration_id uuid references public.export_integrations (id) on delete set null,
  content_id uuid not null references public.contents (id) on delete cascade,
  provider text not null check (provider in ('flomo', 'lark_webhook', 'notion', 'feishu_doc', 'ima', 'email')),
  status text not null check (status in ('succeeded', 'failed')),
  attempts int not null default 1,
  last_error_code text,
  last_error_message text,
  external_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================ export_audit_logs
create table if not exists public.export_audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  action text not null,
  content_id uuid,
  provider text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================ indexes
create index if not exists export_integrations_user_idx on public.export_integrations (user_id);
create index if not exists export_deliveries_user_created_idx on public.export_deliveries (user_id, created_at desc);
create index if not exists export_deliveries_content_idx on public.export_deliveries (content_id);
create index if not exists export_audit_logs_user_created_idx on public.export_audit_logs (user_id, created_at desc);

-- ============================================================ grants
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.export_integrations to authenticated;
grant select, insert, update, delete on public.export_deliveries to authenticated;
grant select, insert on public.export_audit_logs to authenticated;

-- ============================================================ RLS
alter table public.export_integrations enable row level security;
alter table public.export_deliveries enable row level security;
alter table public.export_audit_logs enable row level security;

-- 与 KIN-41/43 同一口径：登录用户只能读写自己的行；deliveries 必须校验内容归属同一用户。
drop policy if exists "export_integrations_owner_all" on public.export_integrations;
create policy "export_integrations_owner_all" on public.export_integrations for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "export_deliveries_owner_all" on public.export_deliveries;
create policy "export_deliveries_owner_all" on public.export_deliveries for all to authenticated
  using (
    auth.uid() = user_id
    and exists (select 1 from public.contents c where c.id = export_deliveries.content_id and c.user_id = auth.uid())
  )
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.contents c where c.id = export_deliveries.content_id and c.user_id = auth.uid())
  );

drop policy if exists "export_audit_logs_owner_select" on public.export_audit_logs;
create policy "export_audit_logs_owner_select" on public.export_audit_logs for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "export_audit_logs_owner_insert" on public.export_audit_logs;
create policy "export_audit_logs_owner_insert" on public.export_audit_logs for insert to authenticated
  with check (auth.uid() = user_id);
