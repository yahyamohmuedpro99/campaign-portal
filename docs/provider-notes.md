# Messaging provider — what we verified, and where the documentation is wrong

Everything below was established empirically against
`https://dispatcher-production-72fc.up.railway.app` on 14 Sep 2026 with our own key,
using small probe batches addressed to `@vg-eval.test`. `scripts/probe-provider.ts`
reproduces it. Raw responses were written to a scratch directory outside this repo;
only shapes and counts are recorded here, never credentials.

The provider's own `/v1/docs` makes four claims that the API does not honour. Each one,
taken at face value, produces a silent failure of exactly the kind this build is meant to
prevent, so each is listed with what actually happens.

## Authentication and transport

`Authorization: Bearer <key>` (an `X-API-Key` header also works). No CORS headers are
returned, so the browser can never call the provider directly; every call is made
server-side. No `RateLimit-*` or `Retry-After` headers are ever sent, so throttling
cannot be detected from a response — we budget client-side instead.

Error bodies come in three different shapes depending on which layer rejects the request:
`{"error":"...","message":"..."}`, `{"detail":"..."}`, and a 422 validation array. The
client handles all three.

## Claim 1: "Up to 100,000 recipients per call. No practical limit."

**False, and dangerously so.** The cap is exactly 500.

| Recipients sent | HTTP | `status` | `accepted_count` | `rejected_count` |
|---|---|---|---|---|
| 499 | 200 | accepted | 499 | 0 |
| 500 | 200 | accepted | 500 | 0 |
| 501 | 200 | accepted | 500 | 1 |
| 600 | 200 | accepted | 500 | 100 |
| 2000 | 200 | accepted | 500 | 1500 |

Over the cap the call still returns **HTTP 200 with `status: "accepted"`**. The excess is
returned in `rejected[]` as `{recipient:{id,email}, reason:"recipient_cap_exceeded"}`.
A client that checks the status code and moves on would drop 1,500 of 2,000 people and
report success.

Consequences for this build: `private.provider_chunk_size()` is **500**, and the
dispatcher reconciles `accepted[]` and `rejected[]` per recipient against the chunk it
sent. A chunk whose accepted count is lower than its recipient count is recorded as
`partially_accepted`, never as done.

## Claim 2: "Send the same request twice and it is delivered once."

**True, and stronger than documented — which is its own hazard.** The `Idempotency-Key`
header is authoritative on its own:

- same key, same body → same `batch_id`, nothing sent twice;
- same key, **different** body → **also** the original `batch_id`, and the new recipients
  are silently discarded (a 3-recipient body replayed a 2-recipient batch and returned
  `accepted_count: 2`).

So a retry with the same key is safe, which is what lets an interrupted dispatch resume.
But a key reused for different content loses the difference with no error. Our keys are
`sha256(send_id:chunk_no:v1)` — derived from the content's identity, stable across every
retry of that chunk, and never reused for anything else.

## Claim 3: "Every event is delivered exactly once and in order."

**False on both counts.** In a single 50-event page, 25 of 49 adjacent pairs were out of
chronological order. Re-reading the stream returns events already seen. Event ids are
formed as `evt-<first 8 chars of batch id>-<sequence>` — only about two hex characters of
per-batch entropy, so ids **collide across batches** by construction.

Consequences: the ingestion key is `(chunk_id, provider_event_id)`, never the event id
alone; inserts use `on conflict do nothing`; and every write derived from an event is
commutative (earliest timestamp wins per event kind, status recomputed from timestamps).
Replaying the entire stream in any order produces the same final state.

## Claim 4: the report stream is "clean and complete"

Events trickle in over minutes and the endpoint gives no reliable signal of completion.

- `GET /v1/messages/{batch_id}/events?since=<cursor>` returns
  `{events, next_cursor, has_more}`, at most 1,000 per page.
- The cursor is an opaque offset: `bzoyMA` is base64url for `o:20`.
- `since` is documented as taking an event id. It does not — it takes the cursor.
  Passing an event id is **silently treated as offset 0** and replays the batch from the
  beginning rather than erroring.
- `has_more` stayed `true` even when the following page was empty, so it cannot be used
  as a stop condition.
- `next_cursor` comes back **null** once the currently available stream is exhausted.
  Setting the stored cursor to null then restarts from offset 0 on the next poll.

Consequences: we poll until a page returns zero events, we keep the last non-null
`next_cursor`, and we cap pages per poll. Duplicate reads are expected and harmless
because the event id is the truth and the cursor is only a hint.

Observed arrival for a 20-recipient batch: 20 events within 20 s, then nothing for a
minute, then a further 10. Event types seen live are `delivered`, `bounced`, `opened`
and `unsubscribed`. The historical seed log instead uses `open`, `click`, `complaint`,
`bounce`, `unsubscribe` — note that `clicked` and `complained` appear only in the seed
data and never from the live API. Both dialects are folded by
`private.canonical_event_type()`.

## What does not exist

There are no webhooks, no way to list your batches, and no suppression endpoint. The API
surface is two calls: send a batch, and poll that batch's events. Because `batch_id` is
returned exactly once and can never be recovered, it is committed to our database in the
same transaction that records the attempt — losing it would mean losing the delivery
record permanently.

Delivery reporting is therefore a scheduled poll, not a push. `pg_cron` ticks every
minute inside Supabase and calls the sync route, which is also reachable from the send
page's Refresh control.

## Recipient identity

Recipients may be sent as bare strings or as objects. The `id` we supply is echoed back
in `accepted[]` and appears as `recipient_id` on every event, and arbitrary UUIDs are
accepted. We send our own `send_recipients.id`, which is unique per send per contact.
That makes every event unambiguously attributable to one brand, one send and one person —
which sending a contact's `external_id` would not, since those collide across brands.
