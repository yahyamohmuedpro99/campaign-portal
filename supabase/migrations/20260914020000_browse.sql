-- =====================================================================================
-- Browsing contacts and campaigns.
--
-- The contact list is driven by the same predicates as the dashboard waterfall, so
-- clicking "unsubscribed" on the dashboard shows exactly the people that line subtracted.
-- If the two ever disagreed, one of them would be lying.
--
-- Paging is by keyset rather than offset. The largest brand here is ninety times the
-- smallest, and OFFSET 80000 asks Postgres to walk eighty thousand rows before returning
-- anything; a cursor on (brand_id, id) reads only the page requested.
-- =====================================================================================

create or replace function public.brand_contacts_page(
  p_brand_id  uuid,
  p_exclusion text default null,
  p_search    text default null,
  p_cursor    uuid default null,
  p_limit     integer default 50)
returns table (
  id uuid, external_id text, full_name text, email text, email_raw text,
  phone_e164 text, phone_raw text, country char(2), city text, signup_at timestamptz,
  status text, consent_marketing boolean, contactable boolean, exclusion_reason text)
language plpgsql stable security definer set search_path = '' as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if not private.is_brand_member(p_brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select c.id, c.external_id, c.full_name, c.email, c.email_raw,
         c.phone_e164, c.phone_raw, c.country, c.city, c.signup_at,
         c.status, c.consent_marketing,
         (c.contactable_static and (c.suppressed_until is null or c.suppressed_until <= now())),
         -- The first rule that excludes them, in the same order the waterfall applies.
         case
           when c.deleted_at is not null                                     then 'deleted'
           when c.consent_marketing is not true                              then 'no_consent'
           when c.status <> 'active'                                         then 'not_active'
           when c.unsubscribed_at is not null                                then 'unsubscribed'
           when c.complained_at is not null                                  then 'complained'
           when c.bounced_at is not null                                     then 'bounced'
           when c.suppressed_until is not null and c.suppressed_until > now() then 'suppressed'
           when c.email is null and c.phone_e164 is null                     then 'no_channel'
           else null
         end
  from public.contacts c
  where c.brand_id = p_brand_id
    and (p_cursor is null or c.id > p_cursor)
    and (p_search is null or p_search = '' or
         c.full_name ilike '%' || p_search || '%' or
         c.email ilike '%' || p_search || '%' or
         c.email_raw ilike '%' || p_search || '%' or
         c.external_id ilike '%' || p_search || '%')
    and (p_exclusion is null or p_exclusion = '' or case p_exclusion
           when 'total'        then true
           when 'contactable'  then c.contactable_static
                                and (c.suppressed_until is null or c.suppressed_until <= now())
           when 'deleted'      then c.deleted_at is not null
           when 'no_consent'   then c.deleted_at is null and c.consent_marketing is not true
           when 'not_active'   then c.deleted_at is null and c.consent_marketing is true
                                and c.status <> 'active'
           when 'unsubscribed' then c.deleted_at is null and c.consent_marketing is true
                                and c.status = 'active' and c.unsubscribed_at is not null
           when 'complained'   then c.deleted_at is null and c.consent_marketing is true
                                and c.status = 'active' and c.unsubscribed_at is null
                                and c.complained_at is not null
           when 'bounced'      then c.deleted_at is null and c.consent_marketing is true
                                and c.status = 'active' and c.unsubscribed_at is null
                                and c.complained_at is null and c.bounced_at is not null
           when 'suppressed'   then c.deleted_at is null and c.consent_marketing is true
                                and c.status = 'active' and c.unsubscribed_at is null
                                and c.complained_at is null and c.bounced_at is null
                                and c.suppressed_until is not null and c.suppressed_until > now()
           when 'no_channel'   then c.deleted_at is null and c.consent_marketing is true
                                and c.status = 'active' and c.unsubscribed_at is null
                                and c.complained_at is null and c.bounced_at is null
                                and (c.suppressed_until is null or c.suppressed_until <= now())
                                and c.email is null and c.phone_e164 is null
           else true end)
  order by c.id
  limit v_limit;
end $$;

-- What the data page shows: every import run for this brand, and what each one did.
create or replace function public.brand_import_runs(p_brand_id uuid, p_limit integer default 40)
returns table (
  id uuid, entity text, source_file text, file_sha256 text,
  started_at timestamptz, finished_at timestamptz, status text,
  rows_read integer, rows_inserted integer, rows_updated integer,
  rows_rejected integer, rows_warned integer, error text, notes jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_brand_member(p_brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select r.id, r.entity, r.source_file, r.file_sha256, r.started_at, r.finished_at, r.status,
         r.rows_read, r.rows_inserted, r.rows_updated, r.rows_rejected, r.rows_warned,
         r.error, r.notes
  from public.import_runs r
  where r.brand_id = p_brand_id
  order by r.started_at desc
  limit least(greatest(coalesce(p_limit, 40), 1), 200);
end $$;

create or replace function public.brand_import_issues(
  p_run_id uuid, p_kind text default 'reject', p_reason text default null,
  p_limit integer default 50, p_offset integer default 0)
returns table (row_no integer, reason_code text, detail text, raw jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare v_brand uuid;
begin
  select brand_id into v_brand from public.import_runs where id = p_run_id;
  if v_brand is null then raise exception 'run_not_found' using errcode = 'P0002'; end if;
  if not private.is_brand_member(v_brand) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_kind = 'reject' then
    return query
      select r.row_no, r.reason_code, r.detail, r.raw from public.import_rejects r
      where r.run_id = p_run_id and (p_reason is null or r.reason_code = p_reason)
      order by r.id limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
  else
    return query
      select w.row_no, w.reason_code, w.detail, w.raw from public.import_warnings w
      where w.run_id = p_run_id and (p_reason is null or w.reason_code = p_reason)
      order by w.id limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
  end if;
end $$;

-- Storage is finite on the plan this runs on, and the data page says so out loud.
create or replace function public.database_size()
returns table (bytes bigint, pretty text)
language sql stable security definer set search_path = '' as $$
  select pg_database_size(current_database()),
         pg_size_pretty(pg_database_size(current_database()));
$$;

revoke execute on function public.brand_contacts_page(uuid,text,text,uuid,integer) from public, anon;
revoke execute on function public.brand_import_runs(uuid,integer)                  from public, anon;
revoke execute on function public.brand_import_issues(uuid,text,text,integer,integer) from public, anon;
revoke execute on function public.database_size()                                  from public, anon;
grant  execute on function public.brand_contacts_page(uuid,text,text,uuid,integer) to authenticated;
grant  execute on function public.brand_import_runs(uuid,integer)                  to authenticated;
grant  execute on function public.brand_import_issues(uuid,text,text,integer,integer) to authenticated;
grant  execute on function public.database_size()                                  to authenticated;
