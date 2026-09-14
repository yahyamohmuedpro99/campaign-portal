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
