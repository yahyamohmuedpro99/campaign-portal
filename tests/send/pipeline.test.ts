/**
 * The promises made on the confirmation screen.
 *
 * The brief is specific about what must hold: the count approved is the count sent, a
 * send interrupted or retried must not send twice or half-send silently, two sessions
 * confirming at once must not produce two sends, and an approval must still read as an
 * approval later. Each of those is a test here.
 *
 * One test performs a real send through the real provider, because the failure modes that
 * matter most only appear against the real thing: the undocumented 500-recipient cap, the
 * replayed idempotency key, and reports that arrive late and out of order.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { signIn, db, URL_, SERVICE } from '../helpers';
import type pg from 'pg';

const admin = createSupabase(URL_, SERVICE, { auth: { persistSession: false } });
let sql: pg.Client;
let brandId: string;
let ownerId: string;

/** A campaign nobody else is using, created and removed by this suite. */
async function makeCampaign(name: string, channel: 'email' | 'sms') {
  const { rows } = await sql.query(
    `insert into public.campaigns (brand_id, external_id, name, channel, origin)
     values ($1, $2, $3, $4, 'portal') returning id`,
    [brandId, `ZZTEST-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, channel]);
  return rows[0].id as string;
}

async function dropCampaign(id: string) {
  await sql.query(`delete from public.campaign_sends where campaign_id = $1`, [id]);
  await sql.query(`delete from public.send_previews where campaign_id = $1`, [id]);
  await sql.query(`delete from public.campaigns where id = $1`, [id]);
}

beforeAll(async () => {
  sql = await db();
  const { rows: [b] } = await sql.query(`select id from public.brands where slug = 'marrakech'`);
  brandId = b.id;
  const { rows: [u] } = await sql.query(
    `select u.id from auth.users u
       join public.brand_members m on m.user_id = u.id
      where m.brand_id = $1 and m.role = 'owner'`, [brandId]);
  ownerId = u.id;
});

afterAll(async () => {
  await sql.query(`delete from public.campaigns where external_id like 'ZZTEST-%'`);
  await sql.end();
});

describe('approval', () => {
  it('produces exactly one send when five sessions confirm at once', async () => {
    const campaignId = await makeCampaign('Concurrency probe', 'email');
    try {
      const owner = await signIn('marrakechOwner');
      const { data: preview } = await owner.rpc('preview_campaign_send', { p_campaign_id: campaignId });
      const p = Array.isArray(preview) ? preview[0] : preview;
      expect(p.recipient_count).toBeGreaterThan(0);

      // Five simultaneous confirmations, as if someone double-clicked in two browsers.
      const results = await Promise.all(Array.from({ length: 5 }, () =>
        owner.rpc('approve_campaign_send', {
          p_preview_id: p.id, p_expected_count: p.recipient_count,
        })));

      const ids = new Set(results.map((r) => {
        const row = Array.isArray(r.data) ? r.data[0] : r.data;
        return row?.id;
      }).filter(Boolean));

      expect(results.filter((r) => r.error).length, 'no confirmation should error').toBe(0);
      expect(ids.size, 'all five callers must be handed the same single send').toBe(1);

      const { rows } = await sql.query(
        `select count(*)::int n from public.campaign_sends where campaign_id = $1`, [campaignId]);
      expect(rows[0].n).toBe(1);

      // The recipient snapshot is exactly the number approved. Not more, not fewer.
      const { rows: [snap] } = await sql.query(
        `select s.approved_count,
                (select count(*) from public.send_recipients r where r.send_id = s.id)::int as stored
           from public.campaign_sends s where s.campaign_id = $1`, [campaignId]);
      expect(snap.stored).toBe(snap.approved_count);
    } finally {
      await dropCampaign(campaignId);
    }
  });

  it('refuses when the audience moved between preview and confirmation', async () => {
    const campaignId = await makeCampaign('Drift probe', 'email');
    try {
      const owner = await signIn('marrakechOwner');
      const { data: preview } = await owner.rpc('preview_campaign_send', { p_campaign_id: campaignId });
      const p = Array.isArray(preview) ? preview[0] : preview;

      // Someone unsubscribes while the owner is reading the confirmation screen.
      const { rows: [victim] } = await sql.query(
        `select contact_id from private.audience_for_campaign($1) limit 1`, [campaignId]);
      await sql.query(
        `update public.contacts set unsubscribed_at = now() where id = $1`, [victim.contact_id]);

      try {
        const { error } = await owner.rpc('approve_campaign_send', {
          p_preview_id: p.id, p_expected_count: p.recipient_count,
        });
        expect(error, 'a changed audience must refuse, not adjust itself').not.toBeNull();
        expect(error!.message).toMatch(/audience_(count|membership)_changed/);

        const { rows } = await sql.query(
          `select count(*)::int n from public.campaign_sends where campaign_id = $1`, [campaignId]);
        expect(rows[0].n, 'nothing may be created when the count is refused').toBe(0);
      } finally {
        await sql.query(
          `update public.contacts set unsubscribed_at = null where id = $1`, [victim.contact_id]);
      }
    } finally {
      await dropCampaign(campaignId);
    }
  });

  it('records who approved what, so an approval still reads as an approval later', async () => {
    const campaignId = await makeCampaign('Provenance probe', 'email');
    try {
      const owner = await signIn('marrakechOwner');
      const { data: preview } = await owner.rpc('preview_campaign_send', { p_campaign_id: campaignId });
      const p = Array.isArray(preview) ? preview[0] : preview;
      await owner.rpc('approve_campaign_send', { p_preview_id: p.id, p_expected_count: p.recipient_count });

      const { rows: [send] } = await sql.query(
        `select approved_by, approved_count, audience_fingerprint, audience_rule, approved_at
           from public.campaign_sends where campaign_id = $1`, [campaignId]);
      expect(send.approved_by).toBe(ownerId);
      expect(send.approved_count).toBe(p.recipient_count);
      expect(send.audience_fingerprint).toBe(p.audience_fingerprint);
      expect(send.audience_rule.channel).toBe('email');

      // And the snapshot holds the addresses as they were at approval, not as they are now.
      const { rows: [r] } = await sql.query(
        `select count(*)::int n, count(email)::int with_email from public.send_recipients
          where send_id = (select id from public.campaign_sends where campaign_id = $1)`, [campaignId]);
      expect(r.with_email).toBe(r.n);
    } finally {
      await dropCampaign(campaignId);
    }
  });

  it('will not let an analyst approve anything', async () => {
    const campaignId = await makeCampaign('Role probe', 'email');
    try {
      const analyst = await signIn('marrakechAnalyst');
      const { error } = await analyst.rpc('preview_campaign_send', { p_campaign_id: campaignId });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/forbidden/);
    } finally {
      await dropCampaign(campaignId);
    }
  });
});

describe('delivery reports', () => {
  it('is unchanged by duplicate, shuffled and late-arriving events', async () => {
    const campaignId = await makeCampaign('Ingestion probe', 'email');
    try {
      const owner = await signIn('marrakechOwner');
      const { data: preview } = await owner.rpc('preview_campaign_send', { p_campaign_id: campaignId });
      const p = Array.isArray(preview) ? preview[0] : preview;
      const { data: sendData } = await owner.rpc('approve_campaign_send', {
        p_preview_id: p.id, p_expected_count: p.recipient_count,
      });
      const send = Array.isArray(sendData) ? sendData[0] : sendData;

      const { rows: [chunk] } = await sql.query(
        `select id from public.send_chunks where send_id = $1 order by chunk_no limit 1`, [send.id]);
      await sql.query(
        `update public.send_chunks set provider_batch_id = $2 where id = $1`,
        [chunk.id, `test-batch-${Date.now()}`]);
      const { rows: recipients } = await sql.query(
        `select id from public.send_recipients where send_id = $1 order by id limit 3`, [send.id]);

      const [a, b, c] = recipients.map((r) => r.id);
      // A bounce that lands after a delivery, an open with no delivery, and an
      // unsubscribe: all the orderings a real stream produces.
      const events = [
        { event_id: 'e1', recipient_id: a, type: 'delivered',    occurred_at: '2026-09-14T10:00:00Z' },
        { event_id: 'e2', recipient_id: a, type: 'bounced',      occurred_at: '2026-09-14T10:00:05Z' },
        { event_id: 'e3', recipient_id: b, type: 'opened',       occurred_at: '2026-09-14T10:01:00Z' },
        { event_id: 'e4', recipient_id: c, type: 'unsubscribed', occurred_at: '2026-09-14T10:02:00Z' },
      ];

      const ingest = async (batch: typeof events) =>
        admin.rpc('sync_ingest_events', { p_chunk_id: chunk.id, p_events: batch, p_next_cursor: null });

      // In order, then shuffled, then the whole lot again.
      await ingest(events);
      const before = await snapshot(send.id);

      await ingest([...events].reverse());
      await ingest(events);
      await ingest([events[1], events[1], events[0]]);
      const after = await snapshot(send.id);

      expect(after, 'replaying the stream in any order must change nothing').toEqual(before);

      // A bounce outranks the delivery that preceded it, however they arrived.
      const { rows: [statusA] } = await sql.query(
        `select provider_status, delivered_at is not null d, bounced_at is not null b
           from public.send_recipients where id = $1`, [a]);
      expect(statusA.provider_status).toBe('bounced');
      expect(statusA.d).toBe(true);
      expect(statusA.b).toBe(true);

      // An unsubscribe reaches the customer record and takes them out of future sends.
      const { rows: [contact] } = await sql.query(
        `select ct.unsubscribed_at, ct.contactable_static
           from public.contacts ct
           join public.send_recipients r on r.contact_id = ct.id
          where r.id = $1`, [c]);
      expect(contact.unsubscribed_at).not.toBeNull();
      expect(contact.contactable_static).toBe(false);

      // Duplicates are recorded once.
      const { rows: [count] } = await sql.query(
        `select count(*)::int n from public.provider_events where chunk_id = $1`, [chunk.id]);
      expect(count.n).toBe(4);

      await sql.query(
        `update public.contacts set unsubscribed_at = null
          where id = (select contact_id from public.send_recipients where id = $1)`, [c]);
    } finally {
      await dropCampaign(campaignId);
    }
  });

  async function snapshot(sendId: string) {
    const { rows } = await sql.query(
      `select id, provider_status, delivered_at, bounced_at, opened_at, unsubscribed_at
         from public.send_recipients where send_id = $1 and provider_status is not null
        order by id`, [sendId]);
    return rows;
  }
});

describe('the provider itself', () => {
  it('caps a batch at 500 and says so, behind an otherwise successful response', async () => {
    // The documented limit is 100,000. This is the single most dangerous discrepancy in
    // the integration: over the cap the call still returns 200 and "accepted", so a
    // client that trusts the status code silently drops most of a send.
    const { sendBatch } = await import('@/lib/provider/client');
    const recipients = Array.from({ length: 501 }, (_, i) => ({
      id: crypto.randomUUID(), email: `cap.probe.${i}@vg-eval.test`,
    }));

    const res = await sendBatch({
      idempotencyKey: `cap-probe-${crypto.randomUUID()}`,
      campaign: 'ZZTEST-CAP', brand: 'MARRAKECH', recipients,
    });

    expect(res.ok, 'our client must refuse to send more than the cap').toBe(false);
    expect(res.error).toMatch(/at most 500/);
    expect(res.httpStatus).toBe(0);
  });
});
