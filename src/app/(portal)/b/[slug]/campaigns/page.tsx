import Link from 'next/link';
import { requireMembership } from '@/lib/brand';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/portal/page-header';
import { Badge } from '@/components/ui/badge';
import { DefinitionNote } from '@/components/portal/definition-note';
import { DEFINITIONS } from '@/lib/definitions';
import { Megaphone, ChevronRight } from 'lucide-react';

export default async function CampaignsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const brand = await requireMembership(slug);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('brand_campaign_performance', { p_brand_id: brand.brandId });
  const rows = (data ?? []) as Row[];

  const fmt = (n: number | null) => (n == null ? '—' : Number(n).toLocaleString());
  const date = (s: string | null) => s
    ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: brand.timezone }).format(new Date(s))
    : '—';

  return (
    <>
      <PageHeader title="Campaigns"
        description={<>Campaigns imported for {brand.name}, with what the source system claimed
          and what this portal has confirmed.</>} />

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
          <h2 className="font-semibold">Campaigns could not be loaded</h2>
          <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border bg-card px-6 py-16 text-center">
          <div className="rounded-full bg-muted p-3"><Megaphone className="size-5 text-muted-foreground" /></div>
          <p className="text-sm font-medium">No campaigns imported</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left">
                <th className="px-4 py-2.5 font-medium">Campaign</th>
                <th className="px-3 py-2.5 font-medium">Channel</th>
                <th className="px-3 py-2.5 font-medium">Date</th>
                <th className="px-3 py-2.5 text-right font-medium">
                  <span className="inline-flex items-center gap-1">Reported sent
                    <DefinitionNote rule={DEFINITIONS.reportedMetrics.rule} note={DEFINITIONS.reportedMetrics.note} /></span>
                </th>
                <th className="px-3 py-2.5 text-right font-medium">
                  <span className="inline-flex items-center gap-1">Observed opens
                    <DefinitionNote rule={DEFINITIONS.observedMetrics.rule} note={DEFINITIONS.observedMetrics.note} /></span>
                </th>
                <th className="px-3 py-2.5 font-medium">This portal</th>
                <th className="w-8 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((c) => (
                <tr key={c.campaign_id} className="transition-colors hover:bg-accent/40">
                  <td className="px-4 py-2.5">
                    <Link href={`/b/${slug}/campaigns/${c.campaign_id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{c.external_id}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant="secondary" className="font-normal">{c.channel}</Badge>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{date(c.sent_at)}</td>
                  <td className="tabular px-3 py-2.5 text-right">{fmt(c.reported_sent)}</td>
                  <td className="tabular px-3 py-2.5 text-right">{fmt(c.observed_opened)}</td>
                  <td className="px-3 py-2.5">
                    {c.portal_send_id
                      ? <Badge className="bg-primary/15 font-normal text-primary hover:bg-primary/15">Sent from here</Badge>
                      : c.imported_status === 'draft'
                        ? <Badge variant="outline" className="font-normal text-warning">Draft</Badge>
                        : <span className="text-xs text-muted-foreground">Not sent from here</span>}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    <Link href={`/b/${slug}/campaigns/${c.campaign_id}`} aria-label={`Open ${c.name}`}>
                      <ChevronRight className="size-4" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 max-w-3xl text-xs text-muted-foreground">
        The campaign exports carry no status column, so “draft” here means a campaign whose
        name begins with “Draft” and which reports no sends. Those rows still carry a send
        date, which is why the date alone is not used.
      </p>
    </>
  );
}

type Row = {
  campaign_id: string; external_id: string; name: string; channel: string;
  sent_at: string | null; imported_status: string;
  reported_sent: number | null; observed_opened: number;
  portal_send_id: string | null;
};
