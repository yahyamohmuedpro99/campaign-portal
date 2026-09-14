-- pg_net installs its functions in the `net` schema on this platform, not under
-- `extensions`. With an empty search_path the wrong qualification is not a warning, it is
-- a hard failure once a minute, which is exactly what the cron history showed.
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

  select net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_secret),
    body    := jsonb_build_object('source', 'pg_cron'),
    timeout_milliseconds := 8000
  ) into v_id;
  return v_id;
end $$;

revoke execute on function private.tick_delivery_reports() from public, anon, authenticated;
