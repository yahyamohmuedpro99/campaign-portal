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
