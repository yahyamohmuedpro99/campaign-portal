-- =====================================================================================
-- The delivery-report scheduler.
--
-- The messaging provider has no webhooks. Delivery, bounces, opens and unsubscribes
-- exist only if something asks for them, and the brief is explicit that they arrive
-- "including while your app isn't looking". So the schedule lives inside the database,
-- where it runs whether or not anyone has the portal open.
--
-- The endpoint and its bearer token are read from Vault rather than written here, so no
-- credential enters this repository. scripts/setup-scheduler.mjs stores them.
-- =====================================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function private.tick_delivery_reports()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
  v_id     bigint;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'job_tick_url' limit 1;
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'job_secret' limit 1;

  if v_url is null or v_secret is null then
    raise notice 'tick_delivery_reports: job_tick_url or job_secret is missing from the vault';
    return null;
  end if;

  -- Fire and forget: pg_net queues the request and returns immediately, so a slow or
  -- unreachable endpoint can never hold a database connection open.
  select extensions.net_http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_secret),
    body    := jsonb_build_object('source', 'pg_cron'),
    timeout_milliseconds := 8000
  ) into v_id;
  return v_id;
end $$;

revoke execute on function private.tick_delivery_reports() from public, anon, authenticated;

-- Every minute. Each run is cheap when there is nothing to collect: the query that picks
-- work out only returns chunks whose reports are actually still moving, and a send stops
-- being polled once its stream goes quiet.
select cron.schedule(
  'delivery-reports-tick',
  '* * * * *',
  $job$ select private.tick_delivery_reports(); $job$
);
