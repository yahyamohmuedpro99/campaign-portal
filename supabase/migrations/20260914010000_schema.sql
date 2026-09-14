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
