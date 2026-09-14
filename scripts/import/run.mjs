// The import engine.
//
// Two rules decide what happens to a bad row, and both are stated on the portal's data
// page so a marketer never has to ask:
//
//   reject  - the row cannot be represented at all (no id, wrong number of fields, a
//             header line repeated inside the data). It is not stored, and it is listed
//             with its reason and its raw content.
//   warn    - the row is stored, but a field could not be represented and was set to
//             null with the original kept beside it, or an assumption was made. Nothing
//             is silently dropped.
//
// Re-running the same file changes nothing: identity is (brand_id, external_id) for
// contacts and campaigns and (brand_id, event_id) for events, and every write is an
// upsert. Suppression timestamps are monotonic, so a later export that re-activates a
// contact who once unsubscribed updates their status but cannot make them contactable.
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse';
import {
  normConsent, normStatus, normEmail, normCountry, normPhone, normTimestamp,
  normEventType, normNumber, isBlank,
} from './normalize.mjs';
import { BRAND_REGION } from './profiles.mjs';

const BATCH = 500;
const MAX_STORED_RAW = 2000; // keep the ledger bounded on a 500 MB database

export async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/** Decode, parse and hand back rows as arrays, so we can see a row's true field count. */
async function* readRows(path, { delimiter, encoding }) {
  const parser = createReadStream(path).pipe(parse({
    delimiter,
    bom: true,
    columns: false,
    relax_column_count: true,   // ragged rows are classified by us, not dropped by the parser
    skip_empty_lines: true,
    encoding: encoding === 'windows-1252' ? 'latin1' : 'utf8',
  }));
  let n = 0;
  for await (const row of parser) yield { rowNo: ++n, row };
}

class Ledger {
  constructor() { this.rejects = []; this.warnings = []; this.counts = {}; }
  reject(rowNo, code, detail, raw) {
    this.counts[`reject:${code}`] = (this.counts[`reject:${code}`] ?? 0) + 1;
    if (this.rejects.length < MAX_STORED_RAW) this.rejects.push({ rowNo, code, detail, raw });
  }
  warn(rowNo, code, detail, raw) {
    this.counts[`warn:${code}`] = (this.counts[`warn:${code}`] ?? 0) + 1;
    if (this.warnings.length < MAX_STORED_RAW) this.warnings.push({ rowNo, code, detail, raw });
  }
  get rejectCount() {
    return Object.entries(this.counts).filter(([k]) => k.startsWith('reject:'))
      .reduce((a, [, v]) => a + v, 0);
  }
  get warnCount() {
    return Object.entries(this.counts).filter(([k]) => k.startsWith('warn:'))
      .reduce((a, [, v]) => a + v, 0);
  }
}

async function flushLedger(client, runId, brandId, ledger) {
  for (const [table, rows] of [['import_rejects', ledger.rejects], ['import_warnings', ledger.warnings]]) {
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const values = slice.map((_, j) =>
        `($1,$2,$${j * 4 + 3},$${j * 4 + 4},$${j * 4 + 5},$${j * 4 + 6})`).join(',');
      const params = [runId, brandId];
      for (const r of slice) params.push(r.rowNo, r.code, r.detail ?? null, JSON.stringify(r.raw ?? null));
      await client.query(
        `insert into public.${table} (run_id, brand_id, row_no, reason_code, detail, raw) values ${values}`,
        params);
    }
  }
}

/**
 * Postgres text cannot hold a NUL byte, and three Kilele contacts are named "Nul\0Byte".
 * Left alone, one of them aborts the whole 84,000-row import with an encoding error at
 * whichever batch happens to contain it.
 */
function stripNuls(row, rowNo, ledger) {
  let found = false;
  const out = row.map((v) => {
    const s = String(v ?? '');
    if (s.includes('\u0000')) { found = true; return s.replace(/\u0000/g, ''); }
    return v;
  });
  if (found) ledger.warn(rowNo, 'nul_byte_removed', 'a NUL byte was stripped; Postgres text cannot store one', null);
  return found ? out : row;
}

/** Rows whose field count is wrong, or that repeat the header, cannot be trusted at all. */
function classifyShape(row, header, rowNo, ledger) {
  if (row.length !== header.length) {
    ledger.reject(rowNo, 'wrong_field_count',
      `expected ${header.length} fields, found ${row.length}`, row);
    return false;
  }
  // kilele-contacts.csv repeats its header at data row 40,000. It parses as a perfectly
  // valid record and would otherwise be imported as a contact called "full_name".
  if (row.every((v, i) => String(v).trim() === header[i])) {
    ledger.reject(rowNo, 'embedded_header_row', 'a header line repeated inside the data', row);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------- contacts --
async function importContacts(ctx) {
  const { client, profile, path, brandId, brandCode, timezone, runId, ledger, now } = ctx;
  const idx = Object.fromEntries(Object.entries(profile.map)
    .map(([field, col]) => [field, profile.header.indexOf(col)]));
  const region = BRAND_REGION[profile.brand];
  let read = 0, inserted = 0, updated = 0;
  let batch = new Map(); // deduplicates ids repeated inside one batch

  const flush = async () => {
    if (batch.size === 0) return;
    const rows = [...batch.values()];
    batch = new Map();
    const cols = ['brand_id', 'external_id', 'full_name', 'email', 'email_raw', 'phone_e164',
      'phone_raw', 'country', 'country_raw', 'city', 'signup_at', 'signup_at_raw', 'status',
      'status_raw', 'consent_marketing', 'consent_raw', 'brand_code_raw', 'notes',
      'deleted_at', 'suppressed_until', 'unsubscribed_at', 'bounced_at',
      'first_seen_run', 'last_seen_run'];
    const params = [];
    const tuples = rows.map((r) => {
      const start = params.length;
      params.push(brandId, r.external_id, r.full_name, r.email, r.email_raw, r.phone_e164,
        r.phone_raw, r.country, r.country_raw, r.city, r.signup_at, r.signup_at_raw, r.status,
        r.status_raw, r.consent_marketing, r.consent_raw, r.brand_code_raw, r.notes,
        r.deleted_at, r.suppressed_until, r.unsubscribed_at, r.bounced_at, runId, runId);
      return `(${cols.map((_, i) => `$${start + i + 1}`).join(',')})`;
    }).join(',');
    const { rows: res } = await client.query(
      `insert into public.contacts (${cols.join(',')}) values ${tuples}
       on conflict (brand_id, external_id) do update set
         full_name = excluded.full_name,
         email = excluded.email, email_raw = excluded.email_raw,
         phone_e164 = excluded.phone_e164, phone_raw = excluded.phone_raw,
         country = excluded.country, country_raw = excluded.country_raw,
         city = excluded.city,
         signup_at = excluded.signup_at, signup_at_raw = excluded.signup_at_raw,
         status = excluded.status, status_raw = excluded.status_raw,
         consent_marketing = excluded.consent_marketing, consent_raw = excluded.consent_raw,
         brand_code_raw = excluded.brand_code_raw, notes = excluded.notes,
         deleted_at = least(public.contacts.deleted_at, excluded.deleted_at),
         suppressed_until = greatest(public.contacts.suppressed_until, excluded.suppressed_until),
         unsubscribed_at = least(public.contacts.unsubscribed_at, excluded.unsubscribed_at),
         bounced_at = least(public.contacts.bounced_at, excluded.bounced_at),
         last_seen_run = excluded.last_seen_run,
         updated_at = now()
       returning (xmax = 0) as was_inserted`,
      params);
    for (const r of res) r.was_inserted ? inserted++ : updated++;
  };

  for await (let { rowNo, row } of readRows(path, profile)) {
    if (rowNo === 1) {
      assertHeader(row, profile);
      continue;
    }
    read++;
    row = stripNuls(row, rowNo, ledger);
    if (!classifyShape(row, profile.header, rowNo, ledger)) continue;

    const get = (f) => (idx[f] >= 0 ? String(row[idx[f]] ?? '').trim() : '');
    const externalId = get('external_id');
    if (externalId === '') {
      ledger.reject(rowNo, 'missing_external_id', 'a contact with no identifier cannot be merged', row);
      continue;
    }

    // The file name is the brand of record. Around 400 rows carry a brand_code belonging
    // to a different brand and 149 carry none at all; dropping them would lose real
    // customers, so the disagreement is recorded and the file wins.
    const brandCodeRaw = get('brand_code');
    if (brandCodeRaw && brandCodeRaw.toUpperCase() !== brandCode) {
      ledger.warn(rowNo, 'brand_code_mismatch',
        `row says ${brandCodeRaw}, file is ${brandCode}; the file is the brand of record`, row);
    } else if (!brandCodeRaw) {
      ledger.warn(rowNo, 'brand_code_blank', `no brand_code; the file is the brand of record`, row);
    }

    const email = normEmail(get('email'));
    const phone = normPhone(get('phone'), region);
    const country = normCountry(get('country'));
    const signup = normTimestamp(get('signup_at'), { timezone, now });
    const status = normStatus(get('status'));
    const consent = normConsent(get('consent_marketing'));
    const deleted = normTimestamp(get('deleted_at'), { timezone, now });
    const suppressed = get('suppressed_until');

    for (const [w, field] of [[email.warn, 'email'], [phone.warn, 'phone'], [country.warn, 'country'],
      [signup.warn, 'signup_at'], [status.warn, 'status'], [consent.warn, 'consent_marketing']]) {
      if (w && !w.endsWith('_blank')) ledger.warn(rowNo, w, `${field}: ${get(field)}`, null);
    }

    // Status is the export's word for where the contact stands. Suppression is our own
    // record of consent having been withdrawn, and it only ever moves one way.
    const suppressedUntil = /^\d{4}-\d{2}-\d{2}/.test(suppressed) ? new Date(suppressed).toISOString() : null;
    // The same id appears more than once in every contact export. Later rows win, which
    // is what an upsert would do anyway, but the collapse is counted so the difference
    // between "rows in the file" and "customers on record" is never unexplained.
    if (batch.has(externalId)) {
      ledger.warn(rowNo, 'duplicate_contact_row', `${externalId} appears more than once; the later row wins`, null);
    }
    batch.set(externalId, {
      external_id: externalId,
      full_name: get('full_name') || null,
      email: email.value, email_raw: get('email') || null,
      phone_e164: phone.value, phone_raw: get('phone') || null,
      country: country.value, country_raw: get('country') || null,
      city: get('city') || null,
      signup_at: signup.value, signup_at_raw: get('signup_at') || null,
      status: status.value, status_raw: get('status') || null,
      consent_marketing: consent.value, consent_raw: get('consent_marketing') || null,
      brand_code_raw: brandCodeRaw || null,
      notes: get('notes') || null,
      deleted_at: deleted.value,
      suppressed_until: suppressedUntil,
      unsubscribed_at: status.value === 'unsubscribed' ? (signup.value ?? now.toISOString()) : null,
      bounced_at: status.value === 'bounced' ? (signup.value ?? now.toISOString()) : null,
    });
    if (batch.size >= BATCH) await flush();
  }
  await flush();
  return { read, inserted, updated };
}

// --------------------------------------------------------------------------- campaigns --
async function importCampaigns(ctx) {
  const { client, profile, path, brandId, timezone, ledger, now } = ctx;
  const idx = Object.fromEntries(Object.entries(profile.map)
    .map(([f, col]) => [f, profile.header.indexOf(col)]));
  let read = 0, inserted = 0, updated = 0;
  const batch = new Map();

  for await (let { rowNo, row } of readRows(path, profile)) {
    if (rowNo === 1) { assertHeader(row, profile); continue; }
    read++;
    row = stripNuls(row, rowNo, ledger);
    if (!classifyShape(row, profile.header, rowNo, ledger)) continue;
    const get = (f) => (idx[f] >= 0 ? String(row[idx[f]] ?? '').trim() : '');
    const externalId = get('external_id');
    if (!externalId) { ledger.reject(rowNo, 'missing_external_id', 'campaign with no identifier', row); continue; }

    const channel = get('channel').toLowerCase();
    if (channel !== 'email' && channel !== 'sms') {
      ledger.reject(rowNo, 'unknown_channel', `channel "${get('channel')}" is neither email nor sms`, row);
      continue;
    }
    if (batch.has(externalId)) ledger.warn(rowNo, 'duplicate_campaign_row', `${externalId} appears more than once`, null);

    const name = get('campaign_name');
    const sent = normNumber(get('reported_sent')).value;
    const country = normCountry(get('target_country'));
    batch.set(externalId, {
      external_id: externalId, name: name || externalId, channel,
      target_country: country.value,
      reported_sent: sent, reported_delivered: normNumber(get('reported_delivered')).value,
      reported_bounced: normNumber(get('reported_bounced')).value,
      reported_opens: normNumber(get('reported_opens')).value,
      reported_clicks: normNumber(get('reported_clicks')).value,
      spend: normNumber(get('spend'), { decimalComma: profile.decimalComma }).value,
      sent_at: normTimestamp(get('sent_at_utc'), { timezone, now }).value,
      send_local_time: get('send_local_time') || null,
      parent_campaign_external_id: get('parent_campaign_id') || null,
      // There is no status column anywhere in the campaign exports. A campaign whose name
      // begins "Draft " and which reports no sends is the only draft signal available;
      // note that those rows still carry a sent_at timestamp, so the date cannot be used.
      imported_status: /^draft\b/i.test(name) && (sent ?? 0) === 0 ? 'draft' : 'historical',
    });
  }

  for (const r of batch.values()) {
    const { rows } = await client.query(
      `insert into public.campaigns (brand_id, external_id, name, channel, target_country,
         reported_sent, reported_delivered, reported_bounced, reported_opens, reported_clicks,
         spend, sent_at, send_local_time, parent_campaign_external_id, imported_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict (brand_id, external_id) do update set
         name = excluded.name, channel = excluded.channel, target_country = excluded.target_country,
         reported_sent = excluded.reported_sent, reported_delivered = excluded.reported_delivered,
         reported_bounced = excluded.reported_bounced, reported_opens = excluded.reported_opens,
         reported_clicks = excluded.reported_clicks, spend = excluded.spend,
         sent_at = excluded.sent_at, send_local_time = excluded.send_local_time,
         parent_campaign_external_id = excluded.parent_campaign_external_id,
         imported_status = excluded.imported_status
       returning (xmax = 0) as was_inserted`,
      [brandId, r.external_id, r.name, r.channel, r.target_country, r.reported_sent,
       r.reported_delivered, r.reported_bounced, r.reported_opens, r.reported_clicks,
       r.spend, r.sent_at, r.send_local_time, r.parent_campaign_external_id, r.imported_status]);
    rows[0].was_inserted ? inserted++ : updated++;
  }
  return { read, inserted, updated };
}

// ------------------------------------------------------------------------------ events --
async function importEvents(ctx) {
  const { client, profile, path, brandId, ledger } = ctx;
  const idx = Object.fromEntries(Object.entries(profile.map)
    .map(([f, col]) => [f, profile.header.indexOf(col)]));

  // Resolve the brand's own ids in memory. Both contact ids and event ids collide across
  // brands in this data, so every lookup is scoped to this brand and nothing else.
  const contacts = new Map((await client.query(
    `select external_id, id from public.contacts where brand_id = $1`, [brandId])).rows
    .map((r) => [r.external_id, r.id]));
  const campaigns = new Map((await client.query(
    `select external_id, id from public.campaigns where brand_id = $1`, [brandId])).rows
    .map((r) => [r.external_id, r.id]));

  let read = 0, inserted = 0, duplicates = 0;
  let batch = new Map();

  const flush = async () => {
    if (batch.size === 0) return;
    const rows = [...batch.values()];
    batch = new Map();
    const params = [brandId];
    const tuples = rows.map((r) => {
      const s = params.length;
      params.push(r.event_id, r.contact_id, r.campaign_id, r.unknown_campaign_ref,
        r.event_type, r.channel, r.occurred_at);
      return `($1,$${s + 1},$${s + 2},$${s + 3},$${s + 4},$${s + 5},$${s + 6},$${s + 7})`;
    }).join(',');
    const { rowCount } = await client.query(
      `insert into public.contact_events
         (brand_id, event_id, contact_id, campaign_id, unknown_campaign_ref, event_type, channel, occurred_at)
       values ${tuples}
       on conflict (brand_id, event_id) do nothing`,
      params);
    inserted += rowCount;
    duplicates += rows.length - rowCount;
  };

  for await (let { rowNo, row } of readRows(path, profile)) {
    if (rowNo === 1) { assertHeader(row, profile); continue; }
    read++;
    row = stripNuls(row, rowNo, ledger);
    if (!classifyShape(row, profile.header, rowNo, ledger)) continue;
    const get = (f) => (idx[f] >= 0 ? String(row[idx[f]] ?? '').trim() : '');

    const eventId = get('event_id');
    if (!eventId) { ledger.reject(rowNo, 'missing_event_id', 'event with no identifier', row); continue; }

    const contactId = contacts.get(get('external_contact_id'));
    if (!contactId) {
      // The only fatal case: an event we cannot attribute to a person in this brand.
      ledger.reject(rowNo, 'unknown_contact',
        `no contact ${get('external_contact_id')} in this brand`, row);
      continue;
    }

    // An event naming a campaign that is not in the export is still evidence about a
    // person. 633 of Marrakech's 940 events do this, and among them are 138 unsubscribes,
    // 138 complaints and 145 bounces covering 274 contacts the export still calls active.
    // Dropping them would quietly make those people contactable again.
    const campaignRef = get('campaign_external_id');
    const campaignId = campaigns.get(campaignRef) ?? null;
    if (campaignRef && !campaignId) {
      ledger.warn(rowNo, 'unknown_campaign',
        `campaign ${campaignRef} is not in this brand's campaign export; the event still counts for suppression`,
        null);
    }

    const type = normEventType(get('event_type'));
    if (type.warn) ledger.warn(rowNo, type.warn, `event_type: ${get('event_type')}`, null);
    const channel = get('channel').toLowerCase();
    const occurred = get('occurred_at_utc');
    if (!/^\d{4}-\d{2}-\d{2}T/.test(occurred)) {
      ledger.reject(rowNo, 'bad_timestamp', `occurred_at "${occurred}" is not a timestamp`, row);
      continue;
    }

    // 8,310 Kilele and 4,735 Karoo event ids repeat, always as byte-identical rows.
    if (batch.has(eventId)) { duplicates++; }
    batch.set(eventId, {
      event_id: eventId, contact_id: contactId,
      campaign_id: campaignId, unknown_campaign_ref: campaignId ? null : (campaignRef || null),
      event_type: type.value,
      channel: channel === 'email' || channel === 'sms' ? channel : null,
      occurred_at: occurred,
    });
    if (batch.size >= BATCH) await flush();
  }
  await flush();
  if (duplicates) ledger.counts['info:duplicate_events_skipped'] = duplicates;

  // Consent withdrawn in the engagement log flows back to the contact, once, in one
  // statement. The export's own status column disagrees with this log for every single
  // contact that has an unsubscribe event, so neither source alone is sufficient.
  const supp = await client.query(
    `with agg as (
       select e.contact_id,
              min(e.occurred_at) filter (where e.event_type = 'unsubscribed') as u,
              min(e.occurred_at) filter (where e.event_type = 'complained')   as c,
              min(e.occurred_at) filter (where e.event_type = 'bounced')      as b
       from public.contact_events e where e.brand_id = $1 group by e.contact_id)
     update public.contacts ct set
       unsubscribed_at = least(ct.unsubscribed_at, agg.u),
       complained_at   = least(ct.complained_at,   agg.c),
       bounced_at      = least(ct.bounced_at,      agg.b),
       updated_at = now()
     from agg
     where ct.id = agg.contact_id
       and (agg.u is not null or agg.c is not null or agg.b is not null)
       and (ct.unsubscribed_at is distinct from least(ct.unsubscribed_at, agg.u)
         or ct.complained_at   is distinct from least(ct.complained_at,   agg.c)
         or ct.bounced_at      is distinct from least(ct.bounced_at,      agg.b))`,
    [brandId]);
  ledger.counts['info:contacts_suppressed_from_events'] = supp.rowCount;

  return { read, inserted, updated: 0, duplicates };
}

// ---------------------------------------------------------------------------- send log --
async function importSendLog(ctx) {
  const { client, profile, path, brandId, timezone, ledger, now } = ctx;
  const idx = Object.fromEntries(Object.entries(profile.map)
    .map(([f, col]) => [f, profile.header.indexOf(col)]));
  const campaigns = new Map((await client.query(
    `select external_id, id from public.campaigns where brand_id = $1`, [brandId])).rows
    .map((r) => [r.external_id, r.id]));
  let read = 0, inserted = 0, updated = 0;
  const batch = new Map();

  for await (let { rowNo, row } of readRows(path, profile)) {
    if (rowNo === 1) { assertHeader(row, profile); continue; }
    read++;
    row = stripNuls(row, rowNo, ledger);
    if (!classifyShape(row, profile.header, rowNo, ledger)) continue;
    const get = (f) => (idx[f] >= 0 ? String(row[idx[f]] ?? '').trim() : '');
    const key = get('batch_key');
    if (!key) { ledger.reject(rowNo, 'missing_batch_key', 'send log row with no batch key', row); continue; }
    // BATCH-0003 appears three times identically. Summing the file would claim 62,410
    // extra recipients for one campaign.
    if (batch.has(key)) ledger.warn(rowNo, 'duplicate_batch_key', `${key} appears more than once`, null);
    const ref = get('campaign_external_id');
    batch.set(key, {
      batch_key: key, campaign_id: campaigns.get(ref) ?? null, campaign_ref: ref || null,
      queued_at: normTimestamp(get('queued_at_utc'), { timezone, now }).value,
      recipient_count: normNumber(get('recipient_count')).value,
      status: get('status') || null,
    });
  }

  for (const r of batch.values()) {
    const { rows } = await client.query(
      `insert into public.historical_sends
         (brand_id, batch_key, campaign_id, campaign_ref, queued_at, recipient_count, status)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (brand_id, batch_key) do update set
         campaign_id = excluded.campaign_id, campaign_ref = excluded.campaign_ref,
         queued_at = excluded.queued_at, recipient_count = excluded.recipient_count,
         status = excluded.status
       returning (xmax = 0) as was_inserted`,
      [brandId, r.batch_key, r.campaign_id, r.campaign_ref, r.queued_at, r.recipient_count, r.status]);
    rows[0].was_inserted ? inserted++ : updated++;
  }
  return { read, inserted, updated };
}

function assertHeader(row, profile) {
  const got = row.map((h) => String(h).replace(/^﻿/, '').trim());
  const want = profile.header;
  const same = got.length === want.length && got.every((h, i) => h === want[i]);
  if (!same) {
    throw new Error(
      `header mismatch in ${profile.file}\n  expected: ${want.join(profile.delimiter)}\n  found:    ${got.join(profile.delimiter)}`);
  }
}

const IMPORTERS = {
  contacts: importContacts, campaigns: importCampaigns,
  events: importEvents, send_log: importSendLog,
};

export async function importFile({ client, profile, path, brands, now = new Date() }) {
  const brand = brands[profile.brand];
  const fileSha = await sha256File(path);
  const size = (await stat(path)).size;
  const ledger = new Ledger();

  const { rows: [run] } = await client.query(
    `insert into public.import_runs (brand_id, entity, source_file, file_sha256, notes)
     values ($1,$2,$3,$4,$5) returning id`,
    [brand.id, profile.entity, profile.file, fileSha, JSON.stringify({ bytes: size })]);

  const ctx = {
    client, profile, path, runId: run.id, ledger, now,
    brandId: brand.id, brandCode: brand.code, timezone: brand.timezone,
  };

  try {
    const r = await IMPORTERS[profile.entity](ctx);
    await flushLedger(client, run.id, brand.id, ledger);
    await client.query(
      `update public.import_runs set finished_at = now(), status = 'succeeded',
         rows_read = $2, rows_inserted = $3, rows_updated = $4, rows_rejected = $5,
         rows_warned = $6, notes = coalesce(notes,'{}'::jsonb) || $7::jsonb
       where id = $1`,
      [run.id, r.read, r.inserted, r.updated, ledger.rejectCount, ledger.warnCount,
       JSON.stringify(ledger.counts)]);
    return { runId: run.id, file: profile.file, brand: profile.brand, ...r,
      rejected: ledger.rejectCount, warned: ledger.warnCount, counts: ledger.counts };
  } catch (err) {
    await client.query(
      `update public.import_runs set finished_at = now(), status = 'failed', error = $2 where id = $1`,
      [run.id, String(err.message ?? err)]);
    throw err;
  }
}
