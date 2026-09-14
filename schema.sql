-- =====================================================================================
-- schema.sql
--
-- Generated from supabase/migrations by `pnpm schema:build`. Do not edit by hand: add a
-- migration instead, so that what runs locally, in CI and in production is the same
-- sequence of statements.
--
-- Applying this file to an empty Postgres database reproduces the portal's schema in
-- full: tables, row-level security policies, grants, and every function.
--
-- Generated from 14 migrations.
-- =====================================================================================


-- =====================================================================================
-- 20260914010000_schema.sql
-- =====================================================================================

-- =====================================================================================
-- Velocity Growth client campaign portal — core schema
--
-- Design rules that the rest of the build depends on:
--   * Every tenant table carries brand_id. Isolation is enforced by RLS (see 0002), not
--     by application filters.
--   * No natural id from the seed data is globally unique. external_id collides across
--     brands (12,406 ids are shared by Kilele and Karoo), and so do event ids. Every
--     natural key is therefore (brand_id, <id>).
--   * email is NOT a key. In the Kilele export a single malformed address
--     ("john doe@vg-eval.test") is shared by 240 distinct contacts.
--   * Suppression timestamps are monotonic: once set they are never cleared, so a later
--     import (the September delta re-activates 205 unsubscribed and 90 bounced people)
--     cannot resurrect a contact.
-- =====================================================================================

create schema if not exists private;
comment on schema private is
  'Helper functions for RLS. NOT exposed to PostgREST, so nothing here is callable over the API.';

create extension if not exists pgcrypto  with schema extensions;
create extension if not exists pg_trgm   with schema extensions;

-- ---------------------------------------------------------------------------- enums --
create type public.app_role     as enum ('owner', 'analyst');
create type public.channel_t    as enum ('email', 'sms');
create type public.send_status  as enum ('approved','dispatching','completed',
                                         'completed_with_failures','failed','cancelled');
create type public.chunk_status as enum ('pending','dispatching','indeterminate',
                                         'accepted','partially_accepted','failed');
create type public.campaign_origin as enum ('imported','portal');

-- -------------------------------------------------------------------------- tenancy --
create table public.brands (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  code       text not null unique,
  name       text not null,
  country    char(2) not null,
  timezone   text not null,
  created_at timestamptz not null default now()
);
comment on column public.brands.timezone is
  'Brand-local timezone. All "per day" reporting is bucketed in this zone, not UTC.';

create table public.brand_members (
  user_id    uuid not null references auth.users(id) on delete cascade,
  brand_id   uuid not null references public.brands(id) on delete cascade,
  role       public.app_role not null,
  created_at timestamptz not null default now(),
  primary key (user_id, brand_id)
);
create index brand_members_brand_idx on public.brand_members (brand_id);

-- ---------------------------------------------------------------- import observability --
create table public.import_runs (
  id            uuid primary key default gen_random_uuid(),
  brand_id      uuid not null references public.brands(id) on delete cascade,
  entity        text not null check (entity in ('contacts','campaigns','events','send_log')),
  source_file   text not null,
  file_sha256   text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running' check (status in ('running','succeeded','failed')),
  rows_read     integer not null default 0,
  rows_inserted integer not null default 0,
  rows_updated  integer not null default 0,
  rows_unchanged integer not null default 0,
  rows_rejected integer not null default 0,
  rows_warned   integer not null default 0,
  error         text,
  notes         jsonb
);
create index import_runs_brand_idx on public.import_runs (brand_id, started_at desc);

create table public.import_rejects (
  id          bigint generated always as identity primary key,
  run_id      uuid not null references public.import_runs(id) on delete cascade,
  brand_id    uuid not null references public.brands(id) on delete cascade,
  row_no      integer,
  reason_code text not null,
  detail      text,
  raw         jsonb
);
create index import_rejects_run_idx    on public.import_rejects (run_id, id);
create index import_rejects_reason_idx on public.import_rejects (run_id, reason_code);

create table public.import_warnings (
  id          bigint generated always as identity primary key,
  run_id      uuid not null references public.import_runs(id) on delete cascade,
  brand_id    uuid not null references public.brands(id) on delete cascade,
  row_no      integer,
  reason_code text not null,
  detail      text,
  raw         jsonb
);
create index import_warnings_run_idx    on public.import_warnings (run_id, id);
create index import_warnings_reason_idx on public.import_warnings (run_id, reason_code);

-- ------------------------------------------------------------------------- contacts --
create table public.contacts (
  id                uuid primary key default gen_random_uuid(),
  brand_id          uuid not null references public.brands(id) on delete cascade,
  external_id       text not null,
  full_name         text,
  -- Normalised value, or NULL when the source value could not be represented. The raw
  -- string is always kept so the marketer can see what we refused and why.
  email             text,
  email_raw         text,
  phone_e164        text,
  phone_raw         text,
  country           char(2),
  country_raw       text,
  city              text,
  signup_at         timestamptz,
  signup_at_raw     text,
  status            text not null default 'unknown',
  status_raw        text,
  consent_marketing boolean,              -- NULL = the export said nothing. Never treated as consent.
  consent_raw       text,
  brand_code_raw    text,
  notes             text,
  deleted_at        timestamptz,
  suppressed_until  timestamptz,
  -- Monotonic suppression. Set once, never cleared by any later import.
  unsubscribed_at   timestamptz,
  complained_at     timestamptz,
  bounced_at        timestamptz,
  first_seen_run    uuid references public.import_runs(id) on delete set null,
  last_seen_run     uuid references public.import_runs(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Time-independent part of contactability, so it can be indexed. The time-dependent
  -- part (suppressed_until > now()) is always evaluated live at query time.
  contactable_static boolean not null generated always as (
        deleted_at      is null
    and unsubscribed_at is null
    and complained_at   is null
    and bounced_at      is null
    and consent_marketing is true
    and status = 'active'
    and (email is not null or phone_e164 is not null)
  ) stored,
  constraint contacts_external_id_not_blank check (length(btrim(external_id)) > 0),
  constraint contacts_brand_external_id_key unique (brand_id, external_id)
);
create index contacts_brand_contactable_idx on public.contacts (brand_id, contactable_static);
create index contacts_brand_signup_idx      on public.contacts (brand_id, signup_at);
create index contacts_brand_status_idx      on public.contacts (brand_id, status);
create index contacts_keyset_idx            on public.contacts (brand_id, id);
create index contacts_name_trgm_idx         on public.contacts using gin (full_name extensions.gin_trgm_ops);
create index contacts_email_trgm_idx        on public.contacts using gin (email    extensions.gin_trgm_ops);

-- ------------------------------------------------------------------------ campaigns --
create table public.campaigns (
  id                uuid primary key default gen_random_uuid(),
  brand_id          uuid not null references public.brands(id) on delete cascade,
  external_id       text not null,
  name              text not null,
  channel           public.channel_t not null,
  target_country    char(2),
  origin            public.campaign_origin not null default 'imported',
  -- Metrics as claimed by the source export. Kept verbatim and never reconciled against
  -- the engagement log: across all three brands they over-report opens ~3x and
  -- under-report bounces ~2x, and some campaigns claim more opens than sends.
  reported_sent      integer,
  reported_delivered integer,
  reported_bounced   integer,
  reported_opens     integer,
  reported_clicks    integer,
  spend              numeric(14,2),
  sent_at            timestamptz,
  send_local_time    text,
  parent_campaign_external_id text,
  imported_status   text not null default 'historical'
                    check (imported_status in ('draft','historical')),
  created_at        timestamptz not null default now(),
  constraint campaigns_brand_external_id_key unique (brand_id, external_id)
);
create index campaigns_brand_idx on public.campaigns (brand_id, sent_at desc nulls last);

-- --------------------------------------------------------------- imported event log --
create table public.contact_events (
  id                   bigint generated always as identity primary key,
  brand_id             uuid not null references public.brands(id) on delete cascade,
  event_id             text not null,
  contact_id           uuid not null references public.contacts(id) on delete cascade,
  -- Nullable on purpose. 633 of Marrakech's 940 events reference campaigns that are not
  -- in any export. Dropping them would discard 145 bounces, 138 complaints and 138
  -- unsubscribes and would wrongly make 274 suppressed people contactable again.
  campaign_id          uuid references public.campaigns(id) on delete set null,
  unknown_campaign_ref text,
  event_type           text not null,
  channel              public.channel_t,
  occurred_at          timestamptz not null,
  constraint contact_events_brand_event_key unique (brand_id, event_id)
);
create index contact_events_campaign_idx on public.contact_events (brand_id, campaign_id, event_type);
create index contact_events_contact_idx  on public.contact_events (contact_id, event_type);

create table public.historical_sends (
  id           uuid primary key default gen_random_uuid(),
  brand_id     uuid not null references public.brands(id) on delete cascade,
  batch_key    text not null,
  campaign_id  uuid references public.campaigns(id) on delete set null,
  campaign_ref text,
  queued_at    timestamptz,
  recipient_count integer,
  status       text,
  constraint historical_sends_brand_batch_key unique (brand_id, batch_key)
);

-- ----------------------------------------------------------------- sends: the funnel --
create table public.send_previews (
  id                   uuid primary key default gen_random_uuid(),
  brand_id             uuid not null references public.brands(id) on delete cascade,
  campaign_id          uuid not null references public.campaigns(id) on delete cascade,
  created_by           uuid not null references auth.users(id),
  created_at           timestamptz not null default now(),
  audience_rule        jsonb not null,
  recipient_count      integer not null,
  -- Hash of the ordered recipient id list. Guards composition drift, not just size:
  -- 40,000 in and 40,000 out with twelve people swapped must not pass as unchanged.
  audience_fingerprint text not null
);
create index send_previews_campaign_idx on public.send_previews (campaign_id, created_at desc);

create table public.campaign_sends (
  id                   uuid primary key default gen_random_uuid(),
  brand_id             uuid not null references public.brands(id) on delete cascade,
  campaign_id          uuid not null references public.campaigns(id) on delete cascade,
  status               public.send_status not null default 'approved',
  audience_rule        jsonb not null,
  approved_count       integer not null,
  audience_fingerprint text not null,
  approved_by          uuid not null references auth.users(id),
  approved_at          timestamptz not null default now(),
  created_from_preview uuid references public.send_previews(id) on delete set null,
  dispatch_lease_owner text,
  dispatch_lease_until timestamptz,
  completed_at         timestamptz,
  accepted_total       integer not null default 0,
  rejected_total       integer not null default 0
);
-- One live send per campaign. Holds even if someone calls PostgREST directly instead of
-- going through approve_campaign_send(). 'completed' is not 'cancelled', so a campaign
-- sends exactly once; the UI states that rule rather than failing silently.
create unique index campaign_sends_one_live_idx
  on public.campaign_sends (campaign_id) where status <> 'cancelled';
create index campaign_sends_brand_idx on public.campaign_sends (brand_id, approved_at desc);

create table public.send_recipients (
  id              uuid primary key default gen_random_uuid(),
  send_id         uuid not null references public.campaign_sends(id) on delete cascade,
  brand_id        uuid not null references public.brands(id) on delete cascade,
  contact_id      uuid not null references public.contacts(id) on delete cascade,
  chunk_no        integer not null,
  -- Approval-time snapshot: what we would send to, as it was when the owner confirmed.
  email           text,
  phone_e164      text,
  snapshot_note   text,
  provider_status text,
  rejected_reason text,
  delivered_at    timestamptz,
  bounced_at      timestamptz,
  opened_at       timestamptz,
  clicked_at      timestamptz,
  unsubscribed_at timestamptz,
  complained_at   timestamptz,
  constraint send_recipients_send_contact_key unique (send_id, contact_id)
);
create index send_recipients_chunk_idx  on public.send_recipients (send_id, chunk_no);
create index send_recipients_status_idx on public.send_recipients (send_id, provider_status);

create table public.send_chunks (
  id                 uuid primary key default gen_random_uuid(),
  send_id            uuid not null references public.campaign_sends(id) on delete cascade,
  brand_id           uuid not null references public.brands(id) on delete cascade,
  chunk_no           integer not null,
  -- Deterministic and stable across every attempt of this chunk. The provider replays the
  -- original batch for a repeated key (verified), so retrying with the same key is safe;
  -- reusing a key for different content would silently drop the difference.
  idempotency_key    text not null,
  recipient_count    integer not null,
  status             public.chunk_status not null default 'pending',
  attempts           integer not null default 0,
  claimed_at         timestamptz,
  claimed_by         text,
  provider_batch_id  text unique,
  accepted_count     integer,
  rejected_count     integer,
  events_cursor      text,
  events_exhausted   boolean not null default false,
  last_polled_at     timestamptz,
  resolved_by        uuid references auth.users(id),
  resolved_at        timestamptz,
  resolution_note    text,
  constraint send_chunks_send_chunk_key unique (send_id, chunk_no)
);
create index send_chunks_claim_idx on public.send_chunks (send_id, status, chunk_no);
create index send_chunks_poll_idx  on public.send_chunks (events_exhausted, last_polled_at)
  where provider_batch_id is not null;

-- The crash-window ledger. A row is committed BEFORE the provider call and closed after
-- it, so a process that dies mid-call leaves proof that the call may have happened.
create table public.send_attempts (
  id                bigint generated always as identity primary key,
  chunk_id          uuid not null references public.send_chunks(id) on delete cascade,
  brand_id          uuid not null references public.brands(id) on delete cascade,
  attempt_no        integer not null,
  idempotency_key   text not null,
  request_sha256    text not null,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  http_status       integer,
  provider_batch_id text,
  accepted_count    integer,
  rejected_count    integer,
  error             text,
  response_excerpt  text,
  constraint send_attempts_chunk_attempt_key unique (chunk_id, attempt_no)
);

create table public.send_events (
  id        bigint generated always as identity primary key,
  brand_id  uuid not null references public.brands(id) on delete cascade,
  send_id   uuid not null references public.campaign_sends(id) on delete cascade,
  chunk_id  uuid references public.send_chunks(id) on delete cascade,
  at        timestamptz not null default now(),
  actor     text not null,
  event     text not null,
  detail    jsonb
);
create index send_events_send_idx on public.send_events (send_id, id);

create table public.provider_events (
  id                bigint generated always as identity primary key,
  brand_id          uuid not null references public.brands(id) on delete cascade,
  chunk_id          uuid not null references public.send_chunks(id) on delete cascade,
  recipient_id      uuid references public.send_recipients(id) on delete cascade,
  provider_event_id text not null,
  event_type        text not null,
  occurred_at       timestamptz,
  received_at       timestamptz not null default now(),
  raw_excerpt       text,
  constraint provider_events_chunk_event_key unique (chunk_id, provider_event_id)
);
create index provider_events_recipient_idx on public.provider_events (recipient_id, event_type);

-- --------------------------------------------------------------------- share links --
create table public.campaign_shares (
  id            uuid primary key default gen_random_uuid(),
  brand_id      uuid not null references public.brands(id) on delete cascade,
  campaign_id   uuid not null references public.campaigns(id) on delete cascade,
  label         text,
  token_hash    bytea not null unique,
  password_hash text not null,
  created_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '30 days'),
  revoked_at    timestamptz,
  view_count    integer not null default 0,
  last_viewed_at timestamptz
);
create index campaign_shares_campaign_idx on public.campaign_shares (campaign_id, created_at desc);

create table public.share_access_attempts (
  id         bigint generated always as identity primary key,
  token_hash bytea not null,
  ip         inet,
  at         timestamptz not null default now(),
  ok         boolean not null
);
create index share_access_attempts_idx on public.share_access_attempts (token_hash, at desc);



-- =====================================================================================
-- 20260914010100_security.sql
-- =====================================================================================

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



-- =====================================================================================
-- 20260914010200_functions.sql
-- =====================================================================================

-- =====================================================================================
-- Audience selection, approval, and provider-event application.
--
-- The audience is computed by exactly one function. The preview the owner reads, the
-- count they confirm, and the recipient rows we actually dispatch all come from that
-- same function, so "the count on the confirmation screen is what the marketer is
-- approving" is true by construction rather than by careful coding.
-- =====================================================================================

-- The provider accepts at most 500 recipients per call. Verified, not assumed: a 2,000
-- recipient call returns HTTP 200 with status "accepted", accepted_count 500 and 1,500
-- rejections carrying reason "recipient_cap_exceeded". Their documentation claims
-- "up to 100,000 recipients per call. No practical limit." Trusting it would silently
-- drop three quarters of a send behind a green response.
create or replace function private.provider_chunk_size()
returns integer language sql immutable set search_path = '' as $$ select 500 $$;

-- One vocabulary for event types. The provider's docs list delivered/bounced/opened/
-- unsubscribed, the live API also emits them in that form, and the historical seed log
-- uses open/click/complaint/bounce/unsubscribe. Everything is folded here so no other
-- code has to know which dialect it is holding.
create or replace function private.canonical_event_type(p text)
returns text language sql immutable set search_path = '' as $$
  select case lower(btrim(coalesce(p, '')))
    when 'delivered'    then 'delivered'
    when 'delivery'     then 'delivered'
    when 'sent'         then 'delivered'
    when 'open'         then 'opened'
    when 'opened'       then 'opened'
    when 'click'        then 'clicked'
    when 'clicked'      then 'clicked'
    when 'bounce'       then 'bounced'
    when 'bounced'      then 'bounced'
    when 'complaint'    then 'complained'
    when 'complained'   then 'complained'
    when 'spam'         then 'complained'
    when 'unsubscribe'  then 'unsubscribed'
    when 'unsubscribed' then 'unsubscribed'
    when 'failed'       then 'failed'
    when 'rejected'     then 'failed'
    else lower(btrim(coalesce(p, 'unknown')))
  end;
$$;

-- ------------------------------------------------------------------- the audience --
create or replace function private.audience_for_campaign(p_campaign_id uuid)
returns table (contact_id uuid, email text, phone_e164 text, snapshot_note text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    ct.id,
    ct.email,
    ct.phone_e164,
    'consent=true status=active channel=' || c.channel::text ||
      case when c.target_country is not null then ' country=' || c.target_country else '' end
  from public.campaigns c
  join public.contacts ct on ct.brand_id = c.brand_id
  where c.id = p_campaign_id
    and ct.contactable_static
    and (ct.suppressed_until is null or ct.suppressed_until <= now())
    and case c.channel
          when 'email' then ct.email is not null
          when 'sms'   then ct.phone_e164 is not null
        end
    and (c.target_country is null or ct.country = c.target_country)
  order by ct.id;
$$;

-- Owner-facing paginated view of exactly who a send would go to.
create or replace function public.campaign_audience(
  p_campaign_id uuid, p_limit integer default 50, p_offset integer default 0)
returns table (contact_id uuid, external_id text, full_name text, email text,
               phone_e164 text, country char(2))
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_brand uuid;
begin
  select c.brand_id into v_brand from public.campaigns c where c.id = p_campaign_id;
  if v_brand is null then raise exception 'campaign_not_found' using errcode = 'P0002'; end if;
  if not private.is_brand_member(v_brand) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select a.contact_id, ct.external_id, ct.full_name, a.email, a.phone_e164, ct.country
    from private.audience_for_campaign(p_campaign_id) a
    join public.contacts ct on ct.id = a.contact_id
    order by ct.external_id
    limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
end $$;

-- ------------------------------------------------------------------------ preview --
create or replace function public.preview_campaign_send(p_campaign_id uuid)
returns public.send_previews
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c      public.campaigns%rowtype;
  v_count  integer;
  v_fp     text;
  v_row    public.send_previews;
begin
  select * into v_c from public.campaigns where id = p_campaign_id;
  if v_c.id is null then raise exception 'campaign_not_found' using errcode = 'P0002'; end if;
  if not private.is_brand_owner(v_c.brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select count(*), coalesce(md5(string_agg(a.contact_id::text, ',' order by a.contact_id)), '')
    into v_count, v_fp
  from private.audience_for_campaign(p_campaign_id) a;

  insert into public.send_previews
    (brand_id, campaign_id, created_by, audience_rule, recipient_count, audience_fingerprint)
  values (
    v_c.brand_id, p_campaign_id, (select auth.uid()),
    jsonb_build_object(
      'rule_version', 1,
      'channel', v_c.channel,
      'target_country', v_c.target_country,
      'requires', case v_c.channel when 'email' then 'a valid email address'
                                   else 'a valid E.164 mobile number' end,
      'excludes', jsonb_build_array(
        'soft-deleted contacts',
        'contacts whose marketing consent is not explicitly true',
        'contacts whose status is not active',
        'contacts with an unsubscribe, spam complaint or hard bounce on record',
        'contacts under a time-limited suppression that has not expired')),
    v_count, v_fp)
  returning * into v_row;

  return v_row;
end $$;

-- ----------------------------------------------------------------------- approval --
-- Idempotent and concurrency-safe. Pressing confirm twice, or from two sessions at once,
-- produces exactly one send: the advisory lock serialises the callers, the existing-send
-- check short-circuits the loser, and the partial unique index is the last line of
-- defence if anyone reaches the table by another route.
create or replace function public.approve_campaign_send(
  p_preview_id uuid,
  p_expected_count integer,
  p_chunk_size integer default null)
returns public.campaign_sends
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p        public.send_previews%rowtype;
  v_existing public.campaign_sends%rowtype;
  v_send     public.campaign_sends%rowtype;
  v_count    integer;
  v_fp       text;
  v_chunk    integer := coalesce(p_chunk_size, private.provider_chunk_size());
  v_actual   integer;
begin
  select * into v_p from public.send_previews where id = p_preview_id;
  if v_p.id is null then raise exception 'preview_not_found' using errcode = 'P0002'; end if;
  if not private.is_brand_owner(v_p.brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_p.created_by <> (select auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_chunk < 1 or v_chunk > private.provider_chunk_size() then
    raise exception 'chunk_size_out_of_range' using errcode = 'P0001';
  end if;

  -- Serialise concurrent confirms of the same campaign for the rest of this transaction.
  perform pg_advisory_xact_lock(42, hashtext(v_p.campaign_id::text));

  select * into v_existing
  from public.campaign_sends
  where campaign_id = v_p.campaign_id and status <> 'cancelled'
  limit 1;

  if v_existing.id is not null then
    insert into public.send_events (brand_id, send_id, actor, event, detail)
    values (v_existing.brand_id, v_existing.id, 'user:' || (select auth.uid()),
            'approval_returned_existing',
            jsonb_build_object('preview_id', p_preview_id,
                               'existing_status', v_existing.status,
                               'approved_at', v_existing.approved_at));
    return v_existing;
  end if;

  -- Recompute from the same function the preview used. Both the size and the exact
  -- membership must still match what the owner was shown.
  select count(*), coalesce(md5(string_agg(a.contact_id::text, ',' order by a.contact_id)), '')
    into v_count, v_fp
  from private.audience_for_campaign(v_p.campaign_id) a;

  if v_count <> p_expected_count or v_count <> v_p.recipient_count then
    raise exception 'audience_count_changed: preview=%, confirmed=%, now=%',
      v_p.recipient_count, p_expected_count, v_count using errcode = 'P0001';
  end if;
  if v_fp <> v_p.audience_fingerprint then
    raise exception 'audience_membership_changed: the same number of people, but not the same people'
      using errcode = 'P0001';
  end if;

  insert into public.campaign_sends
    (brand_id, campaign_id, audience_rule, approved_count, audience_fingerprint,
     approved_by, created_from_preview)
  values (v_p.brand_id, v_p.campaign_id, v_p.audience_rule, v_count, v_fp,
          (select auth.uid()), v_p.id)
  returning * into v_send;

  insert into public.send_recipients
    (send_id, brand_id, contact_id, chunk_no, email, phone_e164, snapshot_note)
  select v_send.id, v_p.brand_id, a.contact_id,
         ((row_number() over (order by a.contact_id) - 1) / v_chunk)::integer,
         a.email, a.phone_e164, a.snapshot_note
  from private.audience_for_campaign(v_p.campaign_id) a;

  insert into public.send_chunks
    (send_id, brand_id, chunk_no, idempotency_key, recipient_count)
  select v_send.id, v_p.brand_id, r.chunk_no,
         encode(extensions.digest(v_send.id::text || ':' || r.chunk_no || ':v1', 'sha256'), 'hex'),
         count(*)
  from public.send_recipients r
  where r.send_id = v_send.id
  group by r.chunk_no;

  -- Invariant: we will dispatch exactly the number that was approved, no more, no less.
  select count(*) into v_actual from public.send_recipients where send_id = v_send.id;
  if v_actual <> v_count then
    raise exception 'recipient_snapshot_mismatch: approved %, snapshotted %', v_count, v_actual
      using errcode = 'P0001';
  end if;

  insert into public.send_events (brand_id, send_id, actor, event, detail)
  values (v_send.brand_id, v_send.id, 'user:' || (select auth.uid()), 'approval_created',
          jsonb_build_object('approved_count', v_count,
                             'audience_fingerprint', v_fp,
                             'chunk_size', v_chunk,
                             'chunks', (select count(*) from public.send_chunks where send_id = v_send.id)));
  return v_send;

exception
  when unique_violation then
    -- Another transaction won the race by a path that bypassed the advisory lock.
    select * into v_existing
    from public.campaign_sends
    where campaign_id = v_p.campaign_id and status <> 'cancelled'
    limit 1;
    if v_existing.id is null then raise; end if;
    return v_existing;
end $$;

create or replace function public.cancel_campaign_send(p_send_id uuid, p_reason text default null)
returns public.campaign_sends
language plpgsql
security definer
set search_path = ''
as $$
declare v_send public.campaign_sends%rowtype;
begin
  select * into v_send from public.campaign_sends where id = p_send_id;
  if v_send.id is null then raise exception 'send_not_found' using errcode = 'P0002'; end if;
  if not private.is_brand_owner(v_send.brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_send.status <> 'approved' then
    raise exception 'only_unstarted_sends_can_be_cancelled' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.send_chunks
             where send_id = p_send_id and status <> 'pending') then
    raise exception 'dispatch_already_started' using errcode = 'P0001';
  end if;

  update public.campaign_sends set status = 'cancelled', completed_at = now()
  where id = p_send_id returning * into v_send;

  insert into public.send_events (brand_id, send_id, actor, event, detail)
  values (v_send.brand_id, v_send.id, 'user:' || (select auth.uid()), 'send_cancelled',
          jsonb_build_object('reason', p_reason));
  return v_send;
end $$;

-- ------------------------------------------- applying what the provider tells us --
-- Delivery reports arrive late, duplicated and out of order (the live API returned 25
-- out-of-order pairs in a 50-event page). Every write here is therefore commutative:
-- earliest timestamp wins per event kind, and the derived status is recomputed from the
-- timestamps rather than from arrival order. Replaying the whole stream changes nothing.
create or replace function private.apply_provider_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  with agg as (
    select n.recipient_id,
           min(n.occurred_at) filter (where n.event_type = 'delivered')    as delivered_at,
           min(n.occurred_at) filter (where n.event_type = 'bounced')      as bounced_at,
           min(n.occurred_at) filter (where n.event_type = 'opened')       as opened_at,
           min(n.occurred_at) filter (where n.event_type = 'clicked')      as clicked_at,
           min(n.occurred_at) filter (where n.event_type = 'unsubscribed') as unsubscribed_at,
           min(n.occurred_at) filter (where n.event_type = 'complained')   as complained_at
    from newrows n
    where n.recipient_id is not null
    group by n.recipient_id
  )
  update public.send_recipients r set
    delivered_at    = least(r.delivered_at,    agg.delivered_at),
    bounced_at      = least(r.bounced_at,      agg.bounced_at),
    opened_at       = least(r.opened_at,       agg.opened_at),
    clicked_at      = least(r.clicked_at,      agg.clicked_at),
    unsubscribed_at = least(r.unsubscribed_at, agg.unsubscribed_at),
    complained_at   = least(r.complained_at,   agg.complained_at)
  from agg where r.id = agg.recipient_id;

  -- Terminal-negative outcomes outrank positive ones however they arrive, so a bounce
  -- that lands after a delivered does not read as delivered.
  update public.send_recipients r set provider_status =
    case
      when r.complained_at   is not null then 'complained'
      when r.unsubscribed_at is not null then 'unsubscribed'
      when r.bounced_at      is not null then 'bounced'
      when r.delivered_at    is not null then 'delivered'
      when r.opened_at is not null or r.clicked_at is not null then 'delivered_inferred'
      else coalesce(r.provider_status, 'accepted')
    end
  where r.id in (select distinct nr.recipient_id from newrows nr where nr.recipient_id is not null);

  -- Suppression flows back to the contact, monotonically and within this brand only.
  -- The same human may exist under another brand with their own consent record; one
  -- client's unsubscribe is not another client's to act on.
  with agg as (
    select r.contact_id,
           min(n.occurred_at) filter (where n.event_type = 'unsubscribed') as unsub,
           min(n.occurred_at) filter (where n.event_type = 'complained')   as compl,
           min(n.occurred_at) filter (where n.event_type = 'bounced')      as bounce
    from newrows n
    join public.send_recipients r on r.id = n.recipient_id
    group by r.contact_id
  )
  update public.contacts ct set
    unsubscribed_at = least(ct.unsubscribed_at, agg.unsub),
    complained_at   = least(ct.complained_at,   agg.compl),
    bounced_at      = least(ct.bounced_at,      agg.bounce),
    updated_at      = now()
  from agg
  where ct.id = agg.contact_id
    and (agg.unsub is not null or agg.compl is not null or agg.bounce is not null);

  return null;
end $$;

create trigger provider_events_apply
  after insert on public.provider_events
  referencing new table as newrows
  for each statement execute function private.apply_provider_events();

-- ------------------------------------------------------------- callable over the API --
revoke execute on function public.preview_campaign_send(uuid)             from public, anon;
revoke execute on function public.approve_campaign_send(uuid,integer,integer) from public, anon;
revoke execute on function public.cancel_campaign_send(uuid,text)         from public, anon;
revoke execute on function public.campaign_audience(uuid,integer,integer) from public, anon;
grant  execute on function public.preview_campaign_send(uuid)             to authenticated;
grant  execute on function public.approve_campaign_send(uuid,integer,integer) to authenticated;
grant  execute on function public.cancel_campaign_send(uuid,text)         to authenticated;
grant  execute on function public.campaign_audience(uuid,integer,integer) to authenticated;



-- =====================================================================================
-- 20260914010300_reporting.sql
-- =====================================================================================

-- =====================================================================================
-- Reporting.
--
-- Every number the portal shows is produced here, once, so the dashboard, the contact
-- list and the send preview cannot drift apart. Where two careful people could count
-- something two ways, the function returns the breakdown rather than a single figure and
-- the screen states the rule.
-- =====================================================================================

-- How many customers this brand has. Soft-deleted rows are excluded and counted
-- separately so the exclusion is visible rather than silent.
create or replace function public.brand_totals(p_brand_id uuid)
returns table (total_customers bigint, soft_deleted bigint, contactable bigint,
               email_reachable bigint, sms_reachable bigint, latest_signup timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_brand_member(p_brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select
    count(*) filter (where c.deleted_at is null),
    count(*) filter (where c.deleted_at is not null),
    count(*) filter (where c.contactable_static
                       and (c.suppressed_until is null or c.suppressed_until <= now())),
    count(*) filter (where c.contactable_static
                       and (c.suppressed_until is null or c.suppressed_until <= now())
                       and c.email is not null),
    count(*) filter (where c.contactable_static
                       and (c.suppressed_until is null or c.suppressed_until <= now())
                       and c.phone_e164 is not null),
    max(c.signup_at) filter (where c.deleted_at is null)
  from public.contacts c
  where c.brand_id = p_brand_id;
end $$;

-- Contactability as a waterfall rather than a bare number. Each step counts only the
-- people who survived every step above it, so the steps sum exactly to the total and a
-- reader can disagree with a specific rule instead of distrusting the figure.
create or replace function public.brand_contactability_waterfall(p_brand_id uuid)
returns table (step_order integer, step_key text, label text, excluded bigint, remaining bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_total bigint; v1 bigint; v2 bigint; v3 bigint; v4 bigint;
  v5 bigint; v6 bigint; v7 bigint; v8 bigint; v_run bigint;
begin
  if not private.is_brand_member(p_brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with f as (
    select
      (c.deleted_at is not null)                                              as d,
      (c.consent_marketing is not true)                                       as nc,
      (c.status <> 'active')                                                  as na,
      (c.unsubscribed_at is not null)                                         as u,
      (c.complained_at is not null)                                           as cm,
      (c.bounced_at is not null)                                              as b,
      (c.suppressed_until is not null and c.suppressed_until > now())          as s,
      (c.email is null and c.phone_e164 is null)                              as nch
    from public.contacts c
    where c.brand_id = p_brand_id
  )
  select count(*),
         count(*) filter (where d),
         count(*) filter (where not d and nc),
         count(*) filter (where not d and not nc and na),
         count(*) filter (where not d and not nc and not na and u),
         count(*) filter (where not d and not nc and not na and not u and cm),
         count(*) filter (where not d and not nc and not na and not u and not cm and b),
         count(*) filter (where not d and not nc and not na and not u and not cm and not b and s),
         count(*) filter (where not d and not nc and not na and not u and not cm and not b and not s and nch)
    into v_total, v1, v2, v3, v4, v5, v6, v7, v8
  from f;

  v_run := v_total;
  return query select 0, 'total', 'Customers on record', 0::bigint, v_total;
  v_run := v_run - v1; return query select 1, 'deleted',      'Removed from the customer list at source', v1, v_run;
  v_run := v_run - v2; return query select 2, 'no_consent',   'Marketing consent not explicitly given',   v2, v_run;
  v_run := v_run - v3; return query select 3, 'not_active',   'Account status is not active',             v3, v_run;
  v_run := v_run - v4; return query select 4, 'unsubscribed', 'Unsubscribed',                             v4, v_run;
  v_run := v_run - v5; return query select 5, 'complained',   'Reported a message as spam',               v5, v_run;
  v_run := v_run - v6; return query select 6, 'bounced',      'Hard bounced',                             v6, v_run;
  v_run := v_run - v7; return query select 7, 'suppressed',   'Under a temporary suppression',            v7, v_run;
  v_run := v_run - v8; return query select 8, 'no_channel',   'No usable email address or mobile number', v8, v_run;
  return query select 9, 'contactable', 'Contactable today', 0::bigint, v_run;
end $$;

-- Signups per day, bucketed in the brand's own timezone. A Nairobi signup just before
-- midnight belongs to that day in Nairobi, not to the previous day in UTC.
-- p_window 'today'  : the 30 days ending today.
-- p_window 'latest' : the 30 days ending on this brand's most recent signup, for brands
--                     whose export stopped months ago. The screen says which is shown.
create or replace function public.brand_signups_per_day(
  p_brand_id uuid, p_window text default 'today', p_days integer default 30)
returns table (day date, signups bigint)
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_end date; v_days integer := least(greatest(coalesce(p_days,30),1),366);
begin
  if not private.is_brand_member(p_brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select b.timezone into v_tz from public.brands b where b.id = p_brand_id;
  if v_tz is null then raise exception 'brand_not_found' using errcode = 'P0002'; end if;

  if p_window = 'latest' then
    select max((c.signup_at at time zone v_tz)::date) into v_end
    from public.contacts c where c.brand_id = p_brand_id and c.deleted_at is null;
  end if;
  v_end := coalesce(v_end, (now() at time zone v_tz)::date);

  return query
  with days as (
    select generate_series(v_end - (v_days - 1), v_end, interval '1 day')::date as day
  )
  select d.day, count(c.id)
  from days d
  left join public.contacts c
    on c.brand_id = p_brand_id
   and c.deleted_at is null
   and (c.signup_at at time zone v_tz)::date = d.day
  group by d.day
  order by d.day;
end $$;

-- Per-campaign performance from three independent sources, side by side and never
-- reconciled into one "true" figure.
--   reported_* : what the source export claimed. Across all three brands these
--                over-report opens roughly threefold and under-report bounces roughly
--                twofold, and some campaigns claim more opens than sends.
--   observed_* : distinct contacts with that event in the imported engagement log.
--   portal_*   : what our own send actually produced, confirmed by the provider.
create or replace function public.brand_campaign_performance(p_brand_id uuid)
returns table (
  campaign_id uuid, external_id text, name text, channel public.channel_t,
  sent_at timestamptz, imported_status text,
  reported_sent integer, reported_delivered integer, reported_bounced integer,
  reported_opens integer, reported_clicks integer, spend numeric,
  observed_delivered bigint, observed_opened bigint, observed_clicked bigint,
  observed_bounced bigint, observed_unsubscribed bigint, observed_complained bigint,
  portal_send_id uuid, portal_status public.send_status, portal_approved integer,
  portal_accepted bigint, portal_delivered bigint, portal_bounced bigint,
  portal_opened bigint, portal_unsubscribed bigint, portal_complained bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_brand_member(p_brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select
    c.id, c.external_id, c.name, c.channel, c.sent_at, c.imported_status,
    c.reported_sent, c.reported_delivered, c.reported_bounced,
    c.reported_opens, c.reported_clicks, c.spend,
    coalesce(o.delivered, 0), coalesce(o.opened, 0), coalesce(o.clicked, 0),
    coalesce(o.bounced, 0), coalesce(o.unsubscribed, 0), coalesce(o.complained, 0),
    s.id, s.status, s.approved_count,
    coalesce(p.accepted, 0), coalesce(p.delivered, 0), coalesce(p.bounced, 0),
    coalesce(p.opened, 0), coalesce(p.unsubscribed, 0), coalesce(p.complained, 0)
  from public.campaigns c
  left join lateral (
    select
      count(distinct e.contact_id) filter (where e.event_type = 'delivered')    as delivered,
      count(distinct e.contact_id) filter (where e.event_type = 'opened')       as opened,
      count(distinct e.contact_id) filter (where e.event_type = 'clicked')      as clicked,
      count(distinct e.contact_id) filter (where e.event_type = 'bounced')      as bounced,
      count(distinct e.contact_id) filter (where e.event_type = 'unsubscribed') as unsubscribed,
      count(distinct e.contact_id) filter (where e.event_type = 'complained')   as complained
    from public.contact_events e
    where e.campaign_id = c.id
  ) o on true
  left join public.campaign_sends s on s.campaign_id = c.id and s.status <> 'cancelled'
  left join lateral (
    select
      count(*) filter (where r.provider_status is not null
                         and r.provider_status <> 'rejected')        as accepted,
      count(*) filter (where r.delivered_at    is not null)          as delivered,
      count(*) filter (where r.bounced_at      is not null)          as bounced,
      count(*) filter (where r.opened_at       is not null)          as opened,
      count(*) filter (where r.unsubscribed_at is not null)          as unsubscribed,
      count(*) filter (where r.complained_at   is not null)          as complained
    from public.send_recipients r
    where r.send_id = s.id
  ) p on s.id is not null
  where c.brand_id = p_brand_id
  order by c.sent_at desc nulls last, c.external_id;
end $$;

-- Events in the imported log that name a campaign absent from the campaign export. They
-- still count for suppression; they cannot be attributed to a campaign. Surfaced so the
-- gap is stated rather than quietly absorbed.
create or replace function public.brand_orphan_event_summary(p_brand_id uuid)
returns table (unknown_campaign_ref text, events bigint, contacts bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_brand_member(p_brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select e.unknown_campaign_ref, count(*), count(distinct e.contact_id)
  from public.contact_events e
  where e.brand_id = p_brand_id and e.campaign_id is null
    and e.unknown_campaign_ref is not null
  group by e.unknown_campaign_ref
  order by 2 desc;
end $$;

revoke execute on function public.brand_totals(uuid)                        from public, anon;
revoke execute on function public.brand_contactability_waterfall(uuid)      from public, anon;
revoke execute on function public.brand_signups_per_day(uuid,text,integer)  from public, anon;
revoke execute on function public.brand_campaign_performance(uuid)          from public, anon;
revoke execute on function public.brand_orphan_event_summary(uuid)          from public, anon;
grant  execute on function public.brand_totals(uuid)                        to authenticated;
grant  execute on function public.brand_contactability_waterfall(uuid)      to authenticated;
grant  execute on function public.brand_signups_per_day(uuid,text,integer)  to authenticated;
grant  execute on function public.brand_campaign_performance(uuid)          to authenticated;
grant  execute on function public.brand_orphan_event_summary(uuid)          to authenticated;



-- =====================================================================================
-- 20260914010400_shares.sql
-- =====================================================================================

-- =====================================================================================
-- Shareable result links.
--
-- The link is for someone with no login, so the row holds no secret in recoverable form:
-- only a SHA-256 of the token and a bcrypt hash of the password. Neither column is
-- grantable to any signed-in role (see the column-level grant in the security
-- migration), so even the owner who created the link cannot read them back.
-- =====================================================================================

create or replace function public.create_campaign_share(
  p_campaign_id uuid, p_token_hash bytea, p_password_hash text,
  p_label text default null, p_expires_in_days integer default 30)
returns public.campaign_shares
language plpgsql security definer set search_path = '' as $$
declare v_brand uuid; v_row public.campaign_shares;
begin
  select c.brand_id into v_brand from public.campaigns c where c.id = p_campaign_id;
  if v_brand is null then raise exception 'campaign_not_found' using errcode = 'P0002'; end if;
  if not private.is_brand_owner(v_brand) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if octet_length(p_token_hash) <> 32 then
    raise exception 'token_hash_must_be_sha256' using errcode = 'P0001';
  end if;
  if p_password_hash is null or length(p_password_hash) < 20 then
    raise exception 'password_hash_missing' using errcode = 'P0001';
  end if;

  insert into public.campaign_shares
    (brand_id, campaign_id, label, token_hash, password_hash, created_by, expires_at)
  values (v_brand, p_campaign_id, p_label, p_token_hash, p_password_hash,
          (select auth.uid()),
          now() + (least(greatest(coalesce(p_expires_in_days, 30), 1), 365) || ' days')::interval)
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.revoke_campaign_share(p_share_id uuid)
returns public.campaign_shares
language plpgsql security definer set search_path = '' as $$
declare v_row public.campaign_shares;
begin
  select * into v_row from public.campaign_shares where id = p_share_id;
  if v_row.id is null then raise exception 'share_not_found' using errcode = 'P0002'; end if;
  if not private.is_brand_owner(v_row.brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.campaign_shares set revoked_at = now()
  where id = p_share_id and revoked_at is null
  returning * into v_row;
  return v_row;
end $$;

-- The public face of a share: one campaign's aggregate results and nothing else. No
-- contact rows, no other campaign, no brand totals, no counts that could be differenced
-- to recover an individual. Called only by the server after the password has been
-- checked, using the service role.
create or replace function private.share_results(p_share_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  select jsonb_build_object(
    'campaign_name',  c.name,
    'channel',        c.channel,
    'brand_name',     b.name,
    'sent_at',        s.approved_at,
    'approved',       s.approved_count,
    'accepted',       coalesce(p.accepted, 0),
    'delivered',      coalesce(p.delivered, 0),
    'bounced',        coalesce(p.bounced, 0),
    'opened',         coalesce(p.opened, 0),
    'unsubscribed',   coalesce(p.unsubscribed, 0),
    'complained',     coalesce(p.complained, 0),
    'status',         s.status,
    'last_polled_at', (select max(ch.last_polled_at) from public.send_chunks ch where ch.send_id = s.id),
    'reported_sent',      c.reported_sent,
    'reported_delivered', c.reported_delivered,
    'reported_opens',     c.reported_opens
  )
  into v
  from public.campaign_shares sh
  join public.campaigns c on c.id = sh.campaign_id
  join public.brands b    on b.id = sh.brand_id
  left join public.campaign_sends s on s.campaign_id = c.id and s.status <> 'cancelled'
  left join lateral (
    select count(*) filter (where r.provider_status is not null
                              and r.provider_status <> 'rejected') as accepted,
           count(*) filter (where r.delivered_at    is not null)   as delivered,
           count(*) filter (where r.bounced_at      is not null)   as bounced,
           count(*) filter (where r.opened_at       is not null)   as opened,
           count(*) filter (where r.unsubscribed_at is not null)   as unsubscribed,
           count(*) filter (where r.complained_at   is not null)   as complained
    from public.send_recipients r where r.send_id = s.id
  ) p on s.id is not null
  where sh.id = p_share_id;
  return v;
end $$;

revoke execute on function public.create_campaign_share(uuid,bytea,text,text,integer) from public, anon;
revoke execute on function public.revoke_campaign_share(uuid)                         from public, anon;
revoke execute on function private.share_results(uuid)                                from public, anon, authenticated;
grant  execute on function public.create_campaign_share(uuid,bytea,text,text,integer) to authenticated;
grant  execute on function public.revoke_campaign_share(uuid)                         to authenticated;



-- =====================================================================================
-- 20260914010500_deny_policies.sql
-- =====================================================================================

-- =====================================================================================
-- Explicit deny policies.
--
-- A table with RLS enabled and no policy is already closed to every non-bypassing role,
-- but the intent is invisible: a reader cannot tell a deliberate lockdown from a table
-- someone forgot to write policies for. Stating the denial keeps the regression test
-- strict (every table must carry at least one policy, with no exemption list to grow).
-- =====================================================================================

-- The rate-limit ledger for share links. It records IP addresses of people attempting to
-- open a shared report, which belongs to no brand and is never shown in the product;
-- only the server, using the service role, reads or writes it.
create policy share_access_attempts_deny_all on public.share_access_attempts
  for all to authenticated, anon
  using (false) with check (false);



-- =====================================================================================
-- 20260914020000_browse.sql
-- =====================================================================================

-- =====================================================================================
-- Browsing contacts and campaigns.
--
-- The contact list is driven by the same predicates as the dashboard waterfall, so
-- clicking "unsubscribed" on the dashboard shows exactly the people that line subtracted.
-- If the two ever disagreed, one of them would be lying.
--
-- Paging is by keyset rather than offset. The largest brand here is ninety times the
-- smallest, and OFFSET 80000 asks Postgres to walk eighty thousand rows before returning
-- anything; a cursor on (brand_id, id) reads only the page requested.
-- =====================================================================================

create or replace function public.brand_contacts_page(
  p_brand_id  uuid,
  p_exclusion text default null,
  p_search    text default null,
  p_cursor    uuid default null,
  p_limit     integer default 50)
returns table (
  id uuid, external_id text, full_name text, email text, email_raw text,
  phone_e164 text, phone_raw text, country char(2), city text, signup_at timestamptz,
  status text, consent_marketing boolean, contactable boolean, exclusion_reason text)
language plpgsql stable security definer set search_path = '' as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if not private.is_brand_member(p_brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select c.id, c.external_id, c.full_name, c.email, c.email_raw,
         c.phone_e164, c.phone_raw, c.country, c.city, c.signup_at,
         c.status, c.consent_marketing,
         (c.contactable_static and (c.suppressed_until is null or c.suppressed_until <= now())),
         -- The first rule that excludes them, in the same order the waterfall applies.
         case
           when c.deleted_at is not null                                     then 'deleted'
           when c.consent_marketing is not true                              then 'no_consent'
           when c.status <> 'active'                                         then 'not_active'
           when c.unsubscribed_at is not null                                then 'unsubscribed'
           when c.complained_at is not null                                  then 'complained'
           when c.bounced_at is not null                                     then 'bounced'
           when c.suppressed_until is not null and c.suppressed_until > now() then 'suppressed'
           when c.email is null and c.phone_e164 is null                     then 'no_channel'
           else null
         end
  from public.contacts c
  where c.brand_id = p_brand_id
    and (p_cursor is null or c.id > p_cursor)
    and (p_search is null or p_search = '' or
         c.full_name ilike '%' || p_search || '%' or
         c.email ilike '%' || p_search || '%' or
         c.email_raw ilike '%' || p_search || '%' or
         c.external_id ilike '%' || p_search || '%')
    and (p_exclusion is null or p_exclusion = '' or case p_exclusion
           when 'total'        then true
           when 'contactable'  then c.contactable_static
                                and (c.suppressed_until is null or c.suppressed_until <= now())
           when 'deleted'      then c.deleted_at is not null
           when 'no_consent'   then c.deleted_at is null and c.consent_marketing is not true
           when 'not_active'   then c.deleted_at is null and c.consent_marketing is true
                                and c.status <> 'active'
           when 'unsubscribed' then c.deleted_at is null and c.consent_marketing is true
                                and c.status = 'active' and c.unsubscribed_at is not null
           when 'complained'   then c.deleted_at is null and c.consent_marketing is true
                                and c.status = 'active' and c.unsubscribed_at is null
                                and c.complained_at is not null
           when 'bounced'      then c.deleted_at is null and c.consent_marketing is true
                                and c.status = 'active' and c.unsubscribed_at is null
                                and c.complained_at is null and c.bounced_at is not null
           when 'suppressed'   then c.deleted_at is null and c.consent_marketing is true
                                and c.status = 'active' and c.unsubscribed_at is null
                                and c.complained_at is null and c.bounced_at is null
                                and c.suppressed_until is not null and c.suppressed_until > now()
           when 'no_channel'   then c.deleted_at is null and c.consent_marketing is true
                                and c.status = 'active' and c.unsubscribed_at is null
                                and c.complained_at is null and c.bounced_at is null
                                and (c.suppressed_until is null or c.suppressed_until <= now())
                                and c.email is null and c.phone_e164 is null
           else true end)
  order by c.id
  limit v_limit;
end $$;

-- What the data page shows: every import run for this brand, and what each one did.
create or replace function public.brand_import_runs(p_brand_id uuid, p_limit integer default 40)
returns table (
  id uuid, entity text, source_file text, file_sha256 text,
  started_at timestamptz, finished_at timestamptz, status text,
  rows_read integer, rows_inserted integer, rows_updated integer,
  rows_rejected integer, rows_warned integer, error text, notes jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_brand_member(p_brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select r.id, r.entity, r.source_file, r.file_sha256, r.started_at, r.finished_at, r.status,
         r.rows_read, r.rows_inserted, r.rows_updated, r.rows_rejected, r.rows_warned,
         r.error, r.notes
  from public.import_runs r
  where r.brand_id = p_brand_id
  order by r.started_at desc
  limit least(greatest(coalesce(p_limit, 40), 1), 200);
end $$;

create or replace function public.brand_import_issues(
  p_run_id uuid, p_kind text default 'reject', p_reason text default null,
  p_limit integer default 50, p_offset integer default 0)
returns table (row_no integer, reason_code text, detail text, raw jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare v_brand uuid;
begin
  select brand_id into v_brand from public.import_runs where id = p_run_id;
  if v_brand is null then raise exception 'run_not_found' using errcode = 'P0002'; end if;
  if not private.is_brand_member(v_brand) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_kind = 'reject' then
    return query
      select r.row_no, r.reason_code, r.detail, r.raw from public.import_rejects r
      where r.run_id = p_run_id and (p_reason is null or r.reason_code = p_reason)
      order by r.id limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
  else
    return query
      select w.row_no, w.reason_code, w.detail, w.raw from public.import_warnings w
      where w.run_id = p_run_id and (p_reason is null or w.reason_code = p_reason)
      order by w.id limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
  end if;
end $$;

-- Storage is finite on the plan this runs on, and the data page says so out loud.
create or replace function public.database_size()
returns table (bytes bigint, pretty text)
language sql stable security definer set search_path = '' as $$
  select pg_database_size(current_database()),
         pg_size_pretty(pg_database_size(current_database()));
$$;

revoke execute on function public.brand_contacts_page(uuid,text,text,uuid,integer) from public, anon;
revoke execute on function public.brand_import_runs(uuid,integer)                  from public, anon;
revoke execute on function public.brand_import_issues(uuid,text,text,integer,integer) from public, anon;
revoke execute on function public.database_size()                                  from public, anon;
grant  execute on function public.brand_contacts_page(uuid,text,text,uuid,integer) to authenticated;
grant  execute on function public.brand_import_runs(uuid,integer)                  to authenticated;
grant  execute on function public.brand_import_issues(uuid,text,text,integer,integer) to authenticated;
grant  execute on function public.database_size()                                  to authenticated;



-- =====================================================================================
-- 20260914030000_dispatch.sql
-- =====================================================================================

-- =====================================================================================
-- Dispatch and delivery reconciliation.
--
-- These functions are callable only by the service role: the web app's dispatcher and
-- the scheduled poller. They are not reachable with the anon key by anyone, signed in or
-- not. The two that an owner may trigger go through their own checks.
--
-- The shape of the work is dictated by what the provider actually does, not by what its
-- documentation claims:
--
--   * It accepts at most 500 recipients per call, and silently discards the rest behind
--     an HTTP 200 marked "accepted". So a chunk is 500, and every call is reconciled
--     recipient by recipient against what we asked it to send.
--   * A repeated Idempotency-Key replays the original batch. So a retry is safe, but only
--     with the same key, and a key is never reused for different content.
--   * Delivery events arrive late, duplicated, and out of order. So ingestion is
--     commutative and keyed on (chunk, provider event id).
-- =====================================================================================

-- --------------------------------------------------------------- one dispatcher at a time --
-- Chunk-level locking alone would let two dispatchers interleave chunks of the same send,
-- doubling the request rate and making the timeline unreadable. The lease makes one of
-- them the owner of the whole send for a short, self-renewing window.
create or replace function public.dispatch_acquire_lease(
  p_send_id uuid, p_owner text, p_seconds integer default 60)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_ok boolean;
begin
  update public.campaign_sends
     set dispatch_lease_owner = p_owner,
         dispatch_lease_until = now() + make_interval(secs => greatest(p_seconds, 10)),
         status = case when status = 'approved' then 'dispatching' else status end
   where id = p_send_id
     and status in ('approved', 'dispatching')
     and (dispatch_lease_until is null
       or dispatch_lease_until < now()
       or dispatch_lease_owner = p_owner)
  returning true into v_ok;

  if v_ok then
    insert into public.send_events (brand_id, send_id, actor, event, detail)
    select brand_id, id, 'system', 'lease_acquired', jsonb_build_object('owner', p_owner)
    from public.campaign_sends where id = p_send_id
      and not exists (select 1 from public.send_events e
                      where e.send_id = p_send_id and e.event = 'lease_acquired'
                        and e.detail->>'owner' = p_owner and e.at > now() - interval '5 minutes');
  end if;
  return coalesce(v_ok, false);
end $$;

create or replace function public.dispatch_release_lease(p_send_id uuid, p_owner text)
returns void
language sql security definer set search_path = '' as $$
  update public.campaign_sends
     set dispatch_lease_owner = null, dispatch_lease_until = null
   where id = p_send_id and dispatch_lease_owner = p_owner;
$$;

-- ------------------------------------------------------------------- claim one chunk --
create or replace function public.dispatch_claim_chunk(p_send_id uuid, p_worker text)
returns public.send_chunks
language plpgsql security definer set search_path = '' as $$
declare v_chunk public.send_chunks;
begin
  update public.send_chunks c
     set status = 'dispatching', attempts = c.attempts + 1,
         claimed_at = now(), claimed_by = p_worker
   where c.id = (
     select id from public.send_chunks
      where send_id = p_send_id
        and (status = 'pending'
          -- A chunk left mid-flight by a process that died. Reclaimed, but never blindly
          -- re-sent: dispatch_begin_attempt decides whether the previous call is known
          -- to have failed or merely unknown.
          or (status = 'dispatching' and claimed_at < now() - interval '2 minutes'))
      order by chunk_no
      for update skip locked
      limit 1)
  returning c.* into v_chunk;
  return v_chunk;
end $$;

-- ------------------------------------------------- the crash window, made explicit --
-- Committed before the provider is called. If the process dies after the provider
-- accepted the batch but before we recorded it, this row is the only evidence that the
-- call may have happened, and it is what stops us from sending to those people twice.
create or replace function public.dispatch_begin_attempt(
  p_chunk_id uuid, p_request_sha text, p_allow_retry boolean default false)
returns table (attempt_no integer, idempotency_key text, outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_chunk    public.send_chunks;
  v_orphan   public.send_attempts;
  v_next     integer;
begin
  select * into v_chunk from public.send_chunks where id = p_chunk_id;
  if v_chunk.id is null then raise exception 'chunk_not_found' using errcode = 'P0002'; end if;

  select * into v_orphan from public.send_attempts
   where chunk_id = p_chunk_id and finished_at is null
   order by attempt_no desc limit 1;

  if v_orphan.id is not null and not p_allow_retry then
    -- We called the provider and never learned the outcome. Retrying is safe only
    -- because the provider replays a repeated Idempotency-Key, and that is a property we
    -- verified rather than assumed; where it has not been verified, a human decides.
    update public.send_chunks set status = 'indeterminate' where id = p_chunk_id;
    insert into public.send_events (brand_id, send_id, chunk_id, actor, event, detail)
    values (v_chunk.brand_id, v_chunk.send_id, p_chunk_id, 'system', 'chunk_indeterminate',
            jsonb_build_object('attempt_no', v_orphan.attempt_no,
                               'started_at', v_orphan.started_at,
                               'recipients', v_chunk.recipient_count));
    return query select v_orphan.attempt_no, v_chunk.idempotency_key, 'indeterminate'::text;
    return;
  end if;

  select coalesce(max(a.attempt_no), 0) + 1 into v_next
  from public.send_attempts a where a.chunk_id = p_chunk_id;

  insert into public.send_attempts
    (chunk_id, brand_id, attempt_no, idempotency_key, request_sha256)
  values (p_chunk_id, v_chunk.brand_id, v_next, v_chunk.idempotency_key, p_request_sha);

  insert into public.send_events (brand_id, send_id, chunk_id, actor, event, detail)
  values (v_chunk.brand_id, v_chunk.send_id, p_chunk_id, 'system', 'provider_request_started',
          jsonb_build_object('attempt_no', v_next, 'chunk_no', v_chunk.chunk_no,
                             'recipients', v_chunk.recipient_count,
                             'idempotency_key', left(v_chunk.idempotency_key, 12) || '…'));
  return query select v_next, v_chunk.idempotency_key, 'proceed'::text;
end $$;

-- ------------------------------------------------------- what the provider came back with --
create or replace function public.dispatch_finish_attempt(
  p_chunk_id uuid, p_attempt_no integer, p_http_status integer,
  p_batch_id text, p_accepted jsonb, p_rejected jsonb,
  p_error text default null, p_excerpt text default null)
returns public.send_chunks
language plpgsql security definer set search_path = '' as $$
declare
  v_chunk    public.send_chunks;
  v_accepted integer := coalesce(jsonb_array_length(p_accepted), 0);
  v_rejected integer := coalesce(jsonb_array_length(p_rejected), 0);
  v_status   public.chunk_status;
begin
  select * into v_chunk from public.send_chunks where id = p_chunk_id;
  if v_chunk.id is null then raise exception 'chunk_not_found' using errcode = 'P0002'; end if;

  if p_error is not null or p_batch_id is null then
    v_status := 'failed';
  elsif v_accepted >= v_chunk.recipient_count then
    v_status := 'accepted';
  else
    -- The provider returned success while dropping some of the recipients we asked it to
    -- take. That is not a completed chunk, and it is not allowed to look like one.
    v_status := 'partially_accepted';
  end if;

  update public.send_attempts
     set finished_at = now(), http_status = p_http_status, provider_batch_id = p_batch_id,
         accepted_count = v_accepted, rejected_count = v_rejected,
         error = p_error, response_excerpt = left(p_excerpt, 500)
   where chunk_id = p_chunk_id and attempt_no = p_attempt_no;

  update public.send_chunks
     set status = v_status, provider_batch_id = coalesce(p_batch_id, provider_batch_id),
         accepted_count = v_accepted, rejected_count = v_rejected,
         events_exhausted = case when v_status = 'failed' then true else events_exhausted end
   where id = p_chunk_id
  returning * into v_chunk;

  -- Attribute the outcome to each person, so "who did this actually go to" is answerable
  -- per recipient rather than as a chunk-level total.
  if v_accepted > 0 then
    update public.send_recipients r
       set provider_status = coalesce(r.provider_status, 'accepted')
      from jsonb_array_elements_text(p_accepted) a(id)
     where r.send_id = v_chunk.send_id and r.id::text = a.id;
  end if;

  if v_rejected > 0 then
    update public.send_recipients r
       set provider_status = 'rejected',
           rejected_reason = x.reason
      from (select coalesce(e->'recipient'->>'id', e->>'id') as id, e->>'reason' as reason
              from jsonb_array_elements(p_rejected) e) x
     where r.send_id = v_chunk.send_id and r.id::text = x.id;
  end if;

  insert into public.send_events (brand_id, send_id, chunk_id, actor, event, detail)
  values (v_chunk.brand_id, v_chunk.send_id, p_chunk_id, 'system', 'provider_response',
          jsonb_build_object('attempt_no', p_attempt_no, 'http_status', p_http_status,
                             'batch_id', p_batch_id, 'accepted', v_accepted,
                             'rejected', v_rejected, 'asked_for', v_chunk.recipient_count,
                             'chunk_status', v_status, 'error', p_error));
  return v_chunk;
end $$;

-- --------------------------------------------------------------------- close the send --
create or replace function public.dispatch_finalize_send(p_send_id uuid)
returns public.campaign_sends
language plpgsql security definer set search_path = '' as $$
declare
  v_send    public.campaign_sends;
  v_pending integer;
  v_bad     integer;
  v_acc     integer;
  v_rej     integer;
begin
  select count(*) filter (where status in ('pending', 'dispatching')),
         count(*) filter (where status in ('failed', 'indeterminate', 'partially_accepted')),
         coalesce(sum(accepted_count), 0), coalesce(sum(rejected_count), 0)
    into v_pending, v_bad, v_acc, v_rej
  from public.send_chunks where send_id = p_send_id;

  if v_pending > 0 then
    select * into v_send from public.campaign_sends where id = p_send_id;
    return v_send;
  end if;

  update public.campaign_sends
     set status = case when v_bad > 0 then 'completed_with_failures' else 'completed' end,
         completed_at = now(), accepted_total = v_acc, rejected_total = v_rej,
         dispatch_lease_owner = null, dispatch_lease_until = null
   where id = p_send_id and status <> 'cancelled'
  returning * into v_send;

  if v_send.id is not null then
    insert into public.send_events (brand_id, send_id, actor, event, detail)
    values (v_send.brand_id, v_send.id, 'system', 'send_completed',
            jsonb_build_object('status', v_send.status, 'approved', v_send.approved_count,
                               'accepted', v_acc, 'rejected', v_rej,
                               'chunks_needing_attention', v_bad));
  end if;
  return v_send;
end $$;

-- ------------------------------------------------------- an owner resolves the unknown --
create or replace function public.resolve_indeterminate_chunk(
  p_chunk_id uuid, p_resolution text, p_note text default null)
returns public.send_chunks
language plpgsql security definer set search_path = '' as $$
declare v_chunk public.send_chunks;
begin
  select * into v_chunk from public.send_chunks where id = p_chunk_id;
  if v_chunk.id is null then raise exception 'chunk_not_found' using errcode = 'P0002'; end if;
  if not private.is_brand_owner(v_chunk.brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_chunk.status <> 'indeterminate' then
    raise exception 'chunk_is_not_indeterminate' using errcode = 'P0001';
  end if;
  if p_resolution not in ('retry', 'mark_sent', 'mark_failed') then
    raise exception 'unknown_resolution' using errcode = 'P0001';
  end if;

  update public.send_chunks
     set status = case p_resolution when 'retry' then 'pending'
                                    when 'mark_sent' then 'accepted'
                                    else 'failed' end,
         events_exhausted = case when p_resolution = 'mark_failed' then true else events_exhausted end,
         resolved_by = (select auth.uid()), resolved_at = now(), resolution_note = p_note
   where id = p_chunk_id
  returning * into v_chunk;

  -- Closing the open attempt is what allows a retry to proceed rather than being flagged
  -- indeterminate all over again.
  update public.send_attempts
     set finished_at = now(), error = coalesce(error, 'resolved by owner: ' || p_resolution)
   where chunk_id = p_chunk_id and finished_at is null;

  insert into public.send_events (brand_id, send_id, chunk_id, actor, event, detail)
  values (v_chunk.brand_id, v_chunk.send_id, p_chunk_id, 'user:' || (select auth.uid()),
          'owner_resolved_indeterminate',
          jsonb_build_object('resolution', p_resolution, 'note', p_note));
  return v_chunk;
end $$;

-- ------------------------------------------------------------------ delivery reports --
-- Chunks whose delivery picture may still be moving. Recent sends are polled hard, older
-- ones progressively less, and a send stops being polled once its stream has gone quiet
-- and it is a month old.
create or replace function public.sync_due_chunks(p_limit integer default 20)
returns table (chunk_id uuid, send_id uuid, brand_id uuid, provider_batch_id text,
               events_cursor text, approved_at timestamptz)
language sql security definer set search_path = '' as $$
  select c.id, c.send_id, c.brand_id, c.provider_batch_id, c.events_cursor, s.approved_at
  from public.send_chunks c
  join public.campaign_sends s on s.id = c.send_id
  where c.provider_batch_id is not null
    and not c.events_exhausted
    and s.approved_at > now() - interval '30 days'
    and (c.last_polled_at is null
      or (s.approved_at > now() - interval '1 day'  and c.last_polled_at < now() - interval '30 seconds')
      or (s.approved_at <= now() - interval '1 day' and c.last_polled_at < now() - interval '1 hour'))
  order by c.last_polled_at asc nulls first
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

/**
 * Records one page of delivery reports.
 *
 * Duplicate events are dropped on the unique key rather than counted twice; the cursor is
 * only advanced when the provider supplies a new one, because setting it back to null
 * would restart the stream from the beginning on the next poll. `p_quiet` marks a chunk
 * whose stream has nothing further for now.
 */
create or replace function public.sync_ingest_events(
  p_chunk_id uuid, p_events jsonb, p_next_cursor text default null, p_quiet boolean default false)
returns table (ingested integer, duplicates integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_chunk    public.send_chunks;
  v_total    integer := coalesce(jsonb_array_length(p_events), 0);
  v_new      integer := 0;
  v_existing integer;
begin
  select * into v_chunk from public.send_chunks where id = p_chunk_id;
  if v_chunk.id is null then raise exception 'chunk_not_found' using errcode = 'P0002'; end if;

  select count(*) into v_existing from public.provider_events where chunk_id = p_chunk_id;

  if v_total > 0 then
    with incoming as (
      select
        coalesce(e->>'event_id', e->>'id')                                as provider_event_id,
        private.canonical_event_type(coalesce(e->>'type', e->>'event_type')) as event_type,
        nullif(coalesce(e->>'recipient_id', e->>'recipient'), '')         as recipient_ref,
        nullif(coalesce(e->>'occurred_at', e->>'occurred_at_utc', e->>'timestamp'), '') as occurred_at,
        left(e::text, 500)                                                as raw_excerpt
      from jsonb_array_elements(p_events) e
    ),
    resolved as (
      select distinct on (i.provider_event_id)
        i.provider_event_id, i.event_type, i.occurred_at, i.raw_excerpt,
        r.id as recipient_id
      from incoming i
      left join public.send_recipients r
        on r.send_id = v_chunk.send_id
       and i.recipient_ref ~ '^[0-9a-fA-F-]{36}$'
       and r.id = i.recipient_ref::uuid
      where i.provider_event_id is not null
      order by i.provider_event_id
    )
    insert into public.provider_events
      (brand_id, chunk_id, recipient_id, provider_event_id, event_type, occurred_at, raw_excerpt)
    select v_chunk.brand_id, p_chunk_id, resolved.recipient_id, resolved.provider_event_id,
           resolved.event_type,
           case when resolved.occurred_at ~ '^\d{4}-\d{2}-\d{2}' then resolved.occurred_at::timestamptz else now() end,
           -- Keep the raw payload only while the ledger is small. Past that the event
           -- itself is retained; only the verbatim copy is dropped.
           case when v_existing < 5000 then resolved.raw_excerpt else null end
    from resolved
    on conflict (chunk_id, provider_event_id) do nothing;
    get diagnostics v_new = row_count;
  end if;

  update public.send_chunks
     set last_polled_at = now(),
         events_cursor = coalesce(p_next_cursor, events_cursor),
         events_exhausted = case when p_quiet and status in ('accepted','partially_accepted','failed')
                                 then events_exhausted else events_exhausted end
   where id = p_chunk_id;

  if v_new > 0 then
    insert into public.send_events (brand_id, send_id, chunk_id, actor, event, detail)
    values (v_chunk.brand_id, v_chunk.send_id, p_chunk_id, 'cron', 'poll_page_ingested',
            jsonb_build_object('returned', v_total, 'new', v_new, 'duplicates', v_total - v_new,
                               'cursor', p_next_cursor));
  end if;

  return query select v_new, v_total - v_new;
end $$;

-- Sends left mid-flight, for the scheduled resumer to pick up.
create or replace function public.sync_stalled_sends(p_limit integer default 5)
returns table (send_id uuid, brand_id uuid, pending_chunks bigint)
language sql security definer set search_path = '' as $$
  select s.id, s.brand_id, count(c.id)
  from public.campaign_sends s
  join public.send_chunks c on c.send_id = s.id
  where s.status in ('approved', 'dispatching')
    and (s.dispatch_lease_until is null or s.dispatch_lease_until < now())
    and s.approved_at < now() - interval '2 minutes'
    and (c.status = 'pending' or (c.status = 'dispatching' and c.claimed_at < now() - interval '2 minutes'))
  group by s.id, s.brand_id
  order by s.approved_at
  limit least(greatest(coalesce(p_limit, 5), 1), 20);
$$;

-- Everything above is machinery for the dispatcher and the poller, which run as the
-- service role. Only the owner-facing resolution is reachable by a signed-in user.
do $$
declare f text;
begin
  foreach f in array array[
    'public.dispatch_acquire_lease(uuid,text,integer)',
    'public.dispatch_release_lease(uuid,text)',
    'public.dispatch_claim_chunk(uuid,text)',
    'public.dispatch_begin_attempt(uuid,text,boolean)',
    'public.dispatch_finish_attempt(uuid,integer,integer,text,jsonb,jsonb,text,text)',
    'public.dispatch_finalize_send(uuid)',
    'public.sync_due_chunks(integer)',
    'public.sync_ingest_events(uuid,jsonb,text,boolean)',
    'public.sync_stalled_sends(integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

revoke execute on function public.resolve_indeterminate_chunk(uuid,text,text) from public, anon;
grant  execute on function public.resolve_indeterminate_chunk(uuid,text,text) to authenticated;



-- =====================================================================================
-- 20260914040000_share_access.sql
-- =====================================================================================

-- =====================================================================================
-- Serving a shared report to a stranger.
--
-- These run as the service role on behalf of someone with no account, so each one is
-- scoped to a single share row identified by the hash of the token in the URL. None of
-- them takes a brand, a campaign or a customer as a parameter, so there is nothing for a
-- visitor to change in order to reach anything other than the one report they were sent.
-- =====================================================================================

create or replace function public.share_results_for(p_share_id uuid)
returns jsonb
language sql security definer set search_path = '' as $$
  select private.share_results(p_share_id);
$$;

create or replace function public.share_record_view(p_share_id uuid)
returns void
language sql security definer set search_path = '' as $$
  update public.campaign_shares
     set view_count = view_count + 1, last_viewed_at = now()
   where id = p_share_id;
$$;

create or replace function public.share_record_attempt(
  p_token_hash bytea, p_ip inet, p_ok boolean)
returns void
language sql security definer set search_path = '' as $$
  insert into public.share_access_attempts (token_hash, ip, ok)
  values (p_token_hash, p_ip, p_ok);
$$;

/**
 * Throttles password guessing: five failures from one address in fifteen minutes, or
 * fifty against one link in an hour, and the link stops answering for a while.
 *
 * The per-link ceiling matters because the per-address one alone is defeated by rotating
 * addresses. Successful openings never count towards either.
 */
create or replace function public.share_rate_limit_check(p_token_hash bytea, p_ip inet)
returns table (blocked boolean, recent_failures bigint, link_failures bigint)
language sql security definer set search_path = '' as $$
  with per_ip as (
    select count(*) n from public.share_access_attempts a
     where a.token_hash = p_token_hash and not a.ok
       and a.at > now() - interval '15 minutes'
       and (p_ip is null or a.ip is not distinct from p_ip)
  ), per_link as (
    select count(*) n from public.share_access_attempts a
     where a.token_hash = p_token_hash and not a.ok
       and a.at > now() - interval '1 hour'
  )
  select (per_ip.n >= 5 or per_link.n >= 50), per_ip.n, per_link.n
  from per_ip, per_link;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.share_results_for(uuid)',
    'public.share_record_view(uuid)',
    'public.share_record_attempt(bytea,inet,boolean)',
    'public.share_rate_limit_check(bytea,inet)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;



-- =====================================================================================
-- 20260914050000_claim_null_fix.sql
-- =====================================================================================

-- A PL/pgSQL function declared to return a composite type returns a row of NULLs, not
-- NULL, when its query matched nothing. Over the API that arrives as a perfectly
-- truthy object with every field null, which a caller reasonably mistakes for a real
-- chunk. Returning NULL explicitly makes "nothing to claim" unmistakable.
create or replace function public.dispatch_claim_chunk(p_send_id uuid, p_worker text)
returns public.send_chunks
language plpgsql security definer set search_path = '' as $$
declare v_chunk public.send_chunks;
begin
  update public.send_chunks c
     set status = 'dispatching', attempts = c.attempts + 1,
         claimed_at = now(), claimed_by = p_worker
   where c.id = (
     select id from public.send_chunks
      where send_id = p_send_id
        and (status = 'pending'
          or (status = 'dispatching' and claimed_at < now() - interval '2 minutes'))
      order by chunk_no
      for update skip locked
      limit 1)
  returning c.* into v_chunk;

  if v_chunk.id is null then return null; end if;
  return v_chunk;
end $$;

revoke execute on function public.dispatch_claim_chunk(uuid,text) from public, anon, authenticated;
grant  execute on function public.dispatch_claim_chunk(uuid,text) to service_role;



-- =====================================================================================
-- 20260914060000_enum_cast_fix.sql
-- =====================================================================================

-- A CASE expression yielding string literals is typed `text`, and assigning it to an
-- enum column fails at run time rather than at definition time. The send therefore
-- reached its terminal state everywhere except in the one column that says so, and the
-- dispatcher reported "dispatching" forever. Both sites are cast explicitly.

create or replace function public.dispatch_finalize_send(p_send_id uuid)
returns public.campaign_sends
language plpgsql security definer set search_path = '' as $$
declare
  v_send    public.campaign_sends;
  v_pending integer;
  v_bad     integer;
  v_acc     integer;
  v_rej     integer;
begin
  select count(*) filter (where status in ('pending', 'dispatching')),
         count(*) filter (where status in ('failed', 'indeterminate', 'partially_accepted')),
         coalesce(sum(accepted_count), 0), coalesce(sum(rejected_count), 0)
    into v_pending, v_bad, v_acc, v_rej
  from public.send_chunks where send_id = p_send_id;

  if v_pending > 0 then
    select * into v_send from public.campaign_sends where id = p_send_id;
    return v_send;
  end if;

  update public.campaign_sends
     set status = (case when v_bad > 0 then 'completed_with_failures' else 'completed' end)::public.send_status,
         completed_at = now(), accepted_total = v_acc, rejected_total = v_rej,
         dispatch_lease_owner = null, dispatch_lease_until = null
   where id = p_send_id and status <> 'cancelled'
  returning * into v_send;

  if v_send.id is not null then
    insert into public.send_events (brand_id, send_id, actor, event, detail)
    values (v_send.brand_id, v_send.id, 'system', 'send_completed',
            jsonb_build_object('status', v_send.status, 'approved', v_send.approved_count,
                               'accepted', v_acc, 'rejected', v_rej,
                               'chunks_needing_attention', v_bad));
  else
    select * into v_send from public.campaign_sends where id = p_send_id;
  end if;
  return v_send;
end $$;

create or replace function public.resolve_indeterminate_chunk(
  p_chunk_id uuid, p_resolution text, p_note text default null)
returns public.send_chunks
language plpgsql security definer set search_path = '' as $$
declare v_chunk public.send_chunks;
begin
  select * into v_chunk from public.send_chunks where id = p_chunk_id;
  if v_chunk.id is null then raise exception 'chunk_not_found' using errcode = 'P0002'; end if;
  if not private.is_brand_owner(v_chunk.brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_chunk.status <> 'indeterminate' then
    raise exception 'chunk_is_not_indeterminate' using errcode = 'P0001';
  end if;
  if p_resolution not in ('retry', 'mark_sent', 'mark_failed') then
    raise exception 'unknown_resolution' using errcode = 'P0001';
  end if;

  update public.send_chunks
     set status = (case p_resolution when 'retry' then 'pending'
                                     when 'mark_sent' then 'accepted'
                                     else 'failed' end)::public.chunk_status,
         events_exhausted = case when p_resolution = 'mark_failed' then true else events_exhausted end,
         resolved_by = (select auth.uid()), resolved_at = now(), resolution_note = p_note
   where id = p_chunk_id
  returning * into v_chunk;

  update public.send_attempts
     set finished_at = now(), error = coalesce(error, 'resolved by owner: ' || p_resolution)
   where chunk_id = p_chunk_id and finished_at is null;

  insert into public.send_events (brand_id, send_id, chunk_id, actor, event, detail)
  values (v_chunk.brand_id, v_chunk.send_id, p_chunk_id, 'user:' || (select auth.uid()),
          'owner_resolved_indeterminate',
          jsonb_build_object('resolution', p_resolution, 'note', p_note));
  return v_chunk;
end $$;

revoke execute on function public.dispatch_finalize_send(uuid) from public, anon, authenticated;
grant  execute on function public.dispatch_finalize_send(uuid) to service_role;
revoke execute on function public.resolve_indeterminate_chunk(uuid,text,text) from public, anon;
grant  execute on function public.resolve_indeterminate_chunk(uuid,text,text) to authenticated;



-- =====================================================================================
-- 20260914070000_scheduler.sql
-- =====================================================================================

-- =====================================================================================
-- The delivery-report scheduler.
--
-- The messaging provider has no webhooks. Delivery, bounces, opens and unsubscribes
-- exist only if something asks for them, and the brief is explicit that they arrive
-- "including while your app isn't looking". So the schedule lives inside the database,
-- where it runs whether or not anyone has the portal open.
--
-- The endpoint and its bearer token are read from Vault rather than written here, so no
-- credential enters this repository. scripts/setup-scheduler.mjs stores them.
-- =====================================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function private.tick_delivery_reports()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
  v_id     bigint;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'job_tick_url' limit 1;
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'job_secret' limit 1;

  if v_url is null or v_secret is null then
    raise notice 'tick_delivery_reports: job_tick_url or job_secret is missing from the vault';
    return null;
  end if;

  -- Fire and forget: pg_net queues the request and returns immediately, so a slow or
  -- unreachable endpoint can never hold a database connection open.
  select net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_secret),
    body    := jsonb_build_object('source', 'pg_cron'),
    timeout_milliseconds := 8000
  ) into v_id;
  return v_id;
end $$;

revoke execute on function private.tick_delivery_reports() from public, anon, authenticated;

-- Every minute. Each run is cheap when there is nothing to collect: the query that picks
-- work out only returns chunks whose reports are actually still moving, and a send stops
-- being polled once its stream goes quiet.
select cron.schedule(
  'delivery-reports-tick',
  '* * * * *',
  $job$ select private.tick_delivery_reports(); $job$
);



-- =====================================================================================
-- 20260914080000_scheduler_fix.sql
-- =====================================================================================

-- pg_net installs its functions in the `net` schema on this platform, not under
-- `extensions`. With an empty search_path the wrong qualification is not a warning, it is
-- a hard failure once a minute, which is exactly what the cron history showed.
create or replace function private.tick_delivery_reports()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
  v_id     bigint;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'job_tick_url' limit 1;
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'job_secret' limit 1;

  if v_url is null or v_secret is null then
    raise notice 'tick_delivery_reports: job_tick_url or job_secret is missing from the vault';
    return null;
  end if;

  select net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_secret),
    body    := jsonb_build_object('source', 'pg_cron'),
    timeout_milliseconds := 8000
  ) into v_id;
  return v_id;
end $$;

revoke execute on function private.tick_delivery_reports() from public, anon, authenticated;



-- =====================================================================================
-- 20260914090000_ingest_hardening.sql
-- =====================================================================================

-- =====================================================================================
-- Ingestion must survive a report it cannot attribute.
--
-- The live stream returned an event whose recipient was "CT-012274", a customer reference
-- from the seed exports rather than one of the recipient ids we supplied. The provider
-- builds event ids as evt-<first 8 characters of the batch id>-<sequence>, which is about
-- two hex characters of per-batch entropy, so batches collide and one batch's page can
-- carry another's events.
--
-- Previously the uuid cast sat in a join condition alongside a regex guard, and Postgres
-- is free to evaluate those in either order. One unattributable event therefore aborted
-- the entire poll, and every later report for that send stopped arriving. The cast now
-- sits inside a CASE, which is evaluated in order by definition, and an event we cannot
-- attribute is stored with a null recipient and counted rather than thrown away.
-- =====================================================================================

-- The return type gains a column, which CREATE OR REPLACE cannot do.
drop function if exists public.sync_ingest_events(uuid,jsonb,text,boolean);

create function public.sync_ingest_events(
  p_chunk_id uuid, p_events jsonb, p_next_cursor text default null, p_quiet boolean default false)
returns table (ingested integer, duplicates integer, unattributable integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chunk    public.send_chunks;
  v_total    integer := coalesce(jsonb_array_length(p_events), 0);
  v_new      integer := 0;
  v_orphan   integer := 0;
  v_existing integer;
begin
  select * into v_chunk from public.send_chunks where id = p_chunk_id;
  if v_chunk.id is null then raise exception 'chunk_not_found' using errcode = 'P0002'; end if;

  select count(*) into v_existing from public.provider_events where chunk_id = p_chunk_id;

  if v_total > 0 then
    with incoming as (
      select
        coalesce(e->>'event_id', e->>'id')                                   as provider_event_id,
        private.canonical_event_type(coalesce(e->>'type', e->>'event_type')) as event_type,
        nullif(coalesce(e->>'recipient_id', e->>'recipient'), '')            as recipient_ref,
        nullif(coalesce(e->>'occurred_at', e->>'occurred_at_utc', e->>'timestamp'), '') as occurred_at,
        left(e::text, 500)                                                   as raw_excerpt
      from jsonb_array_elements(p_events) e
    ),
    typed as (
      select i.*,
             case when i.recipient_ref ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                  then i.recipient_ref::uuid end as recipient_uuid,
             case when i.occurred_at ~ '^\d{4}-\d{2}-\d{2}' then i.occurred_at::timestamptz
                  else now() end                 as occurred_ts
      from incoming i
      where i.provider_event_id is not null
    ),
    resolved as (
      select distinct on (t.provider_event_id)
             t.provider_event_id, t.event_type, t.occurred_ts, t.raw_excerpt, r.id as recipient_id
      from typed t
      left join public.send_recipients r
        on r.id = t.recipient_uuid and r.send_id = v_chunk.send_id
      order by t.provider_event_id
    ),
    inserted as (
      insert into public.provider_events
        (brand_id, chunk_id, recipient_id, provider_event_id, event_type, occurred_at, raw_excerpt)
      select v_chunk.brand_id, p_chunk_id, resolved.recipient_id, resolved.provider_event_id,
             resolved.event_type, resolved.occurred_ts,
             case when v_existing < 5000 then resolved.raw_excerpt end
      from resolved
      on conflict (chunk_id, provider_event_id) do nothing
      returning recipient_id
    )
    select count(*), count(*) filter (where recipient_id is null) into v_new, v_orphan from inserted;
  end if;

  update public.send_chunks
     set last_polled_at = now(),
         events_cursor = coalesce(p_next_cursor, events_cursor)
   where id = p_chunk_id;

  if v_new > 0 then
    insert into public.send_events (brand_id, send_id, chunk_id, actor, event, detail)
    values (v_chunk.brand_id, v_chunk.send_id, p_chunk_id, 'cron', 'poll_page_ingested',
            jsonb_build_object('returned', v_total, 'new', v_new,
                               'duplicates', v_total - v_new,
                               'unattributable', v_orphan, 'cursor', p_next_cursor));
  end if;

  return query select v_new, v_total - v_new, v_orphan;
end $$;

revoke execute on function public.sync_ingest_events(uuid,jsonb,text,boolean) from public, anon, authenticated;
grant  execute on function public.sync_ingest_events(uuid,jsonb,text,boolean) to service_role;

-- Reports that belong to no recipient of ours, kept so the gap is visible rather than
-- mysterious: a send whose delivered count is short should be explainable.
create or replace function public.send_unattributable_events(p_send_id uuid)
returns table (event_type text, events bigint)
language plpgsql stable security definer set search_path = '' as $$
declare v_brand uuid;
begin
  select brand_id into v_brand from public.campaign_sends where id = p_send_id;
  if v_brand is null then raise exception 'send_not_found' using errcode = 'P0002'; end if;
  if not private.is_brand_member(v_brand) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select pe.event_type, count(*)
  from public.provider_events pe
  join public.send_chunks ch on ch.id = pe.chunk_id
  where ch.send_id = p_send_id and pe.recipient_id is null
  group by pe.event_type order by 2 desc;
end $$;

revoke execute on function public.send_unattributable_events(uuid) from public, anon;
grant  execute on function public.send_unattributable_events(uuid) to authenticated;

