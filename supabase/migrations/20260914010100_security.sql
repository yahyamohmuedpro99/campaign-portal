-- =====================================================================================
-- Isolation. THIS FILE IS THE DATA-ISOLATION GUARANTEE.
--
-- Everything a signed-in user can reach goes through a row-level security policy that
-- reduces to: brand_id in (select private.user_brand_ids()). There is no application
-- code path that can widen that, because the anon key can only ever see what these
-- policies allow — including from a direct PostgREST call that never touches our app.
--
-- Three layers, in order of evaluation by Postgres:
--   1. GRANTs      — authenticated may SELECT a fixed set of tables and nothing else.
--                    No INSERT/UPDATE/DELETE is granted anywhere, to anyone but the
--                    service role. (Grants are checked before RLS.)
--   2. RLS         — enabled on every table, with an explicit per-brand policy.
--   3. Event trigger — any table created in public later is forced into RLS automatically,
--                    so "a route added after you've moved on" cannot be born open.
-- =====================================================================================

-- ------------------------------------------------------- helpers (not API-reachable) --
-- SECURITY DEFINER so the lookup itself is not subject to the policies it feeds, which
-- would recurse. search_path is pinned empty and every reference is schema-qualified.
create or replace function private.user_brand_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select bm.brand_id
  from public.brand_members bm
  where bm.user_id = (select auth.uid());
$$;

create or replace function private.is_brand_member(p_brand_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.brand_members bm
    where bm.user_id = (select auth.uid()) and bm.brand_id = p_brand_id
  );
$$;

create or replace function private.is_brand_owner(p_brand_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.brand_members bm
    where bm.user_id = (select auth.uid())
      and bm.brand_id = p_brand_id
      and bm.role = 'owner'
  );
$$;

revoke execute on function private.user_brand_ids()            from public;
revoke execute on function private.is_brand_member(uuid)       from public;
revoke execute on function private.is_brand_owner(uuid)        from public;
grant  execute on function private.user_brand_ids()            to authenticated;
grant  execute on function private.is_brand_member(uuid)       to authenticated;
grant  execute on function private.is_brand_owner(uuid)        to authenticated;

-- ------------------------------------------- RLS on, and nothing readable by default --
do $$
declare t text;
begin
  foreach t in array array[
    'brands','brand_members','contacts','campaigns','contact_events','historical_sends',
    'import_runs','import_rejects','import_warnings','send_previews','campaign_sends',
    'send_recipients','send_chunks','send_attempts','send_events','provider_events',
    'campaign_shares','share_access_attempts'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- --------------------------------------------------- per-brand read policies --
-- Every table that carries brand_id gets the identical policy. Writing it in a loop means
-- there is exactly one expression to audit, and no table can accidentally get a
-- hand-edited looser variant.
do $$
declare t text;
begin
  foreach t in array array[
    'contacts','campaigns','contact_events','historical_sends','import_runs',
    'import_rejects','import_warnings','send_previews','campaign_sends','send_recipients',
    'send_chunks','send_attempts','send_events','provider_events'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (brand_id in (select private.user_brand_ids()))',
      t || '_select_own_brand', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

create policy brands_select_own on public.brands
  for select to authenticated
  using (id in (select private.user_brand_ids()));
grant select on public.brands to authenticated;

-- Only your own membership row. A Kilele owner cannot enumerate the Kilele analyst's
-- user id, let alone another brand's team.
create policy brand_members_select_self on public.brand_members
  for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.brand_members to authenticated;

-- Share links are owner-only, and the secrets in the row are not grantable at all:
-- column-level privileges mean token_hash/password_hash cannot be selected even by the
-- owner who created the link, and even through a direct PostgREST query.
create policy campaign_shares_select_owner on public.campaign_shares
  for select to authenticated
  using (private.is_brand_owner(brand_id));
grant select (id, brand_id, campaign_id, label, created_by, created_at,
              expires_at, revoked_at, view_count, last_viewed_at)
  on public.campaign_shares to authenticated;

-- share_access_attempts gets no grant of any kind: service role only.

-- No INSERT / UPDATE / DELETE policy exists on any table in this schema. Every write in
-- the product happens either through the service role (import, dispatch, event
-- ingestion) or through a SECURITY DEFINER function that checks membership and role
-- first. A signed-in user holding the anon key cannot write anything, anywhere.

-- ------------------------------------------------------------- function execution --
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and Supabase exposes the
-- public schema to PostgREST. Without these revokes every helper would be callable by an
-- unauthenticated stranger over HTTP.
alter default privileges in schema public revoke execute on functions from public;
revoke execute on all functions in schema public from public, anon;

-- ---------------------------------------------- tables added after you've moved on --
create or replace function private.force_rls_on_new_tables()
returns event_trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  obj record;
begin
  for obj in select * from pg_event_trigger_ddl_commands()
             where command_tag = 'CREATE TABLE' and schema_name = 'public'
  loop
    execute format('alter table %s enable row level security', obj.object_identity);
    execute format('revoke all on %s from anon, authenticated', obj.object_identity);
    raise notice 'force_rls_on_new_tables: RLS enabled on % (no grants to anon/authenticated)',
      obj.object_identity;
  end loop;
end $$;

do $$
begin
  execute 'create event trigger force_rls_on_new_tables
             on ddl_command_end when tag in (''CREATE TABLE'')
             execute function private.force_rls_on_new_tables()';
  raise notice 'event trigger installed: new public tables get RLS automatically';
exception
  when insufficient_privilege or feature_not_supported then
    -- Managed Postgres may withhold event triggers. The regression test in
    -- tests/rls/isolation.test.ts (R1/R2) is the backstop: it fails if any table in
    -- public lacks RLS or lacks a policy, so a table added later still cannot ship open.
    raise notice 'event trigger unavailable (%) - relying on the R1/R2 regression test', sqlerrm;
end $$;
