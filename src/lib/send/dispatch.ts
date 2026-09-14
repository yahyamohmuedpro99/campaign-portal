import { createHash, randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendBatch, PROVIDER_RECIPIENT_CAP } from '@/lib/provider/client';

/** Whether a repeated Idempotency-Key replays the original batch at this provider.
 *  Verified by scripts/probe-provider.ts, not assumed. Only when this is true may a
 *  chunk whose outcome is unknown be retried without a person deciding. */
export const PROVIDER_REPLAYS_IDEMPOTENT_KEYS =
  process.env.PROVIDER_IDEMPOTENCY !== 'unverified';

export type DispatchOutcome = {
  sendId: string;
  status: string;
  claimed: number;
  accepted: number;
  rejected: number;
  indeterminate: number;
  failed: number;
  finished: boolean;
  note?: string;
};

/**
 * Dispatches as much of a send as fits in the time budget, then returns.
 *
 * Safety rests on three things working together:
 *   1. A lease, so only one dispatcher works a send at a time.
 *   2. A chunk claim taken with SKIP LOCKED, so two dispatchers never take the same chunk.
 *   3. An attempt row committed before the provider is called, so a process that dies
 *      mid-call leaves evidence. On the next pass that chunk is marked indeterminate
 *      rather than re-sent blindly.
 */
export async function dispatchSend(sendId: string, opts: {
  budgetMs?: number; maxChunks?: number; worker?: string;
} = {}): Promise<DispatchOutcome> {
  const budgetMs = opts.budgetMs ?? 240_000;
  const maxChunks = opts.maxChunks ?? Number.POSITIVE_INFINITY;
  const worker = opts.worker ?? `dispatch-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const db = createAdminClient();

  const out: DispatchOutcome = {
    sendId, status: 'unknown', claimed: 0, accepted: 0, rejected: 0,
    indeterminate: 0, failed: 0, finished: false,
  };

  const { data: leased, error: leaseErr } = await db.rpc('dispatch_acquire_lease', {
    p_send_id: sendId, p_owner: worker, p_seconds: 90,
  });
  if (leaseErr) throw new Error(`lease: ${leaseErr.message}`);
  if (!leased) {
    const { data: send } = await db.from('campaign_sends').select('status').eq('id', sendId).single();
    return { ...out, status: send?.status ?? 'unknown',
             note: 'another dispatcher currently holds this send' };
  }

  const { data: send } = await db
    .from('campaign_sends')
    .select('id, brand_id, campaign_id, approved_count, status, campaigns(external_id, name, channel), brands(code)')
    .eq('id', sendId).single();
  if (!send) throw new Error('send not found');

  // The approved count is the promise made to the owner. If the recipient snapshot no
  // longer matches it, something is wrong and we stop rather than send an amount nobody
  // approved.
  const { count: snapshotCount } = await db
    .from('send_recipients').select('id', { count: 'exact', head: true }).eq('send_id', sendId);
  if (snapshotCount !== send.approved_count) {
    await db.rpc('dispatch_release_lease', { p_send_id: sendId, p_owner: worker });
    throw new Error(
      `refusing to dispatch: ${send.approved_count} were approved but ${snapshotCount} recipients are stored`);
  }

  const campaign = send.campaigns as unknown as { external_id: string; name: string; channel: string };
  const brand = send.brands as unknown as { code: string };

  try {
    while (Date.now() - startedAt < budgetMs && out.claimed < maxChunks) {
      const { data: chunk, error: claimErr } = await db.rpc('dispatch_claim_chunk', {
        p_send_id: sendId, p_worker: worker,
      });
      if (claimErr) throw new Error(`claim: ${claimErr.message}`);
      // A composite return with no row arrives as an object whose every field is null,
      // so the presence of an id is what actually means "we claimed something".
      if (!chunk?.id) break;
      out.claimed++;

      const { data: recipients, error: recErr } = await db
        .from('send_recipients')
        .select('id, email, phone_e164')
        .eq('send_id', sendId).eq('chunk_no', chunk.chunk_no)
        .order('id');
      if (recErr) throw new Error(`recipients: ${recErr.message}`);

      const payload = (recipients ?? []).map((r) => ({
        id: r.id,
        ...(campaign.channel === 'email' ? { email: r.email } : { phone: r.phone_e164 }),
      }));

      if (payload.length > PROVIDER_RECIPIENT_CAP) {
        await db.rpc('dispatch_finish_attempt', {
          p_chunk_id: chunk.id, p_attempt_no: chunk.attempts, p_http_status: 0,
          p_batch_id: null, p_accepted: [], p_rejected: [],
          p_error: `chunk holds ${payload.length} recipients, above the provider cap of ${PROVIDER_RECIPIENT_CAP}`,
          p_excerpt: null,
        });
        out.failed++;
        continue;
      }

      const requestSha = createHash('sha256')
        .update(JSON.stringify(payload.map((p) => p.id))).digest('hex');

      // Phase one: commit the intent before making the call.
      const { data: begun, error: beginErr } = await db.rpc('dispatch_begin_attempt', {
        p_chunk_id: chunk.id, p_request_sha: requestSha,
        p_allow_retry: PROVIDER_REPLAYS_IDEMPOTENT_KEYS,
      });
      if (beginErr) throw new Error(`begin: ${beginErr.message}`);
      const attempt = Array.isArray(begun) ? begun[0] : begun;
      if (!attempt || attempt.outcome === 'indeterminate') {
        out.indeterminate++;
        continue;
      }

      // Phase two: the call itself.
      const result = await sendBatch({
        idempotencyKey: attempt.idempotency_key,
        campaign: campaign.external_id,
        brand: brand.code,
        recipients: payload,
      });

      // Phase three: commit the outcome, per recipient.
      const { error: finishErr } = await db.rpc('dispatch_finish_attempt', {
        p_chunk_id: chunk.id,
        p_attempt_no: attempt.attempt_no,
        p_http_status: result.httpStatus,
        p_batch_id: result.batchId,
        p_accepted: result.accepted,
        p_rejected: result.rejected,
        p_error: result.error,
        p_excerpt: result.excerpt,
      });
      if (finishErr) throw new Error(`finish: ${finishErr.message}`);

      out.accepted += result.accepted.length;
      out.rejected += result.rejected.length;
      if (!result.ok) out.failed++;

      await db.rpc('dispatch_acquire_lease', { p_send_id: sendId, p_owner: worker, p_seconds: 90 });
    }
  } finally {
    const { data: finalised } = await db.rpc('dispatch_finalize_send', { p_send_id: sendId });
    const row = Array.isArray(finalised) ? finalised[0] : finalised;
    out.status = row?.status ?? 'dispatching';
    out.finished = ['completed', 'completed_with_failures', 'failed', 'cancelled'].includes(out.status);
    if (!out.finished) await db.rpc('dispatch_release_lease', { p_send_id: sendId, p_owner: worker });
  }

  return out;
}
