/**
 * A real send for the largest brand, start to finish.
 *
 * The Marrakech send in production is 230 people and fits in a single batch, so it proves
 * the pipeline works but not that it chunks. This drives one of Kilele's draft campaigns
 * through the same path — owner preview, owner approval, then the dispatcher — and reports
 * the chunk table afterwards, because "it sent" is not evidence and "no batch id repeats"
 * is.
 *
 *   E2E_CAMPAIGN=KIL-0033 SMOKE_BASE_URL=https://… node --env-file=.env scripts/e2e/send-at-scale.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { connect } from '../lib/db.mjs';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const EXTERNAL_ID = process.env.E2E_CAMPAIGN ?? 'KIL-0033';
const sql = await connect();
let failures = 0;
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  · ' + detail : ''}`);
  if (!pass) failures++;
};
const size = async () => (await sql.query(
  `select pg_size_pretty(pg_database_size(current_database())) s`)).rows[0].s;

console.log(`database before: ${await size()}`);

const { rows: [campaign] } = await sql.query(
  `select cp.id, cp.name from public.campaigns cp join public.brands b on b.id = cp.brand_id
    where b.slug = 'kilele' and cp.external_id = $1`, [EXTERNAL_ID]);
if (!campaign) throw new Error(`no Kilele campaign ${EXTERNAL_ID}`);
console.log(`campaign: ${EXTERNAL_ID} — ${campaign.name}\n`);

// Everything an owner does, they do as themselves: the database decides what is allowed.
const owner = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { persistSession: false } });
const signIn = await owner.auth.signInWithPassword({
  email: 'yahyamohmuedpro99@gmail.com', password: process.env.SEED_PASSWORD_KILELE_OWNER });
if (signIn.error) throw new Error(signIn.error.message);

const t0 = Date.now();
const { data: p, error: pErr } = await owner.rpc('preview_campaign_send', { p_campaign_id: campaign.id });
if (pErr) throw new Error(pErr.message);
const preview = Array.isArray(p) ? p[0] : p;
console.log(`preview: ${preview.recipient_count} recipients in ${Date.now() - t0} ms\n`);

const { data: s, error: aErr } = await owner.rpc('approve_campaign_send', {
  p_preview_id: preview.id, p_expected_count: preview.recipient_count });
if (aErr) throw new Error(aErr.message);
const send = Array.isArray(s) ? s[0] : s;

const { rows: [planned] } = await sql.query(
  `select count(*)::int chunks, max(recipient_count)::int biggest
     from public.send_chunks where send_id = $1`, [send.id]);
console.log(`approved ${send.approved_count} recipients into ${planned.chunks} batches of at most ${planned.biggest}`);
check('this send actually chunks', planned.chunks > 1, `${planned.chunks} batches`);
check('no batch exceeds the provider cap of 500', planned.biggest <= 500, `biggest ${planned.biggest}`);

// Push it through. The dispatcher returns when its time budget runs out, so keep calling.
console.log('\ndispatching…');
let rounds = 0;
for (;;) {
  const res = await fetch(`${BASE}/api/sends/${send.id}/dispatch`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.JOB_SECRET}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const body = await res.json();
  rounds++;
  console.log(`  round ${rounds}: claimed ${body.claimed}, accepted ${body.accepted}, ` +
              `failed ${body.failed}, indeterminate ${body.indeterminate}, status ${body.status}`);
  if (body.finished || body.claimed === 0 || rounds > 20) break;
}

const { rows: [done] } = await sql.query(
  `select s.status, s.approved_count,
          (select count(*) from public.send_chunks k where k.send_id = s.id) as chunks,
          (select count(distinct k.provider_batch_id) from public.send_chunks k where k.send_id = s.id
             and k.provider_batch_id is not null) as batch_ids,
          (select count(*) from public.send_chunks k where k.send_id = s.id and k.status = 'accepted') as accepted_chunks,
          (select coalesce(sum(k.accepted_count),0) from public.send_chunks k where k.send_id = s.id) as accepted,
          (select count(*) from public.send_attempts a join public.send_chunks k on k.id = a.chunk_id
             where k.send_id = s.id) as provider_calls
     from public.campaign_sends s where s.id = $1`, [send.id]);

console.log('');
check('every batch reached the provider', Number(done.accepted_chunks) === Number(done.chunks),
      `${done.accepted_chunks}/${done.chunks}`);
check('every batch has its own provider reference', Number(done.batch_ids) === Number(done.chunks),
      `${done.batch_ids} distinct ids for ${done.chunks} batches`);
check('one provider call per batch, no more', Number(done.provider_calls) === Number(done.chunks),
      `${done.provider_calls} calls`);
check('the number approved is the number sent', Number(done.accepted) === Number(done.approved_count),
      `${done.accepted} of ${done.approved_count}`);
check('the send closed as completed', done.status === 'completed', done.status);

const { rows: [dupes] } = await sql.query(
  `select count(*)::int n from (select contact_id from public.send_recipients
     where send_id = $1 group by contact_id having count(*) > 1) x`, [send.id]);
check('nobody appears twice', dupes.n === 0);

console.log(`\ndatabase after: ${await size()}`);
console.log(`send id: ${send.id}`);
await sql.end();
console.log(failures === 0 ? '\nThe largest brand sends, in batches, once each.' : `\n${failures} problem(s).`);
process.exit(failures ? 1 : 0);
