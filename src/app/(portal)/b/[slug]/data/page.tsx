import { requireMembership } from '@/lib/brand';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/portal/page-header';
import { IMPORT_RULES, REJECT_REASONS, WARNING_REASONS } from '@/lib/definitions';
import { ImportRunCard } from '@/components/portal/import-run-card';

export default async function DataHealthPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const brand = await requireMembership(slug);
  const supabase = await createClient();

  const [runsRes, orphanRes, sizeRes] = await Promise.all([
    supabase.rpc('brand_import_runs', { p_brand_id: brand.brandId, p_limit: 40 }),
    supabase.rpc('brand_orphan_event_summary', { p_brand_id: brand.brandId }),
    supabase.rpc('database_size').single(),
  ]);

  const runs = (runsRes.data ?? []) as Run[];
  const orphans = (orphanRes.data ?? []) as { unknown_campaign_ref: string; events: number; contacts: number }[];
  const size = sizeRes.data as { pretty: string } | null;

  const totals = runs.reduce((a, r) => ({
    read: a.read + r.rows_read, rejected: a.rejected + r.rows_rejected, warned: a.warned + r.rows_warned,
  }), { read: 0, rejected: 0, warned: 0 });

  return (
    <>
      <PageHeader title="Data health"
        description={<>What loaded, what did not, and what we had to assume. Nothing is discarded
          without appearing on this page.</>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Rows read" value={totals.read.toLocaleString()} />
        <Tile label="Rejected" value={totals.rejected.toLocaleString()} tone="destructive"
              sub="Could not be represented" />
        <Tile label="Imported with a note" value={totals.warned.toLocaleString()} tone="warning"
              sub="Stored, with an assumption recorded" />
        <Tile label="Database size" value={size?.pretty ?? '—'} sub="Shared across all three brands" />
      </div>

      <section className="mt-8 grid gap-4 sm:grid-cols-2">
        {(['reject', 'warn'] as const).map((k) => (
          <div key={k} className="rounded-xl border bg-card p-4">
            <h2 className="text-sm font-semibold">{IMPORT_RULES[k].label}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{IMPORT_RULES[k].rule}</p>
            <p className="mt-1.5 text-xs text-muted-foreground">{IMPORT_RULES[k].note}</p>
          </div>
        ))}
      </section>

      {orphans.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Events naming a campaign we do not have</h2>
          <p className="mb-3 mt-1 max-w-3xl text-sm text-muted-foreground">
            These events arrived in the engagement log but name campaigns that appear in no
            export. They are kept, because among them are unsubscribes, spam complaints and
            bounces: discarding them for failing a foreign key would quietly make suppressed
            people contactable again. They cannot be attributed to a campaign, so they are
            excluded from per-campaign figures.
          </p>
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[420px] text-sm">
              <thead><tr className="border-b bg-muted/40 text-left">
                <th className="px-4 py-2 font-medium">Campaign referenced</th>
                <th className="px-3 py-2 text-right font-medium">Events</th>
                <th className="px-3 py-2 text-right font-medium">Customers affected</th>
              </tr></thead>
              <tbody className="divide-y">
                {orphans.map((o) => (
                  <tr key={o.unknown_campaign_ref}>
                    <td className="px-4 py-2 font-mono text-xs">{o.unknown_campaign_ref}</td>
                    <td className="tabular px-3 py-2 text-right">{Number(o.events).toLocaleString()}</td>
                    <td className="tabular px-3 py-2 text-right">{Number(o.contacts).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mt-8">
        <h2 className="mb-1 text-sm font-semibold">Import runs</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Each file, each time it was loaded. Loading the same export again updates the
          customers already on record rather than creating a second copy of them.
        </p>
        <div className="space-y-3">
          {runs.map((r) => <ImportRunCard key={r.id} run={r} slug={slug} />)}
          {runs.length === 0 && (
            <div className="rounded-xl border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
              Nothing has been imported for this brand yet.
            </div>
          )}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold">What each reason means</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <ReasonList title="Rejected" reasons={REJECT_REASONS} tone="destructive" />
          <ReasonList title="Imported with a note" reasons={WARNING_REASONS} tone="warning" />
        </div>
      </section>
    </>
  );
}

type Run = {
  id: string; entity: string; source_file: string; file_sha256: string;
  started_at: string; finished_at: string | null; status: string;
  rows_read: number; rows_inserted: number; rows_updated: number;
  rows_rejected: number; rows_warned: number; error: string | null;
  notes: Record<string, number> | null;
};

function Tile({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'destructive' | 'warning';
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className={`tabular mt-2 text-2xl font-semibold tracking-tight ${
        tone === 'destructive' ? 'text-destructive' : tone === 'warning' ? 'text-warning' : ''}`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function ReasonList({ title, reasons, tone }: {
  title: string; reasons: Record<string, string>; tone: 'destructive' | 'warning';
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
        <span className={`size-2 rounded-full ${tone === 'destructive' ? 'bg-destructive' : 'bg-warning'}`} />
        {title}
      </h3>
      <dl className="space-y-2.5">
        {Object.entries(reasons).map(([code, text]) => (
          <div key={code}>
            <dt className="font-mono text-xs text-muted-foreground">{code}</dt>
            <dd className="text-xs">{text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
