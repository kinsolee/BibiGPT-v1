-- KIN-45: Playlist / Collection / Watch Later 与批量任务（自用版）
-- 设计要点：
--   * 复用 KIN-41 的 collections / collection_items 两表，只加列不改既有列。
--   * 导入不建 contents 行：collection_items.content_id 改为可空，仅在该项
--     摘要成功后由 persistSummarizedContent 的产出回填。
--   * 项级状态对齐 lib/jobs JobStatus 词汇：pending/queued/running/succeeded/failed/canceled。
--   * dedupe_key 用规范化 sourceRef（youtube:video:{id} / bilibili:video:{bvid}），
--     同一 collection 内 (collection_id, dedupe_key) 部分唯一索引保证重复 URL 不产生重复 item。
--   * 全部 DDL 可重复执行（IF NOT EXISTS / 条件执行）；不涉及任何支付/额度字段。

-- ============================================================ collections 批量化
alter table public.collections
  add column if not exists kind text not null default 'manual',
  add column if not exists source_url text,
  add column if not exists service text,
  add column if not exists external_id text,
  add column if not exists batch_status text not null default 'idle';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'collections_kind_check'
  ) then
    alter table public.collections add constraint collections_kind_check
      check (kind in ('manual', 'youtube_playlist', 'bilibili_collection', 'watch_later'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'collections_batch_status_check'
  ) then
    alter table public.collections add constraint collections_batch_status_check
      check (batch_status in ('idle', 'running', 'paused'));
  end if;
end
$$;

-- ============================================================ collection_items 批量化
alter table public.collection_items
  alter column content_id drop not null,
  add column if not exists position integer not null default 0,
  add column if not exists dedupe_key text,
  add column if not exists source_url text,
  add column if not exists service text,
  add column if not exists title text,
  add column if not exists status text not null default 'pending',
  add column if not exists job_id text,
  add column if not exists error_code text,
  add column if not exists error_message text,
  add column if not exists attempts integer not null default 0,
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'collection_items_status_check'
  ) then
    alter table public.collection_items add constraint collection_items_status_check
      check (status in ('pending', 'queued', 'running', 'succeeded', 'failed', 'canceled'));
  end if;
end
$$;

-- 同一 collection 内去重；dedupe_key 为空的旧行不受约束
create unique index if not exists collection_items_collection_dedupe_uidx
  on public.collection_items (collection_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists collection_items_collection_position_idx
  on public.collection_items (collection_id, position);

create index if not exists collection_items_status_idx
  on public.collection_items (collection_id, status);

-- ============================================================ RLS
-- KIN-41 的 collection_items 策略要求 content_id 命中 contents 行；
-- 批量导入的 item 在摘要成功前 content_id 为空，策略需放行空值（其余校验不变）。
drop policy if exists "collection_items_owner_all" on public.collection_items;
create policy "collection_items_owner_all" on public.collection_items for all to authenticated
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.collections col
      where col.id = collection_items.collection_id and col.user_id = auth.uid()
    )
    and (
      content_id is null
      or exists (
        select 1 from public.contents c
        where c.id = collection_items.content_id and c.user_id = auth.uid()
      )
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.collections col
      where col.id = collection_items.collection_id and col.user_id = auth.uid()
    )
    and (
      content_id is null
      or exists (
        select 1 from public.contents c
        where c.id = collection_items.content_id and c.user_id = auth.uid()
      )
    )
  );
