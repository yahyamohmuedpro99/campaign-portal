/**
 * The case where we call the provider and never hear back.
 *
 * Everything else in the send pipeline has a definite answer. This one does not: the batch
 * may have gone out, or it may not, and the only honest state is "we do not know". The
 * pipeline records that as `indeterminate` and hands it to the owner rather than guessing.
 *
 * Until now this had only been exercised against a mocked provider. Here the provider call
 * is real — a genuine batch is sent and genuinely accepted — and the outcome is genuinely
 * never written, which is exactly what a process dying between the two commits looks like.
 *
 * There are two ways out of that state and this exercises both, because which one applies
 * is a configuration decision rather than a fact:
 *
 *   unverified replay  the batch is parked as `indeterminate` and an owner decides
 *   verified replay    the call is repeated under the same Idempotency-Key, and the
 *                      provider returns the original batch instead of sending again
 *
 * This provider was probed and does replay, so production takes the second path. The first
 * is still reachable by setting PROVIDER_IDEMPOTENCY=unverified, and is what the pipeline
 * would do at a provider whose replay behaviour nobody had checked.
 *
 *   SMOKE_BASE_URL=https://… node --env-file=.env scripts/e2e/indeterminate.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { connect } from '../lib/db.mjs';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const CHUNK = 40;
const sql = await connect();
let failures = 0;
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  · ' + detail : ''}`);
  if (!pass) failures++;
};
const dispatch = () => fetch(`${BASE}/api/sends/${send.id}/dispatch`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.JOB_SECRET}`, 'content-type': 'application/json' },
  body: '{}',
}).then((r) => r.json());

const { rows: [brand] } = await sql.query(`select id from public.brands where slug = 'marrakech'`);
const externalId = `MAR-08${String(Date.now() % 100).padStart(2, '0')}`;
const { rows: [campaign] } = await sql.query(
  `insert into public.campaigns (brand_id, external_id, name, channel, origin)
   values ($1, $2, 'Atlas Sunset Tour — silence check', 'email', 'portal') returning id`,
  [brand.id, externalId]);

let send;
try {
  const owner = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } });
  await owner.auth.signInWithPassword({
    email: 'owner@marrakech.vg-eval.test', password: process.env.SEED_PASSWORD_MARRAKECH_OWNER });

  const { data: p } = await owner.rpc('preview_campaign_send', { p_campaign_id: campaign.id });
  const preview = Array.isArray(p) ? p[0] : p;
  const { data: s, error } = await owner.rpc('approve_campaign_send', {
    p_preview_id: preview.id, p_expected_count: preview.recipient_count, p_chunk_size: CHUNK });
  if (error) throw new Error(error.message);
  send = Array.isArray(s) ? s[0] : s;
  console.log(`approved ${send.approved_count} recipients in batches of ${CHUNK}\n`);

  // ── the crash ─────────────────────────────────────────────────────────────────────
  // Claim a batch, record the attempt, really send it — then walk away without writing
  // down what happened, which is all a dying process ever does.
  const { rows: [chunk] } = await sql.query(
    `select * from public.dispatch_claim_chunk($1, 'worker-that-will-die')`, [send.id]);
  const { rows: [recipients] } = await sql.query(
    `select coalesce(jsonb_agg(jsonb_build_object('id', id, 'email', email)), '[]'::jsonb) r
       from public.send_recipients where send_id = $1 and chunk_no = $2`, [send.id, chunk.chunk_no]);
  const body = { campaign: externalId, brand: 'marrakech', recipients: recipients.r };
  const sha = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const { rows: [attempt] } = await sql.query(
    `select * from public.dispatch_begin_attempt($1, $2)`, [chunk.id, sha]);
  check('the attempt is recorded before the provider is called', attempt.outcome === 'proceed');

  const res = await fetch(`${process.env.PROVIDER_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.PROVIDER_API_KEY}`,
      'content-type': 'application/json',
      'Idempotency-Key': attempt.idempotency_key,
    },
    body: JSON.stringify(body),
  });
  const lost = await res.json();
  console.log(`  the provider accepted batch ${lost.batch_id} (${lost.accepted?.length ?? 0} recipients)`);
  console.log('  …and the process dies here, before the outcome is written.\n');

  // ── path one: a provider whose replay behaviour is unverified ─────────────────────
  // This is the same call the dispatcher makes, with allow_retry off — what it would do at
  // a provider nobody had probed. No waiting: the staleness window governs when a chunk is
  // reclaimed, and that is already covered by scripts/e2e/interrupted-send.mjs. Waiting
  // here only opened a gap for the scheduled resumer to win the race.
  console.log('if this provider\'s replay behaviour were unverified:');
  const { rows: [reopened] } = await sql.query(
    `select * from public.dispatch_begin_attempt($1, $2, false)`, [chunk.id, sha]);
  check('the unanswered call is parked, not guessed at', reopened.outcome === 'indeterminate',
        reopened.outcome);

  const { rows: [c0] } = await sql.query(
    `select status, provider_batch_id from public.send_chunks where id = $1`, [chunk.id]);
  check('the batch is marked indeterminate, not failed and not sent',
        c0.status === 'indeterminate', c0.status);
  check('nothing was sent a second time to get there', c0.provider_batch_id === null,
        c0.provider_batch_id ?? 'no batch id recorded');
  const { rows: [calls] } = await sql.query(
    `select count(*)::int n from public.send_attempts where chunk_id = $1`, [chunk.id]);
  check('the provider was called exactly once', calls.n === 1, `${calls.n} attempt(s)`);

  // ── path two: the owner decides, and the replay is proved ─────────────────────────
  // Retrying is safe here only because the provider was proved to replay a repeated
  // Idempotency-Key. The proof is that the batch id comes back the same one the abandoned
  // call received — so those forty people were messaged once, not twice.
  const { data: resolved, error: rErr } = await owner.rpc('resolve_indeterminate_chunk', {
    p_chunk_id: chunk.id, p_resolution: 'retry', p_note: 'verified replay: same key returns the same batch' });
  if (rErr) throw new Error(rErr.message);
  console.log(`\nowner resolved it as retry → chunk is ${(Array.isArray(resolved) ? resolved[0] : resolved).status}`);

  for (let i = 0; i < 6; i++) { const r = await dispatch(); if (r.finished || r.claimed === 0) break; }

  const { rows: [final] } = await sql.query(
    `select status, provider_batch_id, accepted_count from public.send_chunks where id = $1`, [chunk.id]);
  check('the retry replayed the original batch rather than sending a new one',
        final.provider_batch_id === lost.batch_id, `${final.provider_batch_id} vs ${lost.batch_id}`);
  check('the batch is now accounted for', final.status === 'accepted', final.status);

  const { rows: [tally] } = await sql.query(
    `select s.status,
            (select count(*) from public.send_chunks k where k.send_id=s.id) chunks,
            (select count(distinct k.provider_batch_id) from public.send_chunks k
               where k.send_id=s.id and k.provider_batch_id is not null) batch_ids,
            (select coalesce(sum(k.accepted_count),0) from public.send_chunks k where k.send_id=s.id) accepted,
            s.approved_count
       from public.campaign_sends s where s.id=$1`, [send.id]);
  check('every batch still has its own provider reference',
        Number(tally.batch_ids) === Number(tally.chunks), `${tally.batch_ids} for ${tally.chunks}`);
  check('the number approved is the number sent', Number(tally.accepted) === Number(tally.approved_count),
        `${tally.accepted} of ${tally.approved_count}`);

  console.log('\nthe timeline the owner would have read:');
  const { rows: timeline } = await sql.query(
    `select to_char(at,'HH24:MI:SS') at, actor, event from public.send_events
      where send_id = $1 and (chunk_id = $2 or chunk_id is null) order by at, id`, [send.id, chunk.id]);
  console.table(timeline);
} finally {
  await sql.query(`delete from public.campaigns where external_id = $1`, [externalId]);
  await sql.end();
}
console.log(failures === 0
  ? '\nA call that was never answered stays unknown, and the owner decides what it meant.'
  : `\n${failures} problem(s).`);
process.exit(failures ? 1 : 0);
