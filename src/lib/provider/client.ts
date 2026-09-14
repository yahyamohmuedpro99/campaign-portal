/**
 * Client for the messaging provider.
 *
 * Written against what the API does rather than what its documentation says. The
 * differences are load-bearing and are recorded in docs/provider-notes.md; the ones that
 * shape this file are:
 *
 *   - The recipient cap is 500, not the documented 100,000, and exceeding it returns
 *     HTTP 200 with status "accepted" while silently discarding the excess. So callers
 *     must reconcile accepted[] and rejected[] against what they asked for, and never
 *     treat a 2xx as proof that everyone was taken.
 *   - A repeated Idempotency-Key replays the original batch, even when the body differs.
 *     A retry is therefore safe; reusing a key for different content loses the difference.
 *   - There are no CORS headers, so this only ever runs server-side.
 *   - Errors arrive in three unrelated shapes.
 */

export const PROVIDER_RECIPIENT_CAP = 500;

export type Recipient = { id: string; email?: string | null; phone?: string | null };

export type SendResult = {
  ok: boolean;
  httpStatus: number;
  batchId: string | null;
  accepted: string[];
  rejected: { id: string | null; reason: string }[];
  error: string | null;
  excerpt: string;
};

export type ProviderEvent = {
  event_id?: string; id?: string;
  recipient_id?: string;
  type?: string; event_type?: string;
  occurred_at?: string; occurred_at_utc?: string; timestamp?: string;
};

export type EventsPage = {
  ok: boolean;
  httpStatus: number;
  events: ProviderEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  error: string | null;
};

function config() {
  const baseUrl = process.env.PROVIDER_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.PROVIDER_API_KEY;
  if (!baseUrl || !apiKey) throw new Error('PROVIDER_BASE_URL and PROVIDER_API_KEY must be set');
  return { baseUrl, apiKey };
}

/** The provider answers with {error,message}, or {detail}, or a validation array. */
function readError(body: unknown, httpStatus: number): string | null {
  if (httpStatus >= 200 && httpStatus < 300) return null;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.message === 'string') return b.message;
    if (typeof b.detail === 'string') return b.detail;
    if (Array.isArray(b.detail)) return b.detail.map((d) => JSON.stringify(d)).join('; ').slice(0, 300);
    if (typeof b.error === 'string') return b.error;
  }
  return `provider returned HTTP ${httpStatus}`;
}

async function request(path: string, init: RequestInit & { timeoutMs?: number }) {
  const { baseUrl, apiKey } = config();
  const { timeoutMs = 30_000, ...rest } = init;
  const res = await fetch(`${baseUrl}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      ...rest.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { httpStatus: res.status, body, excerpt: text.slice(0, 500) };
}

/**
 * Sends one batch. `idempotencyKey` must be stable for this exact set of recipients: the
 * provider will replay whatever it first saw under that key and ignore any change.
 */
export async function sendBatch(opts: {
  idempotencyKey: string;
  campaign: string;
  brand: string;
  recipients: Recipient[];
}): Promise<SendResult> {
  if (opts.recipients.length > PROVIDER_RECIPIENT_CAP) {
    // Caught here rather than discovered afterwards in a 200 that dropped people.
    return {
      ok: false, httpStatus: 0, batchId: null, accepted: [], rejected: [],
      error: `refusing to send ${opts.recipients.length} recipients: the provider accepts at most ${PROVIDER_RECIPIENT_CAP} and silently discards the rest`,
      excerpt: '',
    };
  }

  try {
    const { httpStatus, body, excerpt } = await request('/v1/messages', {
      method: 'POST',
      headers: { 'Idempotency-Key': opts.idempotencyKey },
      body: JSON.stringify({
        campaign: opts.campaign,
        brand: opts.brand,
        recipients: opts.recipients.map((r) => ({
          id: r.id,
          ...(r.email ? { email: r.email } : {}),
          ...(r.phone ? { phone: r.phone } : {}),
        })),
      }),
    });

    const error = readError(body, httpStatus);
    const b = (body ?? {}) as Record<string, unknown>;
    const accepted = Array.isArray(b.accepted)
      ? (b.accepted as unknown[]).map((a) =>
          typeof a === 'string' ? a : String((a as Record<string, unknown>)?.id ?? ''))
        .filter(Boolean)
      : [];
    const rejected = Array.isArray(b.rejected)
      ? (b.rejected as Record<string, unknown>[]).map((r) => ({
          id: String((r.recipient as Record<string, unknown>)?.id ?? r.id ?? '') || null,
          reason: String(r.reason ?? 'unspecified'),
        }))
      : [];

    return {
      ok: !error && typeof b.batch_id === 'string',
      httpStatus,
      batchId: typeof b.batch_id === 'string' ? b.batch_id : null,
      accepted, rejected, error, excerpt,
    };
  } catch (e) {
    // A timeout or a dropped connection leaves the outcome genuinely unknown: the
    // provider may have accepted the batch. The caller must not assume it did not.
    return {
      ok: false, httpStatus: 0, batchId: null, accepted: [], rejected: [],
      error: `no response from provider: ${(e as Error).message}`, excerpt: '',
    };
  }
}

/**
 * Reads one page of delivery reports.
 *
 * `since` takes the cursor from the previous page, not an event id. Passing an event id
 * is accepted and silently restarts the stream from the beginning, and `has_more` stays
 * true even when the next page is empty, so neither can be used as a stop condition. The
 * caller stops on an empty page and treats the event id as the source of truth.
 */
export async function fetchEvents(batchId: string, since: string | null): Promise<EventsPage> {
  try {
    const qs = since ? `?since=${encodeURIComponent(since)}` : '';
    const { httpStatus, body } = await request(`/v1/messages/${encodeURIComponent(batchId)}/events${qs}`, {
      method: 'GET', timeoutMs: 20_000,
    });
    const error = readError(body, httpStatus);
    const b = (body ?? {}) as Record<string, unknown>;
    return {
      ok: !error,
      httpStatus,
      events: Array.isArray(b.events) ? (b.events as ProviderEvent[]) : [],
      nextCursor: typeof b.next_cursor === 'string' ? b.next_cursor : null,
      hasMore: b.has_more === true,
      error,
    };
  } catch (e) {
    return { ok: false, httpStatus: 0, events: [], nextCursor: null, hasMore: false,
             error: `no response from provider: ${(e as Error).message}` };
  }
}
