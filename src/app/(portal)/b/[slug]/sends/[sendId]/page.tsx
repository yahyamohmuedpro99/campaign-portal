import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMembership } from '@/lib/brand';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/portal/page-header';
import { StatCard } from '@/components/portal/stat-card';
import { Badge } from '@/components/ui/badge';
import { DEFINITIONS } from '@/lib/definitions';
import { SendProgress } from '@/components/portal/send-progress';
import { SendTimeline } from '@/components/portal/send-timeline';

export const dynamic = 'force-dynamic';

export default async function SendPage({ params }: {
  params: Promise<{ slug: string; sendId: string }>;
}) {
  const { slug, sendId } = await params;
  const brand = await requireMembership(slug);
  const supabase = await createClient();

  const { data: send } = await supabase
    .from('campaign_sends')
    .select('id, status, approved_count, approved_at, accepted_total, rejected_total, audience_rule, campaigns(id, name, external_id, channel)')
    .eq('id', sendId).maybeSingle();
  if (!send) notFound();

  const [{ data: chunks }, { data: events }, { data: outcomes }] = await Promise.all([
    supabase.from('send_chunks')
      .select('id, chunk_no, status, recipient_count, attempts, provider_batch_id, accepted_count, rejected_count, last_polled_at, resolution_note')
      .eq('send_id', sendId).order('chunk_no'),
    supabase.from('send_events')
      .select('id, at, actor, event, detail').eq('send_id', sendId).order('id', { ascending: false }).limit(200),
    supabase.from('send_recipients')
      .select('provider_status').eq('send_id', sendId).limit(100000),
  ]);

  const campaign = send.campaigns as unknown as { id: string; name: string; external_id: string; channel: string };
  const chunkRows = (chunks ?? []) as ChunkRow[];
  // provider_status is derived from the timestamps by the database, so this breakdown
  // and the totals above cannot disagree.
  const tally = (outcomes ?? []).reduce<Record<string, number>>((a, r) => {
    const k = r.provider_status ?? 'not yet sent';
    a[k] = (a[k] ?? 0) + 1; return a;
  }, {});

  const { data: orphans } = await supabase.rpc('send_unattributable_events', { p_send_id: sendId });

  const { data: deliverability } = await supabase
    .from('send_recipients')
    .select('delivered_at, bounced_at, opened_at, unsubscribed_at, complained_at')
    .eq('send_id', sendId).limit(100000);
  const d = (deliverability ?? []).reduce((a, r) => ({
    delivered: a.delivered + (r.delivered_at ? 1 : 0),
    bounced: a.bounced + (r.bounced_at ? 1 : 0),
    opened: a.opened + (r.opened_at ? 1 : 0),
    unsubscribed: a.unsubscribed + (r.unsubscribed_at ? 1 : 0),
    complained: a.complained + (r.complained_at ? 1 : 0),
  }), { delivered: 0, bounced: 0, opened: 0, unsubscribed: 0, complained: 0 });

  const lastPolled = chunkRows.reduce<string | null>((a, c) =>
    !c.last_polled_at ? a : !a || c.last_polled_at > a ? c.last_polled_at : a, null);
  const isTerminal = ['completed', 'completed_with_failures', 'failed', 'cancelled'].includes(send.status);
  const fmt = (n: number) => n.toLocaleString();

  return (
    <>
      <PageHeader
        title={campaign.name}
        description={<>The full record of this send. <Link href={`/b/${slug}/campaigns/${campaign.id}`}
          className="underline">Back to the campaign</Link></>}
        actions={<Badge variant={send.status === 'completed' ? 'default' : 'secondary'} className="text-sm">
          {send.status.replace(/_/g, ' ')}
        </Badge>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Approved" value={fmt(send.approved_count)}
                  sub={new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: brand.timezone }).format(new Date(send.approved_at))}
                  rule={DEFINITIONS.audience.rule} note={DEFINITIONS.audience.note} />
        <StatCard label="Accepted by provider" value={fmt(send.accepted_total)}
                  sub={send.rejected_total > 0 ? `${fmt(send.rejected_total)} rejected` : 'None rejected'} />
        <StatCard label="Delivered" value={fmt(d.delivered)}
                  sub={`${fmt(d.bounced)} bounced`}
                  rule={DEFINITIONS.portalMetrics.rule} note={DEFINITIONS.portalMetrics.note} />
        <StatCard label="Opened" value={campaign.channel === 'sms' ? '—' : fmt(d.opened)}
                  sub={campaign.channel === 'sms' ? 'SMS has no open tracking'
                    : d.delivered > 0 ? `${Math.round((d.opened / d.delivered) * 100)}% of delivered` : 'No deliveries yet'}
                  rule={DEFINITIONS.openRate.rule} note={DEFINITIONS.openRate.note} />
      </div>

      <SendProgress sendId={sendId} isOwner={brand.role === 'owner'}
                    isTerminal={isTerminal} chunks={chunkRows} lastPolled={lastPolled}
                    approved={send.approved_count} timezone={brand.timezone} />

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="mb-1 text-sm font-semibold">Where each person stands</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            One row per person, showing their <span className="font-medium">final</span> outcome,
            so these add up to everyone the send went to. Someone whose message was
            delivered and who then unsubscribed appears once, under unsubscribed, which is
            why this reads lower than the delivered total above.
          </p>
          <div className="overflow-hidden rounded-xl border bg-card">
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <tr key={k}>
                    <td className="px-4 py-2 capitalize">{k.replace(/_/g, ' ')}</td>
                    <td className="tabular px-4 py-2 text-right font-medium">{fmt(v)}</td>
                  </tr>
                ))}
                {((orphans ?? []) as { event_type: string; events: number }[]).length > 0 && (
                  <tr className="bg-warning/5">
                    <td colSpan={2} className="px-4 py-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {((orphans ?? []) as { events: number }[]).reduce((a, o) => a + Number(o.events), 0)} report
                        {' '}could not be matched to anyone in this send.
                      </span>{' '}
                      The provider builds event identifiers from a short prefix of the batch
                      reference, so batches collide and one batch&rsquo;s page can carry
                      another&rsquo;s reports. They are kept and counted here rather than
                      discarded, and they are not added to any figure above.
                    </td>
                  </tr>
                )}
                {(d.unsubscribed > 0 || d.complained > 0) && (
                  <tr className="bg-muted/30">
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {fmt(d.unsubscribed)} unsubscribed and {fmt(d.complained)} reported spam as a
                      result of this send. They are already excluded from future sends.
                    </td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h2 className="mb-3 text-sm font-semibold">What happened, in order</h2>
          <SendTimeline events={(events ?? []) as TimelineEvent[]} timezone={brand.timezone} />
        </div>
      </section>
    </>
  );
}

type ChunkRow = {
  id: string; chunk_no: number; status: string; recipient_count: number; attempts: number;
  provider_batch_id: string | null; accepted_count: number | null; rejected_count: number | null;
  last_polled_at: string | null; resolution_note: string | null;
};
type TimelineEvent = {
  id: number; at: string; actor: string; event: string; detail: Record<string, unknown> | null;
};
