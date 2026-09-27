-- KIN-43: 视频内 Chat/Ask 会话与消息表（自用版）
-- 设计要点：
--   * conversations 按 (user_id, content_id) 唯一：每个用户对每个已保存视频一个会话。
--   * messages.seq 为 identity 列，保证同事务/同毫秒写入的 user/assistant 消息排序稳定。
--   * citations jsonb 存助手消息的结构化引用 [{segmentId, start, end, text}]，与回答正文中的
--     [mm:ss] 标记一一对应；不涉及任何支付/额度字段。
--   * 迁移可重复执行：DDL 全部 IF NOT EXISTS，策略先 DROP 再 CREATE。

-- ============================================================ conversations
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content_id uuid not null references public.contents (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_user_content_unique unique nulls not distinct (user_id, content_id)
);

-- ============================================================ messages
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  seq bigint generated always as identity,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  citations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================ indexes
create index if not exists conversations_user_updated_idx on public.conversations (user_id, updated_at desc);
create index if not exists conversations_content_idx on public.conversations (content_id);
create index if not exists messages_conversation_seq_idx on public.messages (conversation_id, seq);

-- ============================================================ grants
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- ============================================================ RLS
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

-- 与 KIN-41 同一口径：登录用户只能读写自己的行；子表必须校验父行归属同一用户。
drop policy if exists "conversations_owner_all" on public.conversations;
create policy "conversations_owner_all" on public.conversations for all to authenticated
  using (
    auth.uid() = user_id
    and exists (select 1 from public.contents c where c.id = conversations.content_id and c.user_id = auth.uid())
  )
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.contents c where c.id = conversations.content_id and c.user_id = auth.uid())
  );

drop policy if exists "messages_owner_all" on public.messages;
create policy "messages_owner_all" on public.messages for all to authenticated
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations conv
      where conv.id = messages.conversation_id and conv.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations conv
      where conv.id = messages.conversation_id and conv.user_id = auth.uid()
    )
  );
