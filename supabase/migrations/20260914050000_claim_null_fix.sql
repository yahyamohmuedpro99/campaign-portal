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
