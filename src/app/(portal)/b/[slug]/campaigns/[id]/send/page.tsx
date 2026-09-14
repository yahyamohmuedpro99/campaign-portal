import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireMembership } from '@/lib/brand';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/portal/page-header';
import { DEFINITIONS } from '@/lib/definitions';
import { ConfirmSend } from '@/components/portal/confirm-send';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function SendPreviewPage({ params }: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const brand = await requireMembership(slug);
  if (brand.role !== 'owner') redirect(`/b/${slug}/campaigns/${id}`);

  const supabase = await createClient();
  const { data: campaign } = await supabase
    .from('campaigns').select('id, external_id, name, channel, target_country')
    .eq('id', id).maybeSingle();
  if (!campaign) notFound();

  // One live send per campaign. If one already exists, show it rather than offering a
  // second one that the database would refuse.
  const { data: existing } = await supabase
    .from('campaign_sends').select('id').eq('campaign_id', id).neq('status', 'cancelled').maybeSingle();
  if (existing) redirect(`/b/${slug}/sends/${existing.id}`);

  const { data: previewData, error: previewError } = await supabase
    .rpc('preview_campaign_send', { p_campaign_id: id });
  const preview = (Array.isArray(previewData) ? previewData[0] : previewData) as Preview | null;

  if (previewError || !preview) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
        <h2 className="font-semibold">This send could not be prepared</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {previewError?.message ?? 'No audience could be computed.'}
        </p>
        <Link href={`/b/${slug}/campaigns/${id}`} className="mt-3 inline-block text-sm underline">
          Back to the campaign
        </Link>
      </div>
    );
  }

  const [{ data: sample }, { data: waterfall }] = await Promise.all([
    supabase.rpc('campaign_audience', { p_campaign_id: id, p_limit: 25, p_offset: 0 }),
    supabase.rpc('brand_contactability_waterfall', { p_brand_id: brand.brandId }),
  ]);

  const rule = preview.audience_rule as {
    channel: string; target_country: string | null; requires: string; excludes: string[];
  };
  const contactable = ((waterfall ?? []) as { step_key: string; remaining: number }[])
    .find((s) => s.step_key === 'contactable')?.remaining ?? 0;

  return (
    <>
      <PageHeader
        title={`Send “${campaign.name}”`}
        description={<>Check who this goes to before anything leaves. Nothing has been sent yet.</>}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div>
          <div className="rounded-xl border bg-card p-5">
            <p className="text-sm text-muted-foreground">This will be sent to</p>
            <p className="tabular mt-1 text-4xl font-semibold tracking-tight">
              {preview.recipient_count.toLocaleString()}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {preview.recipient_count === 1 ? 'person' : 'people'} by {rule.channel}
            </p>

            <div className="mt-5 border-t pt-4">
              <h2 className="text-sm font-medium">Who that is</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Contactable customers of {brand.name} who have {rule.requires}
                {rule.target_country ? `, in ${rule.target_country}` : ''}.
              </p>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {rule.excludes.map((e) => <li key={e} className="flex gap-2"><span>·</span><span>Excludes {e}</span></li>)}
              </ul>
              {contactable !== preview.recipient_count && (
                <p className="mt-3 rounded-lg bg-muted/50 p-3 text-xs">
                  Your dashboard shows <span className="tabular font-medium">{contactable.toLocaleString()}</span> contactable
                  customers. This send reaches <span className="tabular font-medium">{preview.recipient_count.toLocaleString()}</span> of
                  them, because a {rule.channel} campaign needs {rule.requires} and not every contactable
                  customer has one.
                </p>
              )}
            </div>
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <h2 className="text-sm font-medium">The first 25 recipients</h2>
              <Badge variant="secondary" className="font-normal">
                of {preview.recipient_count.toLocaleString()}
              </Badge>
            </div>
            <table className="w-full min-w-[520px] text-sm">
              <thead><tr className="border-b bg-muted/30 text-left">
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">{rule.channel === 'email' ? 'Email' : 'Mobile'}</th>
                <th className="px-3 py-2 font-medium">Country</th>
              </tr></thead>
              <tbody className="divide-y">
                {((sample ?? []) as SampleRow[]).map((r) => (
                  <tr key={r.contact_id}>
                    <td className="px-4 py-2">
                      <div>{r.full_name ?? <span className="text-muted-foreground">No name</span>}</div>
                      <div className="font-mono text-xs text-muted-foreground">{r.external_id}</div>
                    </td>
                    <td className="px-3 py-2">{rule.channel === 'email' ? r.email : r.phone_e164}</td>
                    <td className="px-3 py-2 text-muted-foreground">{r.country ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="space-y-4">
          <ConfirmSend slug={slug} campaignId={id} previewId={preview.id}
                       count={preview.recipient_count} channel={rule.channel} />
          <div className="rounded-xl border bg-card p-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <div>
                <h3 className="text-sm font-medium">{DEFINITIONS.sendsOnce.label}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{DEFINITIONS.sendsOnce.note}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4 text-xs text-muted-foreground">
            <h3 className="mb-1 text-sm font-medium text-foreground">If something interrupts it</h3>
            <p>
              The send is split into batches and each batch is recorded before it is sent and
              again after. Closing this page, losing connection, or pressing confirm twice
              cannot send anyone the same message twice, and a batch whose outcome we never
              learned is flagged for you rather than quietly retried.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}

type Preview = {
  id: string; recipient_count: number; audience_fingerprint: string; audience_rule: unknown;
};
type SampleRow = {
  contact_id: string; external_id: string; full_name: string | null;
  email: string | null; phone_e164: string | null; country: string | null;
};
