// scripts/probe-provider.ts
//
// Hour-one reconnaissance of the messaging provider. It answers, empirically:
//   1. What does POST /v1/messages return (accepted / rejected item shapes)?
//   2. Does the same Idempotency-Key + same body replay the same batch_id?
//   3. What happens with the same key + a different body?
//   4. What is the largest recipient batch the provider accepts (50 → 500 → 2000)?
//   5. What do events look like, which types exist, and does `since` take next_cursor or an event id?
//
// Raw responses are written ONLY to PROBE_OUT_DIR (default: a temp dir outside the repo).
// stdout prints shapes and counts. The API key is never printed.
//
// Usage: node scripts/probe-provider.ts            (Node ≥ 23 runs TypeScript directly)
//   env: PROVIDER_BASE_URL, PROVIDER_API_KEY (read from .env), SEED_DIR (extracted seed CSVs),
//        PROBE_OUT_DIR (where raw JSON goes), PROBE_MAX_SIZES (default "50,500,2000")

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Recipient = { id: string; email: string };

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return out;
}

const env = loadEnv();
const BASE = (env.PROVIDER_BASE_URL ?? '').replace(/\/$/, '');
const KEY = env.PROVIDER_API_KEY ?? '';
if (!BASE || !KEY) {
  console.error('PROVIDER_BASE_URL and PROVIDER_API_KEY must be set (in .env).');
  process.exit(1);
}
const OUT_DIR = env.PROBE_OUT_DIR ?? join(tmpdir(), 'campaign-portal-probe');
mkdirSync(OUT_DIR, { recursive: true });
const SEED_DIR = env.SEED_DIR ?? '';
const MAX_SIZES = (env.PROBE_MAX_SIZES ?? '50,500,2000').split(',').map((s) => Number(s.trim())).filter(Boolean);

const log: Json[] = [];
const started = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = join(OUT_DIR, `probe-${started}.json`);

function shape(v: Json, depth = 0): string {
  if (depth > 4) return '…';
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `[${shape(v[0], depth + 1)} ×${v.length}]` : '[]';
  if (typeof v === 'object') {
    const inner = Object.entries(v)
      .map(([k, x]) => `${k}: ${shape(x, depth + 1)}`)
      .join(', ');
    return `{${inner}}`;
  }
  if (typeof v === 'string') return v.length > 40 ? 'string' : `"${v}"`;
  return typeof v;
}

async function call(
  step: string,
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: Json; idempotencyKey?: string } = {},
): Promise<{ status: number; body: Json; ms: number; headers: Record<string, string> }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const t0 = Date.now();
  let status = 0;
  let body: Json = null;
  const resHeaders: Record<string, string> = {};
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    status = res.status;
    res.headers.forEach((v, k) => (resHeaders[k] = v));
    const text = await res.text();
    try {
      body = JSON.parse(text) as Json;
    } catch {
      body = text.slice(0, 2000);
    }
  } catch (e) {
    body = `NETWORK_ERROR: ${(e as Error).message}`;
  }
  const ms = Date.now() - t0;
  const bodySummary =
    opts.body && typeof opts.body === 'object' && !Array.isArray(opts.body) && Array.isArray((opts.body as { recipients?: Json }).recipients)
      ? { ...(opts.body as object), recipients: `[${((opts.body as { recipients: Json[] }).recipients).length} recipients]` }
      : opts.body ?? null;
  log.push({
    step,
    request: { method, path, idempotencyKey: opts.idempotencyKey ?? null, body: bodySummary as Json },
    response: { status, ms, headers: resHeaders, body },
  });
  writeFileSync(outFile, JSON.stringify(log, null, 2));
  console.log(`\n[${step}] ${method} ${path} → ${status} (${ms} ms)`);
  console.log(`  shape: ${shape(body)}`);
  return { status, body, ms, headers: resHeaders };
}

function seedRecipients(n: number): Recipient[] {
  // Prefer real seed contacts (the brief asks that everything stays inside the data we were given).
  const out: Recipient[] = [];
  const seen = new Set<string>();
  const file = SEED_DIR ? join(SEED_DIR, 'kilele-contacts.csv') : '';
  if (file && existsSync(file)) {
    const lines = readFileSync(file, 'utf8').replace(/^﻿/, '').split('\n');
    for (const line of lines.slice(1)) {
      const f = line.split(',');
      if (f.length !== 13) continue;
      const id = f[0].trim();
      const email = f[2].trim().toLowerCase();
      if (!/^CT-\d+$/.test(id)) continue;
      if (!/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) continue;
      if (seen.has(email)) continue;
      seen.add(email);
      out.push({ id, email });
      if (out.length >= n) break;
    }
  }
  while (out.length < n) {
    const i = out.length + 1;
    out.push({ id: `probe-${i}`, email: `probe.${i}@vg-eval.test` });
  }
  return out;
}

function pick<T>(v: Json, key: string): T | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? ((v as Record<string, Json>)[key] as unknown as T) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Provider probe → ${BASE}`);
  console.log(`Raw output → ${outFile}`);
  const summary: Record<string, Json> = {};

  await call('health', 'GET', '/healthz');

  // ---- 1. small batch, object recipients --------------------------------------------------
  const pool = seedRecipients(Math.max(...MAX_SIZES, 3));
  const two = pool.slice(0, 2);
  const k1 = `probe-${randomUUID()}`;
  const body1: Json = { campaign: 'PROBE', brand: 'PROBE', recipients: two as unknown as Json[] };
  const r1 = await call('send-2-objects', 'POST', '/v1/messages', { body: body1, idempotencyKey: k1 });
  const batch1 = pick<string>(r1.body, 'batch_id');
  summary.post_status = r1.status;
  summary.post_shape = shape(r1.body);
  summary.batch1 = batch1 ?? null;
  const acc = pick<Json[]>(r1.body, 'accepted');
  const rej = pick<Json[]>(r1.body, 'rejected');
  summary.accepted_item_shape = acc && acc.length ? shape(acc[0]) : 'n/a';
  summary.rejected_item_shape = rej && rej.length ? shape(rej[0]) : 'empty';

  // ---- 2. replay: same key, same body ------------------------------------------------------
  const r2 = await call('replay-same-key-same-body', 'POST', '/v1/messages', { body: body1, idempotencyKey: k1 });
  const batch2 = pick<string>(r2.body, 'batch_id');
  summary.replay_status = r2.status;
  summary.replay_same_batch_id = batch1 !== undefined && batch1 === batch2;

  // ---- 3. same key, different body ---------------------------------------------------------
  const body3: Json = { campaign: 'PROBE', brand: 'PROBE', recipients: pool.slice(0, 3) as unknown as Json[] };
  const r3 = await call('same-key-different-body', 'POST', '/v1/messages', { body: body3, idempotencyKey: k1 });
  summary.same_key_diff_body_status = r3.status;
  summary.same_key_diff_body_batch_equals_first = pick<string>(r3.body, 'batch_id') === batch1;

  // ---- 4. string recipients ----------------------------------------------------------------
  const r4 = await call('send-2-strings', 'POST', '/v1/messages', {
    body: { campaign: 'PROBE', brand: 'PROBE', recipients: two.map((r) => r.id) },
    idempotencyKey: `probe-${randomUUID()}`,
  });
  summary.string_recipients_status = r4.status;

  // ---- 5. max batch size -------------------------------------------------------------------
  const sizeResults: Json[] = [];
  let largestOk = 0;
  let sizeBatch: string | undefined;
  for (const n of MAX_SIZES) {
    const r = await call(`size-${n}`, 'POST', '/v1/messages', {
      body: { campaign: 'PROBE', brand: 'PROBE', recipients: pool.slice(0, n) as unknown as Json[] },
      idempotencyKey: `probe-${randomUUID()}`,
    });
    const a = pick<Json[]>(r.body, 'accepted')?.length ?? null;
    const j = pick<Json[]>(r.body, 'rejected')?.length ?? null;
    sizeResults.push({ n, status: r.status, ms: r.ms, accepted: a, rejected: j });
    if (r.status >= 200 && r.status < 300) {
      largestOk = n;
      sizeBatch = pick<string>(r.body, 'batch_id');
    } else break;
  }
  summary.batch_sizes = sizeResults;
  summary.largest_accepted_batch = largestOk;

  // ---- 6. events: immediately, then after a pause ------------------------------------------
  const targets = [batch1, sizeBatch].filter((b): b is string => !!b);
  const eventTypes = new Set<string>();
  for (const b of targets) {
    const e1 = await call(`events-${b}-t0`, 'GET', `/v1/messages/${b}/events`);
    const evs = pick<Json[]>(e1.body, 'events') ?? [];
    summary[`events_${b}_t0_count`] = evs.length;
    if (evs.length) summary.event_item_shape = shape(evs[0]);
    for (const ev of evs) {
      const t = pick<string>(ev, 'event_type') ?? pick<string>(ev, 'type');
      if (t) eventTypes.add(t);
    }
  }
  console.log('\nWaiting 15 s for the report stream to move…');
  await sleep(15_000);
  for (const b of targets) {
    const e2 = await call(`events-${b}-t15`, 'GET', `/v1/messages/${b}/events`);
    const evs = pick<Json[]>(e2.body, 'events') ?? [];
    summary[`events_${b}_t15_count`] = evs.length;
    for (const ev of evs) {
      const t = pick<string>(ev, 'event_type') ?? pick<string>(ev, 'type');
      if (t) eventTypes.add(t);
    }
    const next = pick<string>(e2.body, 'next_cursor');
    const hasMore = pick<boolean>(e2.body, 'has_more');
    summary[`events_${b}_next_cursor`] = next ?? null;
    summary[`events_${b}_has_more`] = hasMore ?? null;
    if (next) {
      const e3 = await call(`events-${b}-since-next_cursor`, 'GET', `/v1/messages/${b}/events?since=${encodeURIComponent(next)}`);
      summary[`events_${b}_since_next_cursor_count`] = (pick<Json[]>(e3.body, 'events') ?? []).length;
    }
    const firstId = evs.length ? pick<string>(evs[0], 'event_id') ?? pick<string>(evs[0], 'id') : undefined;
    if (firstId) {
      const e4 = await call(`events-${b}-since-first-event-id`, 'GET', `/v1/messages/${b}/events?since=${encodeURIComponent(firstId)}`);
      summary[`events_${b}_since_first_event_id_count`] = (pick<Json[]>(e4.body, 'events') ?? []).length;
      summary[`events_${b}_since_first_event_id_status`] = e4.status;
    }
    // ordering check: are events sorted by occurred_at as returned?
    const times = evs.map((ev) => pick<string>(ev, 'occurred_at') ?? pick<string>(ev, 'occurred_at_utc') ?? pick<string>(ev, 'timestamp') ?? '');
    let outOfOrder = 0;
    for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) outOfOrder++;
    summary[`events_${b}_out_of_order_pairs`] = outOfOrder;
    const ids = evs.map((ev) => pick<string>(ev, 'event_id') ?? pick<string>(ev, 'id') ?? '');
    summary[`events_${b}_duplicate_ids`] = ids.length - new Set(ids).size;
  }
  summary.event_types_seen = [...eventTypes].sort();

  await call('events-unknown-batch', 'GET', '/v1/messages/does-not-exist/events');

  console.log('\n================ SUMMARY (shapes and counts only) ================');
  console.log(JSON.stringify(summary, null, 2));
  writeFileSync(join(OUT_DIR, `probe-${started}-summary.json`), JSON.stringify(summary, null, 2));
  console.log(`\nRaw log: ${outFile}`);
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
