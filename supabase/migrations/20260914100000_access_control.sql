-- =====================================================================================
-- "Someone who isn't one of the six gets in nowhere."
--
-- Row-level security already makes this true in the only sense that matters: an account
-- with no membership can reach no row of any table, whichever way it signed in. This adds
-- two further layers so the guarantee does not rest on a single setting in a dashboard
-- that someone could later change.
-- =====================================================================================

/**
 * Rejects an account that is not one of ours, before it is created.
 *
 * Wired up as Supabase's "before user created" auth hook. It fires for Google sign-ins as
 * well as email ones, and it is what turns an unknown Google account into a plain refusal
 * rather than a new user who then finds an empty portal.
 *
 * The allowlist is the set of addresses that already have a membership, so adding a
 * teammate is a normal database insert rather than an edit to this function.
 */
create or replace function public.restrict_signup_to_invited(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_email text;
begin
  v_email := lower(coalesce(event->'user'->>'email', ''));

  if exists (
    select 1 from auth.users u
    join public.brand_members m on m.user_id = u.id
    where lower(u.email) = v_email
  ) then
    return event;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'This portal is limited to accounts that have been given access to a brand.'));
end $$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.restrict_signup_to_invited(jsonb) to supabase_auth_admin;
revoke execute on function public.restrict_signup_to_invited(jsonb) from public, anon, authenticated;

/**
 * Removes accounts that reached the auth system but belong to no brand.
 *
 * Belt and braces for the case where the hook above is not enabled: such an account can
 * already read nothing, so this is tidiness rather than a control, but it keeps the six
 * accounts the six accounts. New rows are given a few minutes' grace so that seeding a
 * user and granting their membership are not a race.
 */
create or replace function private.prune_unaffiliated_users()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  with doomed as (
    select u.id from auth.users u
    where u.created_at < now() - interval '10 minutes'
      and not exists (select 1 from public.brand_members m where m.user_id = u.id)
  ), gone as (
    delete from auth.users where id in (select id from doomed) returning 1
  )
  select count(*) into v_count from gone;
  return v_count;
end $$;

revoke execute on function private.prune_unaffiliated_users() from public, anon, authenticated;

select cron.schedule(
  'prune-unaffiliated-users',
  '17 * * * *',
  $job$ select private.prune_unaffiliated_users(); $job$
);
