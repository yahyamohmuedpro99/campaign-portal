import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMembership } from '@/lib/brand';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/portal/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatCard } from '@/components/portal/stat-card';
import { DefinitionNote } from '@/components/portal/definition-note';
import { DEFINITIONS } from '@/lib/definitions';
import { ShareManager } from '@/components/portal/share-manager';
import { Send, Lock } from 'lucide-react';

export default async function CampaignPage({ params }: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const brand = await requireMembership(slug);
  const supabase = await createClient();

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, external_id, name, channel, target_country, sent_at, imported_status, spend, reported_sent, reported_delivered, reported_bounced, reported_opens, reported_clicks')
    .eq('id', id).maybeSingle();
  if (!campaign) notFound();

  const [{ data: perfRows }, { data: send }, { data: shares }] = await Promise.all([
    supabase.rpc('brand_campaign_performance', { p_brand_id: brand.brandId }),
    supabase.from('campaign_sends')
      .select('id, status, approved_count, approved_at, accepted_total, rejected_total, approved_by')
      .eq('campaign_id', id).neq('status', 'cancelled').maybeSingle(),
    supabase.from('campaign_shares')
      .select('id, label, created_at, expires_at, revoked_at, view_count, last_viewed_at')
      .eq('campaign_id', id).order('created_at', { ascending: false }),
  ]);

  const perf = ((perfRows ?? []) as PerfRow[]).find((p) => p.campaign_id === id);
  const isOwner = brand.role === 'owner';
  const fmt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString());
  const when = (s: string | null) => s
    ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: brand.timezone }).format(new Date(s))
    : '—';

  return (
    <>
      <PageHeader
        title={campaign.name}
        description={<>
          <span className="font-mono text-xs">{campaign.external_id}</span> · {campaign.channel}
          {campaign.target_country ? ` · targeted at ${campaign.target_country}` : ''}
          {campaign.imported_status === 'draft' && <Badge variant="outline" className="ml-2 text-warning">Draft</Badge>}
        </>}
        actions={
          send ? (
            <div className="flex flex-col items-end gap-1">
              <Button disabled className="gap-2"><Lock className="size-4" />Already sent</Button>
              <p className="max-w-[16rem] text-right text-xs text-muted-foreground">
                Sent {when(send.approved_at)} to {fmt(send.approved_count)} people.
                A campaign sends once. To send again, create a new campaign.
              </p>
              <Button asChild variant="link" size="sm" className="h-auto p-0">
                <Link href={`/b/${slug}/sends/${send.id}`}>See what happened →</Link>
              </Button>
            </div>
          ) : isOwner ? (
            <Button asChild className="gap-2">
              <Link href={`/b/${slug}/campaigns/${id}/send`}><Send className="size-4" />Send this campaign</Link>
            </Button>
          ) : (
            <div className="text-right">
              <Button disabled className="gap-2"><Send className="size-4" />Send this campaign</Button>
              <p className="mt-1 text-xs text-muted-foreground">Analysts can view but not send.</p>
            </div>
          )
        }
      />

      <section>
        <h2 className="mb-1 text-sm font-semibold">Three sources, side by side</h2>
        <p className="mb-3 max-w-3xl text-xs text-muted-foreground">
          These disagree, and that disagreement is real rather than a bug to be averaged
          away. The source system’s own numbers are its claims; the engagement log is what
          the export recorded happening; the third column is only present when this portal
          did the sending.
        </p>
        <div className="grid gap-4 lg:grid-cols-3">
          <SourcePanel title={DEFINITIONS.reportedMetrics.label} rule={DEFINITIONS.reportedMetrics.rule}
                       note={DEFINITIONS.reportedMetrics.note}
                       rows={[['Sent', fmt(campaign.reported_sent)], ['Delivered', fmt(campaign.reported_delivered)],
                              ['Bounced', fmt(campaign.reported_bounced)], ['Opens', fmt(campaign.reported_opens)],
                              ['Clicks', fmt(campaign.reported_clicks)],
                              ['Spend', campaign.spend == null ? '—' : Number(campaign.spend).toLocaleString(undefined, { minimumFractionDigits: 2 })]]} />
          <SourcePanel title={DEFINITIONS.observedMetrics.label} rule={DEFINITIONS.observedMetrics.rule}
                       note={DEFINITIONS.observedMetrics.note}
                       rows={[['Delivered', fmt(perf?.observed_delivered)], ['Opened', fmt(perf?.observed_opened)],
                              ['Clicked', fmt(perf?.observed_clicked)], ['Bounced', fmt(perf?.observed_bounced)],
                              ['Unsubscribed', fmt(perf?.observed_unsubscribed)],
                              ['Complained', fmt(perf?.observed_complained)]]}
                       footnote="Counted per person, so one customer opening four times counts once." />
          <SourcePanel title={DEFINITIONS.portalMetrics.label} rule={DEFINITIONS.portalMetrics.rule}
                       note={DEFINITIONS.portalMetrics.note}
                       rows={send ? [['Approved', fmt(send.approved_count)], ['Accepted', fmt(perf?.portal_accepted)],
                              ['Delivered', fmt(perf?.portal_delivered)], ['Bounced', fmt(perf?.portal_bounced)],
                              ['Opened', fmt(perf?.portal_opened)],
                              ['Unsubscribed', fmt(perf?.portal_unsubscribed)]] : []}
                       empty="This campaign has not been sent from this portal." />
        </div>
      </section>

      {send && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold">Send from this portal</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Status" value={<span className="text-base">{send.status.replace(/_/g, ' ')}</span>} />
            <StatCard label="Approved" value={fmt(send.approved_count)}
                      rule={DEFINITIONS.audience.rule} note={DEFINITIONS.audience.note} />
            <StatCard label="Accepted by provider" value={fmt(send.accepted_total)} />
            <StatCard label="Rejected by provider" value={fmt(send.rejected_total)} />
          </div>
          <Button asChild variant="outline" size="sm" className="mt-3">
            <Link href={`/b/${slug}/sends/${send.id}`}>Open the full record of this send</Link>
          </Button>
        </section>
      )}

      <ShareManager slug={slug} campaignId={id} campaignName={campaign.name}
                    isOwner={isOwner} hasSend={Boolean(send)}
                    shares={(shares ?? []) as ShareRow[]} timezone={brand.timezone} />
    </>
  );
}

type PerfRow = {
  campaign_id: string;
  observed_delivered: number; observed_opened: number; observed_clicked: number;
  observed_bounced: number; observed_unsubscribed: number; observed_complained: number;
  portal_accepted: number; portal_delivered: number; portal_bounced: number;
  portal_opened: number; portal_unsubscribed: number;
};
type ShareRow = {
  id: string; label: string | null; created_at: string; expires_at: string;
  revoked_at: string | null; view_count: number; last_viewed_at: string | null;
};

function SourcePanel({ title, rule, note, rows, footnote, empty }: {
  title: string; rule: string; note: string;
  rows: [string, string][]; footnote?: string; empty?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-1.5">
        <h3 className="text-sm font-medium">{title}</h3>
        <DefinitionNote rule={rule} note={note} />
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{empty}</p>
      ) : (
        <dl className="space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="tabular text-sm font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {footnote && <p className="mt-3 border-t pt-2 text-[11px] text-muted-foreground">{footnote}</p>}
    </div>
  );
}
