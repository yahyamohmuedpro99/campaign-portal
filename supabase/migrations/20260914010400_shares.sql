-- =====================================================================================
-- Shareable result links.
--
-- The link is for someone with no login, so the row holds no secret in recoverable form:
-- only a SHA-256 of the token and a bcrypt hash of the password. Neither column is
-- grantable to any signed-in role (see the column-level grant in the security
-- migration), so even the owner who created the link cannot read them back.
-- =====================================================================================

create or replace function public.create_campaign_share(
  p_campaign_id uuid, p_token_hash bytea, p_password_hash text,
  p_label text default null, p_expires_in_days integer default 30)
returns public.campaign_shares
language plpgsql security definer set search_path = '' as $$
declare v_brand uuid; v_row public.campaign_shares;
begin
  select c.brand_id into v_brand from public.campaigns c where c.id = p_campaign_id;
  if v_brand is null then raise exception 'campaign_not_found' using errcode = 'P0002'; end if;
  if not private.is_brand_owner(v_brand) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if octet_length(p_token_hash) <> 32 then
    raise exception 'token_hash_must_be_sha256' using errcode = 'P0001';
  end if;
  if p_password_hash is null or length(p_password_hash) < 20 then
    raise exception 'password_hash_missing' using errcode = 'P0001';
  end if;

  insert into public.campaign_shares
    (brand_id, campaign_id, label, token_hash, password_hash, created_by, expires_at)
  values (v_brand, p_campaign_id, p_label, p_token_hash, p_password_hash,
          (select auth.uid()),
          now() + (least(greatest(coalesce(p_expires_in_days, 30), 1), 365) || ' days')::interval)
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.revoke_campaign_share(p_share_id uuid)
returns public.campaign_shares
language plpgsql security definer set search_path = '' as $$
declare v_row public.campaign_shares;
begin
  select * into v_row from public.campaign_shares where id = p_share_id;
  if v_row.id is null then raise exception 'share_not_found' using errcode = 'P0002'; end if;
  if not private.is_brand_owner(v_row.brand_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.campaign_shares set revoked_at = now()
  where id = p_share_id and revoked_at is null
  returning * into v_row;
  return v_row;
end $$;

-- The public face of a share: one campaign's aggregate results and nothing else. No
-- contact rows, no other campaign, no brand totals, no counts that could be differenced
-- to recover an individual. Called only by the server after the password has been
-- checked, using the service role.
create or replace function private.share_results(p_share_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  select jsonb_build_object(
    'campaign_name',  c.name,
    'channel',        c.channel,
    'brand_name',     b.name,
    'sent_at',        s.approved_at,
    'approved',       s.approved_count,
    'accepted',       coalesce(p.accepted, 0),
    'delivered',      coalesce(p.delivered, 0),
    'bounced',        coalesce(p.bounced, 0),
    'opened',         coalesce(p.opened, 0),
    'unsubscribed',   coalesce(p.unsubscribed, 0),
    'complained',     coalesce(p.complained, 0),
    'status',         s.status,
    'last_polled_at', (select max(ch.last_polled_at) from public.send_chunks ch where ch.send_id = s.id),
    'reported_sent',      c.reported_sent,
    'reported_delivered', c.reported_delivered,
    'reported_opens',     c.reported_opens
  )
  into v
  from public.campaign_shares sh
  join public.campaigns c on c.id = sh.campaign_id
  join public.brands b    on b.id = sh.brand_id
  left join public.campaign_sends s on s.campaign_id = c.id and s.status <> 'cancelled'
  left join lateral (
    select count(*) filter (where r.provider_status is not null
                              and r.provider_status <> 'rejected') as accepted,
           count(*) filter (where r.delivered_at    is not null)   as delivered,
           count(*) filter (where r.bounced_at      is not null)   as bounced,
           count(*) filter (where r.opened_at       is not null)   as opened,
           count(*) filter (where r.unsubscribed_at is not null)   as unsubscribed,
           count(*) filter (where r.complained_at   is not null)   as complained
    from public.send_recipients r where r.send_id = s.id
  ) p on s.id is not null
  where sh.id = p_share_id;
  return v;
end $$;

revoke execute on function public.create_campaign_share(uuid,bytea,text,text,integer) from public, anon;
revoke execute on function public.revoke_campaign_share(uuid)                         from public, anon;
revoke execute on function private.share_results(uuid)                                from public, anon, authenticated;
grant  execute on function public.create_campaign_share(uuid,bytea,text,text,integer) to authenticated;
grant  execute on function public.revoke_campaign_share(uuid)                         to authenticated;
