import { createAdminClient } from '@/lib/supabase/admin';
import { fetchEvents } from '@/lib/provider/client';

export type SyncOutcome = { chunks: number; pages: number; ingested: number; duplicates: number; unattributable: number };

/**
 * Pulls delivery reports for whichever chunks are due.
 *
 * The provider has no webhooks, so this is the only way the picture ever updates. It runs
 * on a schedule inside the database, when a send page is opened, and when someone presses
 * Refresh.
 *
 * Reports arrive late, duplicated and out of order. Correctness comes from the event id
 * and the unique key it feeds, not from the cursor: a re-read costs a little work and
 * changes nothing.
 */
export async function syncDeliveryReports(opts: {
  chunkIds?: string[]; limit?: number; budgetMs?: number; maxPagesPerChunk?: number;
} = {}): Promise<SyncOutcome> {
  const db = createAdminClient();
  const budgetMs = opts.budgetMs ?? 120_000;
  const maxPages = opts.maxPagesPerChunk ?? 20;
  const startedAt = Date.now();
  const out: SyncOutcome = { chunks: 0, pages: 0, ingested: 0, duplicates: 0, unattributable: 0 };

  let due: { chunk_id: string; provider_batch_id: string; events_cursor: string | null }[] = [];
  if (opts.chunkIds?.length) {
    const { data } = await db
      .from('send_chunks')
      .select('id, provider_batch_id, events_cursor')
      .in('id', opts.chunkIds)
      .not('provider_batch_id', 'is', null);
    due = (data ?? []).map((c) => ({
      chunk_id: c.id, provider_batch_id: c.provider_batch_id!, events_cursor: c.events_cursor,
    }));
  } else {
    const { data, error } = await db.rpc('sync_due_chunks', { p_limit: opts.limit ?? 20 });
    if (error) throw new Error(`due chunks: ${error.message}`);
    due = (data ?? []) as typeof due;
  }

  for (const chunk of due) {
    if (Date.now() - startedAt > budgetMs) break;
    out.chunks++;
    let cursor = chunk.events_cursor;
    let quiet = false;

    for (let page = 0; page < maxPages; page++) {
      if (Date.now() - startedAt > budgetMs) break;
      const res = await fetchEvents(chunk.provider_batch_id, cursor);
      out.pages++;
      if (!res.ok) break;

      if (res.events.length === 0) { quiet = true; break; }

      const { data, error } = await db.rpc('sync_ingest_events', {
        p_chunk_id: chunk.chunk_id,
        p_events: res.events,
        p_next_cursor: res.nextCursor,
        p_quiet: false,
      });
      if (error) throw new Error(`ingest: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      out.ingested += row?.ingested ?? 0;
      out.duplicates += row?.duplicates ?? 0;
      out.unattributable += row?.unattributable ?? 0;

      // A null next_cursor means the stream has nothing further right now. Keeping the
      // previous cursor is deliberate: storing null would replay from the beginning.
      if (!res.nextCursor) { quiet = true; break; }
      cursor = res.nextCursor;
    }

    if (quiet) {
      await db.rpc('sync_ingest_events', {
        p_chunk_id: chunk.chunk_id, p_events: [], p_next_cursor: cursor, p_quiet: true,
      });
    }
  }

  return out;
}
