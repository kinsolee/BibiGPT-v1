-- KIN-49: v1 公开 API 的 api_tokens 模型（自用版）
-- 设计要点：
--   * 单用户自用：token 由管理端点（BIBI_V1_ADMIN_TOKEN 鉴权）创建，必须绑定一个 auth.users id，
--     v1 端点的所有业务查询都按该 user_id 显式隔离。
--   * 只存 sha256(token) 哈希，明文 token 仅在创建响应里返回一次；scope ∈ {read, write}，可撤销。
--   * v1 端点用 service role client 访问本表做哈希查找（service role 绕过 RLS）；
--     面向登录用户的常规访问仍走 RLS（owner 才能读写自己的 token 行）。
--   * 不涉及任何支付/额度/credit 字段，不返回 quota/upgrade。

create extension if not exists pgcrypto;

create table if not exists public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique,
  name text not null default '',
  scope text not null check (scope in ('read', 'write')),
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists api_tokens_user_idx on public.api_tokens (user_id);

-- ============================================================ grants
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- ============================================================ RLS
alter table public.api_tokens enable row level security;
drop policy if exists "api_tokens_owner_all" on public.api_tokens;
create policy "api_tokens_owner_all" on public.api_tokens for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
