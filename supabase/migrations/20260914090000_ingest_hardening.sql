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
