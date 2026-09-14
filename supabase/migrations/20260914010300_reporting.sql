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
