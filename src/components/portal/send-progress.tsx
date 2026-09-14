'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { createClient } from '@/lib/supabase/browser';
import { Loader2, RefreshCw, Play, HelpCircle } from 'lucide-react';

type Chunk = {
  id: string; chunk_no: number; status: string; recipient_count: number; attempts: number;
  provider_batch_id: string | null; accepted_count: number | null; rejected_count: number | null;
  last_polled_at: string | null; resolution_note: string | null;
};

const STATUS_TONE: Record<string, string> = {
  accepted: 'bg-success/15 text-success hover:bg-success/15',
  partially_accepted: 'bg-warning/15 text-warning hover:bg-warning/15',
  indeterminate: 'bg-warning/15 text-warning hover:bg-warning/15',
  failed: 'bg-destructive/15 text-destructive hover:bg-destructive/15',
};

/**
 * Drives a send to completion while the page is open, and shows honestly where it is.
 *
 * Leaving the page does not abandon the send: the scheduled job picks up anything left
 * mid-flight. Pressing "Continue" again is harmless, because only one dispatcher can hold
 * a send at a time and each batch is claimed exactly once.
 */
export function SendProgress({ sendId, slug, isOwner, isTerminal, chunks, lastPolled, approved, timezone }: {
  sendId: string; slug: string; isOwner: boolean; isTerminal: boolean;
  chunks: Chunk[]; lastPolled: string | null; approved: number; timezone: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'dispatch' | 'refresh' | null>(null);
  const [resolving, setResolving] = useState<Chunk | null>(null);
  const autoRan = useRef(false);

  const done = chunks.filter((c) => c.status === 'accepted').length;
  const outstanding = chunks.filter((c) => c.status === 'pending' || c.status === 'dispatching');
  const indeterminate = chunks.filter((c) => c.status === 'indeterminate');
  const sentSoFar = chunks.reduce((a, c) => a + (c.accepted_count ?? 0), 0);
  const pct = chunks.length ? Math.round((done / chunks.length) * 100) : 0;

  async function dispatch() {
    setBusy('dispatch');
    try {
      const res = await fetch(`/api/sends/${sendId}/dispatch`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'dispatch failed');
      if (body.note) toast.info(body.note);
      else if (body.claimed === 0 && !body.finished) toast.info('Nothing left to hand over right now.');
      else toast.success(`${body.accepted.toLocaleString()} accepted by the provider.`);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setBusy(null); }
  }

  async function refresh() {
    setBusy('refresh');
    try {
      const supabase = createClient();
      // Reading the reports is a privileged action, so it goes through the server route
      // rather than the browser talking to the provider, which CORS would block anyway.
      const res = await fetch(`/api/sends/${sendId}/sync`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'refresh failed');
      toast.success(body.ingested > 0
        ? `${body.ingested.toLocaleString()} new delivery report${body.ingested === 1 ? '' : 's'}.`
        : 'No new delivery reports yet.');
      router.refresh();
      void supabase;
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setBusy(null); }
  }

  // While batches are outstanding and this page is open, keep handing them over.
  useEffect(() => {
    if (isTerminal || !isOwner) return;
    if (outstanding.length === 0) return;
    if (autoRan.current) return;
    autoRan.current = true;
    void dispatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTerminal, isOwner, outstanding.length]);

  useEffect(() => {
    if (isTerminal) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [isTerminal, router]);

  async function resolve(chunk: Chunk, resolution: 'retry' | 'mark_sent' | 'mark_failed') {
    const supabase = createClient();
    const { error } = await supabase.rpc('resolve_indeterminate_chunk', {
      p_chunk_id: chunk.id, p_resolution: resolution,
      p_note: `resolved from the send page as ${resolution}`,
    });
    setResolving(null);
    if (error) { toast.error(error.message); return; }
    toast.success('Recorded.');
    router.refresh();
  }

  const polled = lastPolled
    ? new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium', timeZone: timezone }).format(new Date(lastPolled))
    : null;

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Progress</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {sentSoFar.toLocaleString()} of {approved.toLocaleString()} handed to the provider
            across {chunks.length} batch{chunks.length === 1 ? '' : 'es'} of up to 500.
            {polled && <> Delivery reports last collected at {polled}.</>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refresh} disabled={busy !== null} className="gap-1.5">
            {busy === 'refresh' ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Refresh from provider
          </Button>
          {isOwner && !isTerminal && outstanding.length > 0 && (
            <Button size="sm" onClick={dispatch} disabled={busy !== null} className="gap-1.5">
              {busy === 'dispatch' ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              Continue sending
            </Button>
          )}
        </div>
      </div>

      <Progress value={pct} className="h-2" />

      {indeterminate.length > 0 && (
        <div className="mt-4 rounded-xl border border-warning/40 bg-warning/5 p-4">
          <div className="flex items-start gap-2">
            <HelpCircle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0">
              <h3 className="text-sm font-medium">
                {indeterminate.length} batch{indeterminate.length === 1 ? '' : 'es'} we cannot account for
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                We handed {indeterminate.reduce((a, c) => a + c.recipient_count, 0).toLocaleString()} people
                to the provider and never heard back. They may have been sent. Nothing here is
                retried automatically, because doing so could message those people twice.
              </p>
              {isOwner && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {indeterminate.map((c) => (
                    <Button key={c.id} size="sm" variant="outline" onClick={() => setResolving(c)}>
                      Decide on batch {c.chunk_no + 1}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[640px] text-sm">
          <thead><tr className="border-b bg-muted/40 text-left">
            <th className="px-4 py-2 font-medium">Batch</th>
            <th className="px-3 py-2 text-right font-medium">People</th>
            <th className="px-3 py-2 text-right font-medium">Accepted</th>
            <th className="px-3 py-2 text-right font-medium">Rejected</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Provider batch</th>
          </tr></thead>
          <tbody className="divide-y">
            {chunks.map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-2">{c.chunk_no + 1}
                  {c.attempts > 1 && <span className="ml-1 text-xs text-muted-foreground">({c.attempts} attempts)</span>}
                </td>
                <td className="tabular px-3 py-2 text-right">{c.recipient_count.toLocaleString()}</td>
                <td className="tabular px-3 py-2 text-right">{c.accepted_count?.toLocaleString() ?? '—'}</td>
                <td className="tabular px-3 py-2 text-right">{c.rejected_count?.toLocaleString() ?? '—'}</td>
                <td className="px-3 py-2">
                  <Badge variant="secondary" className={`font-normal ${STATUS_TONE[c.status] ?? ''}`}>
                    {c.status.replace(/_/g, ' ')}
                  </Badge>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {c.provider_batch_id ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        The provider batch reference is stored the moment it is issued, so the same delivery
        record we read is the one anyone else can read with the same key.
      </p>

      <AlertDialog open={resolving !== null} onOpenChange={(o) => !o && setResolving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Batch {(resolving?.chunk_no ?? 0) + 1} was never acknowledged</AlertDialogTitle>
            <AlertDialogDescription>
              We handed {resolving?.recipient_count.toLocaleString()} people to the provider and
              the call did not come back. It may have gone out. Retrying reuses the same
              idempotency key, which this provider honours by replaying the original batch
              rather than sending again, but the decision is yours.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel>Leave it</AlertDialogCancel>
            <Button variant="outline" onClick={() => resolving && resolve(resolving, 'mark_failed')}>
              Treat as not sent
            </Button>
            <Button variant="outline" onClick={() => resolving && resolve(resolving, 'mark_sent')}>
              Treat as sent
            </Button>
            <AlertDialogAction onClick={() => resolving && resolve(resolving, 'retry')}>
              Retry with the same key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
