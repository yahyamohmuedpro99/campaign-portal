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
