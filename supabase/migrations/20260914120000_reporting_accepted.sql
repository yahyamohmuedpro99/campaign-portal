-- provider_status is now derived and always has a value, so "has a status" no longer
-- means "the provider took it". Accepted is read from the timestamp the dispatcher
-- records, which is what the word actually means.

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
    from public.contact_events e where e.campaign_id = c.id
  ) o on true
  left join public.campaign_sends s on s.campaign_id = c.id and s.status <> 'cancelled'
  left join lateral (
    select
      count(*) filter (where r.accepted_at     is not null) as accepted,
      count(*) filter (where r.delivered_at    is not null) as delivered,
      count(*) filter (where r.bounced_at      is not null) as bounced,
      count(*) filter (where r.opened_at       is not null) as opened,
      count(*) filter (where r.unsubscribed_at is not null) as unsubscribed,
      count(*) filter (where r.complained_at   is not null) as complained
    from public.send_recipients r where r.send_id = s.id
  ) p on s.id is not null
  where c.brand_id = p_brand_id
  order by c.sent_at desc nulls last, c.external_id;
end $$;

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
  ) into v
  from public.campaign_shares sh
  join public.campaigns c on c.id = sh.campaign_id
  join public.brands b    on b.id = sh.brand_id
  left join public.campaign_sends s on s.campaign_id = c.id and s.status <> 'cancelled'
  left join lateral (
    select count(*) filter (where r.accepted_at     is not null) as accepted,
           count(*) filter (where r.delivered_at    is not null) as delivered,
           count(*) filter (where r.bounced_at      is not null) as bounced,
           count(*) filter (where r.opened_at       is not null) as opened,
           count(*) filter (where r.unsubscribed_at is not null) as unsubscribed,
           count(*) filter (where r.complained_at   is not null) as complained
    from public.send_recipients r where r.send_id = s.id
  ) p on s.id is not null
  where sh.id = p_share_id;
  return v;
end $$;

revoke execute on function public.brand_campaign_performance(uuid) from public, anon;
grant  execute on function public.brand_campaign_performance(uuid) to authenticated;
revoke execute on function private.share_results(uuid) from public, anon, authenticated;
