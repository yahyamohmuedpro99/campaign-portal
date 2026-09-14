-- =====================================================================================
-- Make the per-recipient outcome impossible to get wrong.
--
-- provider_status was maintained by a trigger that recomputed it whenever new reports
-- arrived. That is correct while reports are flowing and silently wrong the moment
-- anything touches the column outside that path: the timestamps said 218 delivered while
-- the status column still said 156 merely accepted, and nothing would ever have repaired
-- the difference.
--
-- A derived value should not be stored twice. It is now a generated column computed from
-- the timestamps themselves, so the two cannot disagree, in any order of arrival, no
-- matter what writes to the row.
-- =====================================================================================

alter table public.send_recipients add column if not exists accepted_at timestamptz;
alter table public.send_recipients add column if not exists rejected_at timestamptz;

-- Backfill from what the existing rows already tell us, so nothing is lost in the change.
update public.send_recipients
   set accepted_at = coalesce(accepted_at,
         case when provider_status is not null and provider_status <> 'rejected' then now() end),
       rejected_at = coalesce(rejected_at,
         case when provider_status = 'rejected' or rejected_reason is not null then now() end)
 where accepted_at is null and rejected_at is null;

drop trigger if exists provider_events_apply on public.provider_events;
alter table public.send_recipients drop column provider_status;

alter table public.send_recipients
  add column provider_status text generated always as (
    case
      -- Terminal outcomes outrank everything, so a bounce that lands after a delivery
      -- never reads as delivered.
      when complained_at   is not null then 'complained'
      when unsubscribed_at is not null then 'unsubscribed'
      when bounced_at      is not null then 'bounced'
      when delivered_at    is not null then 'delivered'
      -- An open with no delivery report is still proof it arrived.
      when opened_at is not null or clicked_at is not null then 'delivered_inferred'
      when rejected_at is not null then 'rejected'
      when accepted_at  is not null then 'accepted'
      else 'not yet sent'
    end
  ) stored;

create index send_recipients_status_idx2 on public.send_recipients (send_id, provider_status);

-- The trigger now has one job: record what arrived. Deriving the outcome is the column's
-- job, and applying suppression to the customer is the only thing left that a trigger
-- has to do, because it crosses to another table.
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

  -- Suppression flows back to the customer, monotonically, and within this brand only.
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

-- The dispatcher now records timestamps and lets the status follow from them.
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

  if v_accepted > 0 then
    update public.send_recipients r
       set accepted_at = coalesce(r.accepted_at, now())
      from jsonb_array_elements_text(p_accepted) a(id)
     where r.send_id = v_chunk.send_id and r.id::text = a.id;
  end if;

  if v_rejected > 0 then
    update public.send_recipients r
       set rejected_at = coalesce(r.rejected_at, now()), rejected_reason = x.reason
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

revoke execute on function public.dispatch_finish_attempt(uuid,integer,integer,text,jsonb,jsonb,text,text)
  from public, anon, authenticated;
grant execute on function public.dispatch_finish_attempt(uuid,integer,integer,text,jsonb,jsonb,text,text)
  to service_role;
