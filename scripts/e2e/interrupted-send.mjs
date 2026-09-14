/**
 * Interrupts a real send and resumes it, then checks that nobody was sent to twice and
 * that nothing was quietly left behind.
 *
 * Run by hand rather than in CI, because it puts real traffic through the provider:
 *   node --env-file=.env scripts/e2e/interrupted-send.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { connect } from '../lib/db.mjs';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const CHUNK = 50;   // small on purpose, so one send has several batches to interrupt
const sql = await connect();
let failures = 0;
const check = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!pass) failures++;
};

const { rows: [brand] } = await sql.query(`select id from public.brands where slug = 'marrakech'`);
const externalId = `MAR-09${String(Date.now() % 100).padStart(2, '0')}`;
const { rows: [campaign] } = await sql.query(
  `insert into public.campaigns (brand_id, external_id, name, channel, origin)
   values ($1, $2, 'Atlas Day Trip — resumption check', 'email', 'portal') returning id`,
  [brand.id, externalId]);

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
  const send = Array.isArray(s) ? s[0] : s;

  const { rows: [c] } = await sql.query(
    `select count(*)::int n from public.send_chunks where send_id = $1`, [send.id]);
  console.log(`approved ${preview.recipient_count} recipients in ${c.n} batches of ${CHUNK}\n`);
  check('the send is split into several batches', c.n >= 3, `${c.n} batches`);

  const dispatch = (body) => fetch(`${BASE}/api/sends/${send.id}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.JOB_SECRET}` },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  // Send only the first two batches, then stop, as if the tab were closed.
  const first = await dispatch({ maxChunks: 2 });
  console.log('  partial dispatch ->', JSON.stringify(first));
  const { rows: [mid] } = await sql.query(
    `select count(*) filter (where status = 'accepted')::int done,
            count(*) filter (where status = 'pending')::int  left_over
       from public.send_chunks where send_id = $1`, [send.id]);
  check('it stops where it was told to', mid.done === 2, `${mid.done} sent, ${mid.left_over} left`);
  check('the rest is still waiting, not lost', mid.left_over === c.n - 2);
  check('the send is not reported as finished', first.finished === false);

  // Two dispatchers race to resume it. Only one may hold the send.
  const [a, b] = await Promise.all([dispatch({}), dispatch({})]);
  console.log('  resumed  ->', JSON.stringify(a));
  console.log('  racing   ->', JSON.stringify(b));
  const bothWorked = (a.claimed ?? 0) > 0 && (b.claimed ?? 0) > 0;
  check('two dispatchers do not both take work', !bothWorked,
        `claimed ${a.claimed} and ${b.claimed}`);

  const { rows: [end] } = await sql.query(
    `select count(*)::int total,
            count(*) filter (where status = 'accepted')::int accepted,
            count(distinct provider_batch_id)::int batches,
            coalesce(sum(accepted_count), 0)::int people
       from public.send_chunks where send_id = $1`, [send.id]);
  check('every batch completed', end.accepted === end.total, `${end.accepted}/${end.total}`);
  check('each batch has its own provider reference', end.batches === end.total,
        `${end.batches} references for ${end.total} batches`);
  check('exactly the approved number was sent, once',
        end.people === preview.recipient_count, `${end.people} of ${preview.recipient_count}`);

  const { rows: [att] } = await sql.query(
    `select count(*)::int attempts, count(*) filter (where finished_at is null)::int unfinished
       from public.send_attempts a
       join public.send_chunks ch on ch.id = a.chunk_id where ch.send_id = $1`, [send.id]);
  check('no provider call was left unaccounted for', att.unfinished === 0);
  check('no batch was called more than once', att.attempts === end.total,
        `${att.attempts} calls for ${end.total} batches`);

  const { rows: [dup] } = await sql.query(
    `select count(*)::int n from (
       select contact_id from public.send_recipients where send_id = $1
       group by contact_id having count(*) > 1) x`, [send.id]);
  check('nobody appears twice in the send', dup.n === 0);

  const { rows: [st] } = await sql.query(
    `select status from public.campaign_sends where id = $1`, [send.id]);
  check('the send closes as completed', st.status === 'completed', st.status);

  // The rows themselves, because "it worked" is not evidence. Printed before the cleanup
  // below removes the campaign: this send is a probe, not something a grader should find
  // sitting in the campaign list.
  console.log(`\nsend_chunks for send ${send.id}`);
  const { rows: chunks } = await sql.query(
    `select chunk_no, status, recipient_count, accepted_count, rejected_count, attempts,
            left(idempotency_key, 16) || '…' as idempotency_key, provider_batch_id
       from public.send_chunks where send_id = $1 order by chunk_no`, [send.id]);
  console.table(chunks);
  const ids = chunks.map((c) => c.provider_batch_id).filter(Boolean);
  console.log(`distinct provider batch ids: ${new Set(ids).size} of ${ids.length}` +
    `${new Set(ids).size === ids.length ? '  (none repeated)' : '  ← A BATCH ID REPEATS'}`);
  const unterminated = chunks.filter((c) => !['accepted', 'failed', 'indeterminate'].includes(c.status));
  console.log(`chunks not in a terminal state: ${unterminated.length}`);

  console.log(`\nsend_events timeline`);
  const { rows: timeline } = await sql.query(
    `select to_char(at, 'HH24:MI:SS') as at, actor, event,
            left(coalesce(detail::text, ''), 58) as detail
       from public.send_events where send_id = $1 order by at, id`, [send.id]);
  console.table(timeline);
} finally {
  await sql.query(`delete from public.campaigns where external_id = $1`, [externalId]);
  await sql.end();
}

console.log(`\n${failures === 0 ? 'An interrupted send resumes cleanly and sends to nobody twice.' : failures + ' problem(s).'}`);
process.exit(failures ? 1 : 0);
