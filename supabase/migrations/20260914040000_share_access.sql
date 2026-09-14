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
