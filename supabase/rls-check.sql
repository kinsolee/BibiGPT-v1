-- KIN-41 RLS 验证脚本（只读验证，不产生业务数据）
-- 用法：在 Supabase Dashboard SQL Editor 直接整段执行，逐段看输出。
-- 前置：已执行 20260925120000_kin41_unified_content_model.sql，且存在两个测试用户：
--   USER_A / USER_B 换成 auth.users 里真实的两个 user id（uuid）。

-- 1. 确认所有表都已开启 RLS（relrowsecurity 必须全部为 true）
select c.relname, c.relrowsecurity
from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'contents', 'media_assets', 'transcripts', 'transcript_segments', 'summaries',
    'artifacts', 'chapters', 'highlights', 'collections', 'collection_items'
  );

-- 2. 以 USER_A 的身份（authenticated 角色 + JWT claims）插入一行
--    （PG 15+ 支持；若报语法错误说明 PG 版本过低，请改用下方第 2b 段）
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"USER_A","role":"authenticated"}';

insert into public.contents (user_id, source_url, service, source_ref)
values ('USER_A', 'https://www.youtube.com/watch?v=rls_check', 'youtube', 'rls_check')
returning id, user_id;

rollback;

-- 2b. 低版本 PG 的等价写法（如果上面 begin..set local 报错就用这段）
-- set role authenticated;
-- select set_config('request.jwt.claims', '{"sub":"USER_A","role":"authenticated"}', true);
-- insert into public.contents (user_id, source_url, service, source_ref)
-- values ('USER_A', 'https://www.youtube.com/watch?v=rls_check', 'youtube', 'rls_check');

-- 3. 跨用户读取必须被拒绝：以 USER_B 身份查 USER_A 的行，应返回 0 行（RLS 过滤，而非报错）
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"USER_B","role":"authenticated"}', false);

select count(*) as cross_user_visible_rows
from public.contents
where source_ref = 'rls_check';
-- 期望：cross_user_visible_rows = 0

-- 4. 跨用户写入必须被拒绝：以 USER_B 身份删除 USER_A 的行，应报 new row violates row-level security
delete from public.contents where source_ref = 'rls_check' and user_id = 'USER_A';
-- 期望：ERROR: new row violates row-level security policy for table "contents"

-- 5. 伪造 user_id 插入必须被拒绝：以 USER_A 身份写 USER_B 的 user_id
select set_config('request.jwt.claims', '{"sub":"USER_A","role":"authenticated"}', false);

insert into public.contents (user_id, source_url, service, source_ref)
values ('USER_B', 'https://www.youtube.com/watch?v=rls_check', 'youtube', 'rls_check');
-- 期望：ERROR: new row violates row-level security policy for table "contents"

-- 6. 未登录（anon 角色）应看不到任何行
reset role;
set role anon;
select count(*) as anon_visible_rows from public.contents;
-- 期望：anon_visible_rows = 0
reset role;
