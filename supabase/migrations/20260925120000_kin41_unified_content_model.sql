-- KIN-41: 统一 Video/Transcript/Summary/Artifact 数据模型（自用版）
-- 设计要点：
--   * 所有业务表冗余 user_id，RLS 统一按 auth.uid() = user_id 隔离；不涉及任何支付/额度字段。
--   * 生成结果不可变：summaries 以 (content_id, input_hash) 幂等复用，重算即追加新 version。
--   * transcript_segments 字段名与并行任务 KIN-38 的 TranscriptSegment 契约对齐
--     （start/end/text/lang/speaker/source_ref）。
--   * 本迁移可重复执行：DDL 全部 IF NOT EXISTS，策略先 DROP 再 CREATE，
--     因此在空库和已有 v1 数据的库上都能执行。
--   * 需要 PostgreSQL 15+（unique nulls not distinct）；Supabase 托管库默认满足。

create extension if not exists pgcrypto;

-- ============================================================ contents
create table if not exists public.contents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source_url text not null,
  service text not null,
  source_ref text not null,
  source_page text,
  title text,
  duration double precision,
  language text,
  source_metadata jsonb not null default '{}'::jsonb,
  is_favorite boolean not null default false,
  last_summarized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contents_owner_source_unique unique nulls not distinct (user_id, service, source_ref, source_page)
);

-- ============================================================ media_assets
create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content_id uuid not null references public.contents (id) on delete cascade,
  kind text not null check (kind in ('audio', 'video')),
  url text not null,
  mime_type text,
  size_bytes bigint,
  duration double precision,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================ transcripts
create table if not exists public.transcripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content_id uuid not null references public.contents (id) on delete cascade,
  lang text,
  source text,
  source_ref text,
  full_text text,
  segment_count integer not null default 0,
  input_hash text not null,
  created_at timestamptz not null default now(),
  constraint transcripts_content_input_unique unique (content_id, input_hash)
);

-- ============================================================ transcript_segments
create table if not exists public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  transcript_id uuid not null references public.transcripts (id) on delete cascade,
  idx integer not null,
  start double precision,
  "end" double precision,
  text text not null,
  lang text,
  speaker text,
  source_ref text,
  created_at timestamptz not null default now(),
  constraint transcript_segments_transcript_idx_unique unique (transcript_id, idx)
);

-- ============================================================ summaries
create table if not exists public.summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content_id uuid not null references public.contents (id) on delete cascade,
  transcript_id uuid references public.transcripts (id) on delete set null,
  config jsonb not null default '{}'::jsonb,
  model text,
  prompt_version text not null default 'v1',
  status text not null default 'completed' check (status in ('pending', 'completed', 'failed')),
  error text,
  input_hash text not null,
  version integer not null default 1,
  content_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint summaries_content_input_unique unique (content_id, input_hash)
);

-- ============================================================ artifacts
create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content_id uuid not null references public.contents (id) on delete cascade,
  summary_id uuid references public.summaries (id) on delete cascade,
  kind text not null,
  version integer not null default 1,
  payload jsonb not null default '{}'::jsonb,
  refs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================ chapters
create table if not exists public.chapters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content_id uuid not null references public.contents (id) on delete cascade,
  summary_id uuid references public.summaries (id) on delete cascade,
  idx integer not null default 0,
  start double precision,
  "end" double precision,
  title text,
  summary text,
  created_at timestamptz not null default now()
);

-- ============================================================ highlights
create table if not exists public.highlights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content_id uuid not null references public.contents (id) on delete cascade,
  summary_id uuid references public.summaries (id) on delete cascade,
  idx integer not null default 0,
  start double precision,
  "end" double precision,
  text text not null,
  note text,
  created_at timestamptz not null default now()
);

-- ============================================================ collections（本轮仅建结构，功能后续实现）
create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists public.collection_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  collection_id uuid not null references public.collections (id) on delete cascade,
  content_id uuid not null references public.contents (id) on delete cascade,
  added_at timestamptz not null default now(),
  constraint collection_items_unique unique (collection_id, content_id)
);

-- ============================================================ indexes
create index if not exists contents_user_created_idx on public.contents (user_id, created_at desc);
create index if not exists contents_user_source_ref_idx on public.contents (user_id, source_ref);
create index if not exists contents_user_favorite_idx on public.contents (user_id) where is_favorite;
create index if not exists media_assets_content_idx on public.media_assets (content_id);
create index if not exists transcripts_content_idx on public.transcripts (content_id);
create index if not exists transcript_segments_transcript_idx on public.transcript_segments (transcript_id, idx);
create index if not exists summaries_content_version_idx on public.summaries (content_id, version desc);
create index if not exists artifacts_content_idx on public.artifacts (content_id);
create index if not exists chapters_content_idx on public.chapters (content_id, idx);
create index if not exists highlights_content_idx on public.highlights (content_id, idx);
create index if not exists collections_user_idx on public.collections (user_id);
create index if not exists collection_items_collection_idx on public.collection_items (collection_id);
create index if not exists collection_items_content_idx on public.collection_items (content_id);
-- 并发分配 version 的兜底：同内容下 version 必须唯一（应用层冲突后重读重试）
create unique index if not exists summaries_content_version_uidx on public.summaries (content_id, version);

-- ============================================================ grants
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- ============================================================ RLS
alter table public.contents enable row level security;
alter table public.media_assets enable row level security;
alter table public.transcripts enable row level security;
alter table public.transcript_segments enable row level security;
alter table public.summaries enable row level security;
alter table public.artifacts enable row level security;
alter table public.chapters enable row level security;
alter table public.highlights enable row level security;
alter table public.collections enable row level security;
alter table public.collection_items enable row level security;

-- 自用版策略：登录用户只能读写 user_id = auth.uid() 的行；匿名（anon role）无任何权限，
-- 未登录摘要继续走既有 Redis 临时缓存，不落库。
-- 顶层表（contents / collections）只校验自身 user_id；
-- 子表必须同时校验被引用父行（contents/transcripts/summaries/collections）属于同一用户，
-- 防止把行挂到他人 content/transcript/summary 上注入数据。
do $$
declare
  t text;
begin
  foreach t in array array['contents', 'collections']
  loop
    execute format('drop policy if exists "%s_owner_all" on public.%I', t, t);
    execute format(
      'create policy "%s_owner_all" on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t,
      t
    );
  end loop;

  -- 父行为 contents 的子表：media_assets / transcripts / summaries
  foreach t in array array['media_assets', 'transcripts', 'summaries']
  loop
    execute format('drop policy if exists "%s_owner_all" on public.%I', t, t);
    execute format(
      'create policy "%s_owner_all" on public.%I for all to authenticated
         using (
           auth.uid() = user_id
           and exists (select 1 from public.contents c where c.id = %I.content_id and c.user_id = auth.uid())
         )
         with check (
           auth.uid() = user_id
           and exists (select 1 from public.contents c where c.id = %I.content_id and c.user_id = auth.uid())
         )',
      t,
      t,
      t,
      t
    );
  end loop;

  -- 父行为 contents + 可空 summaries 的子表：artifacts / chapters / highlights
  foreach t in array array['artifacts', 'chapters', 'highlights']
  loop
    execute format('drop policy if exists "%s_owner_all" on public.%I', t, t);
    execute format(
      'create policy "%s_owner_all" on public.%I for all to authenticated
         using (
           auth.uid() = user_id
           and exists (select 1 from public.contents c where c.id = %I.content_id and c.user_id = auth.uid())
           and (
             summary_id is null
             or exists (select 1 from public.summaries s where s.id = %I.summary_id and s.user_id = auth.uid())
           )
         )
         with check (
           auth.uid() = user_id
           and exists (select 1 from public.contents c where c.id = %I.content_id and c.user_id = auth.uid())
           and (
             summary_id is null
             or exists (select 1 from public.summaries s where s.id = %I.summary_id and s.user_id = auth.uid())
           )
         )',
      t,
      t,
      t,
      t,
      t,
      t
    );
  end loop;
end
$$;

-- transcript_segments：父行为 transcripts
drop policy if exists "transcript_segments_owner_all" on public.transcript_segments;
create policy "transcript_segments_owner_all" on public.transcript_segments for all to authenticated
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.transcripts tr
      where tr.id = transcript_segments.transcript_id and tr.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.transcripts tr
      where tr.id = transcript_segments.transcript_id and tr.user_id = auth.uid()
    )
  );

-- collection_items：父行为 collections + contents
drop policy if exists "collection_items_owner_all" on public.collection_items;
create policy "collection_items_owner_all" on public.collection_items for all to authenticated
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.collections col
      where col.id = collection_items.collection_id and col.user_id = auth.uid()
    )
    and exists (
      select 1 from public.contents c
      where c.id = collection_items.content_id and c.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.collections col
      where col.id = collection_items.collection_id and col.user_id = auth.uid()
    )
    and exists (
      select 1 from public.contents c
      where c.id = collection_items.content_id and c.user_id = auth.uid()
    )
  );
