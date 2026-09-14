// Reports the live security posture of the database. Read-only.
import { connect } from './lib/db.mjs';

const c = await connect();

const q = async (label, sql) => { const r = await c.query(sql); console.log(`\n== ${label}`); console.table(r.rows); return r.rows; };
console.log('connected:', (await c.query('select current_user, version()')).rows[0].current_user);
await q('tables without RLS (must be empty)', `
  select t.tablename from pg_tables t
  where t.schemaname='public' and not t.rowsecurity order by 1`);
await q('tables with RLS but no policy (must be empty)', `
  select t.tablename from pg_tables t
  where t.schemaname='public' and t.rowsecurity
    and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=t.tablename)
  order by 1`);
await q('policy count', `select count(*)::int as policies from pg_policies where schemaname='public'`);
await q('write grants to anon/authenticated (must be empty)', `
  select table_name, grantee, privilege_type from information_schema.role_table_grants
  where table_schema='public' and grantee in ('anon','authenticated')
    and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE') order by 1,2`);
await q('SELECT granted to anon (must be empty)', `
  select table_name from information_schema.role_table_grants
  where table_schema='public' and grantee='anon' and privilege_type='SELECT' order by 1`);
await q('public functions executable by PUBLIC/anon (must be empty)', `
  select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  left join lateral aclexplode(p.proacl) a on true
  left join pg_roles r on r.oid=a.grantee
  where n.nspname='public' and a.privilege_type='EXECUTE'
    and (a.grantee=0 or r.rolname='anon') order by 1`);
await q('SECURITY DEFINER functions without pinned search_path (must be empty)', `
  select n.nspname||'.'||p.proname as fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where p.prosecdef and n.nspname in ('public','private')
    and not coalesce(p.proconfig,'{}') @> array['search_path=""']  order by 1`);
await q('event trigger for new tables', `
  select evtname, evtenabled from pg_event_trigger where evtname='force_rls_on_new_tables'`);
await q('provider chunk size', `select private.provider_chunk_size() as chunk_size`);
await c.end();
