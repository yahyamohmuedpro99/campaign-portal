/**
 * Everything the brief says the graders will try, in one run.
 *
 *   node --env-file=.env scripts/grader-simulation.mjs
 *   SMOKE_BASE_URL=https://… node --env-file=.env scripts/grader-simulation.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { connect } from './lib/db.mjs';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let failures = 0;
const section = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  · ' + detail : ''}`);
  if (!pass) failures++;
};

const signIn = async (email, pwEnv) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: process.env[pwEnv] });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
};

const sql = await connect();
const brands = Object.fromEntries(
  (await sql.query('select slug, id from public.brands')).rows.map((b) => [b.slug, b.id]));

// ── 1. all six sign in, each into their own brand ───────────────────────────────────
section('The six logins');
const USERS = [
  ['Kilele owner',      'yahyamohmuedpro99@gmail.com',       'SEED_PASSWORD_KILELE_OWNER',     'kilele',    'owner'],
  ['Kilele analyst',    'yahya.mo.asr@gmail.com',            'SEED_PASSWORD_KILELE_ANALYST',   'kilele',    'analyst'],
  ['Karoo owner',       'owner@karoo.vg-eval.test',          'SEED_PASSWORD_KAROO_OWNER',      'karoo',     'owner'],
  ['Karoo analyst',     'analyst@karoo.vg-eval.test',        'SEED_PASSWORD_KAROO_ANALYST',    'karoo',     'analyst'],
  ['Marrakech owner',   'owner@marrakech.vg-eval.test',      'SEED_PASSWORD_MARRAKECH_OWNER',  'marrakech', 'owner'],
  ['Marrakech analyst', 'analyst@marrakech.vg-eval.test',    'SEED_PASSWORD_MARRAKECH_ANALYST','marrakech', 'analyst'],
];
const clients = {};
for (const [label, email, pwEnv, slug, role] of USERS) {
  const c = await signIn(email, pwEnv);
  clients[label] = { c, slug, role };
  const { data } = await c.from('brand_members').select('role, brand_id');
  check(`${label} signs in and belongs to ${slug} as ${role}`,
        data?.length === 1 && data[0].brand_id === brands[slug] && data[0].role === role);
}

// ── 2. straight at the database, as the brief promises ──────────────────────────────
section('Reading another brand, directly against the database API');
const TABLES = ['contacts', 'campaigns', 'contact_events', 'campaign_sends', 'send_recipients',
                'send_chunks', 'provider_events', 'import_runs', 'import_rejects', 'import_warnings'];
const karoo = clients['Karoo analyst'].c;
for (const t of TABLES) {
  const { data, error } = await karoo.from(t).select('id').eq('brand_id', brands.kilele).limit(5);
  check(`${t}: another brand's rows are invisible`, !error && (data?.length ?? 0) === 0);
}
const { data: ownRows } = await karoo.from('contacts').select('brand_id').limit(200);
check('and their own brand is fully visible',
      (ownRows?.length ?? 0) > 0 && ownRows.every((r) => r.brand_id === brands.karoo),
      `${ownRows?.length ?? 0} rows, all Karoo`);

const shared = 'CT-000050';
const k = await clients['Kilele owner'].c.from('contacts').select('brand_id').eq('external_id', shared);
const m = await clients['Marrakech owner'].c.from('contacts').select('brand_id').eq('external_id', shared);
check(`a customer reference used by several brands resolves to one person each`,
      k.data?.length === 1 && m.data?.length === 1 && k.data[0].brand_id !== m.data[0].brand_id,
      shared);

// ── 3. requests that should be turned down ──────────────────────────────────────────
section('Requests that should be refused');
const owner = clients['Kilele owner'].c;
const ins = await owner.from('contacts').insert({ brand_id: brands.kilele, external_id: 'ZZ', status: 'active' });
check('a signed-in owner cannot insert', ins.error !== null, ins.error?.code ?? '');
const upd = await owner.from('contacts').update({ full_name: 'x' }).eq('brand_id', brands.kilele);
check('a signed-in owner cannot update', upd.error !== null, upd.error?.code ?? '');
const del = await owner.from('campaign_sends').delete().eq('brand_id', brands.kilele);
check('a signed-in owner cannot delete', del.error !== null, del.error?.code ?? '');

const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
for (const t of ['contacts', 'brands', 'brand_members', 'campaign_shares']) {
  const { error } = await anon.from(t).select('*').limit(1);
  check(`a stranger with the public key cannot read ${t}`, error !== null);
}
for (const fn of ['preview_campaign_send', 'approve_campaign_send', 'brand_totals', 'sync_ingest_events']) {
  const { error } = await anon.rpc(fn, {});
  check(`a stranger cannot call ${fn}`, error !== null);
}

const { data: kileleCampaign } = await owner.from('campaigns').select('id').limit(1).single();
const analystPreview = await clients['Kilele analyst'].c
  .rpc('preview_campaign_send', { p_campaign_id: kileleCampaign.id });
check('an analyst cannot start a send', analystPreview.error !== null,
      analystPreview.error?.message?.slice(0, 24) ?? '');
const crossBrand = await clients['Karoo owner'].c
  .rpc('preview_campaign_send', { p_campaign_id: kileleCampaign.id });
check("an owner cannot start a send in another brand", crossBrand.error !== null,
      crossBrand.error?.message?.slice(0, 24) ?? '');

const secrets = await owner.from('campaign_shares').select('id, token_hash, password_hash');
check('share link secrets cannot be read, even by their owner', secrets.error !== null);

// ── 4. the numbers add up ───────────────────────────────────────────────────────────
section('The numbers');
for (const slug of ['kilele', 'karoo', 'marrakech']) {
  const c = Object.values(clients).find((x) => x.slug === slug).c;
  const { data: steps } = await c.rpc('brand_contactability_waterfall', { p_brand_id: brands[slug] });
  const total = steps.find((s) => s.step_key === 'total').remaining;
  const final = steps.find((s) => s.step_key === 'contactable').remaining;
  const removed = steps.filter((s) => !['total', 'contactable'].includes(s.step_key))
                       .reduce((a, s) => a + Number(s.excluded), 0);
  const { data: totals } = await c.rpc('brand_totals', { p_brand_id: brands[slug] }).single();
  check(`${slug}: the waterfall adds up`, Number(total) - removed === Number(final),
        `${total} − ${removed} = ${final}`);
  check(`${slug}: contactable agrees with the dashboard tile`,
        Number(final) === Number(totals.contactable));
}

// ── 5. the share link, approached as a stranger ─────────────────────────────────────
section('A shared report, approached as a stranger');
const guess = await fetch(`${BASE}/share/${'z'.repeat(43)}`);
check('a guessed link is indistinguishable from one that never existed', guess.status === 404,
      `${guess.status}`);
const headers = guess.headers;
check('shared pages are never cached', /no-store/.test(headers.get('cache-control') ?? ''),
      headers.get('cache-control') ?? 'none');

await sql.end();
section(failures === 0 ? 'Everything the graders said they would try, holds.' : `${failures} problem(s).`);
process.exit(failures ? 1 : 0);
