'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/browser';
import { REJECT_REASONS, WARNING_REASONS } from '@/lib/definitions';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

type Run = {
  id: string; entity: string; source_file: string; file_sha256: string;
  started_at: string; finished_at: string | null; status: string;
  rows_read: number; rows_inserted: number; rows_updated: number;
  rows_rejected: number; rows_warned: number; error: string | null;
  notes: Record<string, number> | null;
};

type Issue = { row_no: number | null; reason_code: string; detail: string | null; raw: unknown };

export function ImportRunCard({ run }: { run: Run; slug: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'reject' | 'warn'>(run.rows_rejected > 0 ? 'reject' : 'warn');
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(next: 'reject' | 'warn') {
    setKind(next); setLoading(true); setIssues(null);
    const supabase = createClient();
    const { data } = await supabase.rpc('brand_import_issues', {
      p_run_id: run.id, p_kind: next, p_limit: 50, p_offset: 0,
    });
    setIssues((data ?? []) as Issue[]);
    setLoading(false);
  }

  const when = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(run.started_at));
  const reasons = kind === 'reject' ? REJECT_REASONS : WARNING_REASONS;
  const counts = Object.entries(run.notes ?? {})
    .filter(([k]) => k.startsWith(kind === 'reject' ? 'reject:' : 'warn:'))
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  return (
    <div className="rounded-xl border bg-card">
      <button type="button" onClick={() => { setOpen(!open); if (!open && !issues) load(kind); }}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-sm">{run.source_file}</span>
            <Badge variant={run.status === 'succeeded' ? 'secondary' : 'destructive'} className="font-normal">
              {run.status}
            </Badge>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">{when} · {run.entity}</div>
        </div>
        <dl className="hidden gap-4 text-right text-xs sm:flex">
          <div><dt className="text-muted-foreground">read</dt><dd className="tabular font-medium">{run.rows_read.toLocaleString()}</dd></div>
          <div><dt className="text-muted-foreground">new</dt><dd className="tabular font-medium">{run.rows_inserted.toLocaleString()}</dd></div>
          <div><dt className="text-muted-foreground">updated</dt><dd className="tabular font-medium">{run.rows_updated.toLocaleString()}</dd></div>
          <div><dt className="text-muted-foreground">rejected</dt>
               <dd className={`tabular font-medium ${run.rows_rejected ? 'text-destructive' : ''}`}>{run.rows_rejected.toLocaleString()}</dd></div>
          <div><dt className="text-muted-foreground">noted</dt>
               <dd className={`tabular font-medium ${run.rows_warned ? 'text-warning' : ''}`}>{run.rows_warned.toLocaleString()}</dd></div>
        </dl>
        {open ? <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
              : <ChevronDown className="size-4 shrink-0 text-muted-foreground" />}
      </button>

      {open && (
        <div className="border-t px-4 py-3">
          {run.error && (
            <p className="mb-3 rounded-lg bg-destructive/10 p-3 text-xs text-destructive">{run.error}</p>
          )}
          <div className="mb-3 flex flex-wrap gap-2">
            <Button size="sm" variant={kind === 'reject' ? 'default' : 'outline'} onClick={() => load('reject')}>
              Rejected ({run.rows_rejected.toLocaleString()})
            </Button>
            <Button size="sm" variant={kind === 'warn' ? 'default' : 'outline'} onClick={() => load('warn')}>
              With a note ({run.rows_warned.toLocaleString()})
            </Button>
          </div>

          {counts.length > 0 && (
            <ul className="mb-3 flex flex-wrap gap-1.5">
              {counts.map(([k, v]) => (
                <li key={k}>
                  <Badge variant="outline" className="font-normal">
                    {k.split(':')[1]} · {Number(v).toLocaleString()}
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading rows…
            </div>
          ) : issues && issues.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[560px] text-xs">
                <thead><tr className="border-b bg-muted/40 text-left">
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                  <th className="px-3 py-2 font-medium">What happened</th>
                </tr></thead>
                <tbody className="divide-y">
                  {issues.map((i, n) => (
                    <tr key={n}>
                      <td className="tabular px-3 py-2 text-muted-foreground">{i.row_no ?? '—'}</td>
                      <td className="px-3 py-2 font-mono">{i.reason_code}</td>
                      <td className="px-3 py-2">
                        {i.detail ?? reasons[i.reason_code] ?? '—'}
                        {i.raw != null && (
                          <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                               title={JSON.stringify(i.raw)}>
                            {JSON.stringify(i.raw).slice(0, 180)}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-3 py-2 text-[11px] text-muted-foreground">
                Showing the first {issues.length}. Row content is stored for up to 2,000 rows
                per run so this ledger cannot outgrow the database.
              </p>
            </div>
          ) : (
            <p className="py-4 text-sm text-muted-foreground">
              Nothing was {kind === 'reject' ? 'rejected' : 'noted'} in this run.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
