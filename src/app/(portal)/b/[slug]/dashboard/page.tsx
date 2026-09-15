import Link from 'next/link';
import { requireMembership } from '@/lib/brand';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/portal/page-header';
import { StatCard, StatStrip } from '@/components/portal/stat-card';
import { Waterfall, type WaterfallStep } from '@/components/portal/waterfall';
import { ColumnChart } from '@/components/charts';
import { DefinitionNote } from '@/components/portal/definition-note';
import { DEFINITIONS } from '@/lib/definitions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export default async function DashboardPage({
  params, searchParams,
}: { params: Promise<{ slug: string }>; searchParams: Promise<{ window?: string }> }) {
  const { slug } = await params;
  const { window: windowParam } = await searchParams;
  const brand = await requireMembership(slug);
  const supabase = await createClient();
  const windowMode = windowParam === 'latest' ? 'latest' : 'today';

  const [totals, waterfall, signups, performance] = await Promise.all([
    supabase.rpc('brand_totals', { p_brand_id: brand.brandId }).single(),
    supabase.rpc('brand_contactability_waterfall', { p_brand_id: brand.brandId }),
    supabase.rpc('brand_signups_per_day', { p_brand_id: brand.brandId, p_window: windowMode }),
    supabase.rpc('brand_campaign_performance', { p_brand_id: brand.brandId }),
  ]);

  if (totals.error) {
    return <ErrorPanel message={totals.error.message} />;
  }

  const t = totals.data as {
    total_customers: number; soft_deleted: number; contactable: number;
    email_reachable: number; sms_reachable: number; latest_signup: string | null;
  };
  const steps = (waterfall.data ?? []) as WaterfallStep[];
  const days = (signups.data ?? []) as { day: string; signups: number }[];
  const campaigns = (performance.data ?? []) as CampaignRow[];

  const totalSignups = days.reduce((a, d) => a + Number(d.signups), 0);
  const fmt = (n: number) => Number(n).toLocaleString();
  const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={<>Everything on this page counts only {brand.name}’s own data. Hover any <span className="font-medium">i</span> to see exactly how a figure was counted.</>}
      />

      {/* Contactable leads: it is the figure every other decision on this page hangs off. */}
      <StatStrip>
        <StatCard lead label="Contactable" value={fmt(t.contactable)}
                  sub={`${Math.round((t.contactable / Math.max(1, t.total_customers)) * 100)}% of customers`}
                  rule={DEFINITIONS.contactable.rule} note={DEFINITIONS.contactable.note} />
        <StatCard label="Total customers" value={fmt(t.total_customers)}
                  sub={t.soft_deleted > 0 ? `${fmt(t.soft_deleted)} removed at source, excluded` : 'None removed at source'}
                  rule={DEFINITIONS.totalCustomers.rule} note={DEFINITIONS.totalCustomers.note} />
        <StatCard label="Reachable by email" value={fmt(t.email_reachable)}
                  sub="Contactable and holding a valid address"
                  rule={DEFINITIONS.audience.rule} note={DEFINITIONS.audience.note} />
        <StatCard label="Reachable by SMS" value={fmt(t.sms_reachable)}
                  sub="Contactable and holding a valid mobile"
                  rule={DEFINITIONS.audience.rule} note={DEFINITIONS.audience.note} />
      </StatStrip>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-1.5">
            <h2 className="text-sm font-semibold">How we get to contactable</h2>
            <DefinitionNote rule={DEFINITIONS.contactable.rule} note={DEFINITIONS.contactable.note} />
          </div>
          <Waterfall steps={steps} hrefFor={(key) => `/b/${slug}/contacts?exclusion=${key}`} />
          <p className="mt-2 text-xs text-muted-foreground">
            Each line counts only people who passed every line above it, so the steps add up
            exactly. Select a line to see those customers.
          </p>
        </div>

        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <h2 className="text-sm font-semibold">Signups per day</h2>
              <DefinitionNote rule={DEFINITIONS.signupsPerDay.rule} note={DEFINITIONS.signupsPerDay.note} />
            </div>
            <Badge variant="secondary" className="font-normal">
              {windowMode === 'latest' ? '30 days to last signup' : 'Last 30 days'}
            </Badge>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="mb-3 flex items-baseline gap-2">
              <span className="tabular text-2xl font-semibold tracking-tight">{fmt(totalSignups)}</span>
              <span className="text-xs text-muted-foreground">
                signups in this window, {brand.timezone.replace('_', ' ')} time
              </span>
            </div>
            <ColumnChart height={120}
              data={days.map((d) => ({ label: dayFmt.format(new Date(d.day)), value: Number(d.signups) }))} />
            {totalSignups === 0 && (
              <div className="mt-3 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">No signups in the last 30 days.</p>
                <p className="mt-0.5">
                  {t.latest_signup
                    ? <>This brand’s most recent signup was {dayFmt.format(new Date(t.latest_signup))}{' '}
                        {new Date(t.latest_signup).getUTCFullYear()}. The window is shown as it is rather than
                        quietly moved.</>
                    : <>No signup dates could be read for this brand.</>}
                </p>
                {t.latest_signup && windowMode !== 'latest' && (
                  <Button asChild size="sm" variant="outline" className="mt-2">
                    <Link href={`/b/${slug}/dashboard?window=latest`}>Show 30 days to the last signup</Link>
                  </Button>
                )}
                {windowMode === 'latest' && (
                  <Button asChild size="sm" variant="outline" className="mt-2">
                    <Link href={`/b/${slug}/dashboard`}>Back to the last 30 days</Link>
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <CampaignPerformance slug={slug} campaigns={campaigns} />
    </>
  );
}

type CampaignRow = {
  campaign_id: string; external_id: string; name: string; channel: 'email' | 'sms';
  sent_at: string | null; imported_status: string;
  reported_sent: number | null; reported_opens: number | null; reported_bounced: number | null;
  observed_opened: number; observed_bounced: number; observed_unsubscribed: number;
  portal_send_id: string | null; portal_approved: number | null;
  portal_delivered: number; portal_opened: number; portal_bounced: number;
};

function CampaignPerformance({ slug, campaigns }: { slug: string; campaigns: CampaignRow[] }) {
  const fmt = (n: number | null) => (n == null ? '—' : Number(n).toLocaleString());
  return (
    <section className="mt-8">
      <h2 className="mb-1 text-sm font-semibold">Campaign performance</h2>
      <p className="mb-3 max-w-3xl text-xs text-muted-foreground">
        Three independent sources, side by side and never merged into a single figure.
        They disagree, and which one to believe depends on the question: the source system’s
        own numbers over-report opens roughly threefold across every brand here.
      </p>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              <th className="px-4 py-2.5 font-medium">Campaign</th>
              <th className="px-3 py-2.5 font-medium">Channel</th>
              <th className="px-3 py-2.5 text-right font-medium">
                <span className="inline-flex items-center gap-1">Reported sent
                  <DefinitionNote rule={DEFINITIONS.reportedMetrics.rule} note={DEFINITIONS.reportedMetrics.note} /></span>
              </th>
              <th className="px-3 py-2.5 text-right font-medium">Reported opens</th>
              <th className="px-3 py-2.5 text-right font-medium">
                <span className="inline-flex items-center gap-1">Observed opens
                  <DefinitionNote rule={DEFINITIONS.observedMetrics.rule} note={DEFINITIONS.observedMetrics.note} /></span>
              </th>
              <th className="px-3 py-2.5 text-right font-medium">Observed unsubs</th>
              <th className="px-3 py-2.5 text-right font-medium">
                <span className="inline-flex items-center gap-1">Sent here
                  <DefinitionNote rule={DEFINITIONS.portalMetrics.rule} note={DEFINITIONS.portalMetrics.note} /></span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {campaigns.map((c) => (
              <tr key={c.campaign_id} className="transition-colors hover:bg-accent/40">
                <td className="px-4 py-2.5">
                  <Link href={`/b/${slug}/campaigns/${c.campaign_id}`} className="font-medium hover:underline">
                    {c.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {c.external_id}
                    {c.imported_status === 'draft' && <span className="ml-1.5 text-warning">draft</span>}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">{c.channel}</td>
                <td className="tabular px-3 py-2.5 text-right">{fmt(c.reported_sent)}</td>
                <td className="tabular px-3 py-2.5 text-right text-muted-foreground">{fmt(c.reported_opens)}</td>
                <td className="tabular px-3 py-2.5 text-right">{fmt(c.observed_opened)}</td>
                <td className="tabular px-3 py-2.5 text-right text-muted-foreground">{fmt(c.observed_unsubscribed)}</td>
                <td className="tabular px-3 py-2.5 text-right">
                  {c.portal_send_id
                    ? <Link href={`/b/${slug}/sends/${c.portal_send_id}`} className="font-medium text-primary hover:underline">
                        {fmt(c.portal_delivered)} delivered
                      </Link>
                    : <span className="text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}
            {campaigns.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                No campaigns have been imported for this brand.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
      <h2 className="font-semibold">This page could not load</h2>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
