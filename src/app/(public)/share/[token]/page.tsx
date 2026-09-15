import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';
import { tokenHashHex, readShareSession, shareCookieName } from '@/lib/share/tokens';
import { UnlockForm } from './unlock-form';
import { brandStyleByName } from '@/lib/brand-identity';

// Never cached, never prerendered, never handed to a CDN. A cached copy of a protected
// report is the same leak as no password at all.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Campaign results',
  robots: { index: false, follow: false, nocache: true },
};

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Service role, because the reader has no account. What it may read is narrowed to one
  // share row found by the hash of the token in the URL, and then to that share's own
  // campaign; there is no parameter a visitor can bend to reach anything else.
  const db = createAdminClient();
  const { data: share } = await db
    .from('campaign_shares')
    .select('id, expires_at, revoked_at')
    .eq('token_hash', tokenHashHex(token))
    .maybeSingle();

  // Unknown, revoked and expired all look identical from outside: a plain 404 that reveals
  // nothing about whether the link ever existed.
  if (!share || share.revoked_at || new Date(share.expires_at) < new Date()) notFound();

  const jar = await cookies();
  const unlocked = await readShareSession(jar.get(shareCookieName(token))?.value, share.id);
  if (!unlocked) return <UnlockForm token={token} />;

  const { data: results } = await db.rpc('share_results_for', { p_share_id: share.id });
  const r = (results ?? null) as Results | null;
  if (!r) notFound();

  await db.rpc('share_record_view', { p_share_id: share.id });

  const fmt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString());
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

  return (
    <main data-brand style={brandStyleByName(r.brand_name)} className="mx-auto max-w-2xl px-4 py-10 sm:py-16">
      <header className="mb-8">
        {/* The company's own colour, so a report forwarded to a stranger still reads as
            having come from somewhere rather than from a generic tool. */}
        <div aria-hidden className="mb-4 h-[3px] w-12 bg-brand" />
        <p className="text-[13px] font-medium text-foreground">{r.brand_name}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{r.campaign_name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sent by {r.channel}
          {r.sent_at && <> on {new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(new Date(r.sent_at))}</>}.
        </p>
      </header>

      {/* One instrument, hairline-divided, rather than six identical floating cards.
          Delivered leads because it is the question the report answers; the rest is the
          context that makes it meaningful. */}
      <section className="grid grid-cols-2 overflow-hidden rounded-lg border bg-card sm:grid-cols-3
                          [&>*]:border-border [&>*]:border-t [&>*]:border-l
                          [&>*:nth-child(-n+2)]:border-t-0 sm:[&>*:nth-child(3)]:border-t-0
                          [&>*:nth-child(odd)]:border-l-0 sm:[&>*]:border-l sm:[&>*:nth-child(3n+1)]:border-l-0">
        <Tile lead label="Delivered" value={fmt(r.delivered)} sub={pct(r.delivered, r.approved) + ' of sent'} />
        <Tile label="Sent to" value={fmt(r.approved)} />
        <Tile label="Bounced" value={fmt(r.bounced)} sub={pct(r.bounced, r.approved) + ' of sent'} />
        {r.channel === 'email' && (
          <Tile label="Opened" value={fmt(r.opened)} sub={pct(r.opened, r.delivered) + ' of delivered'} />
        )}
        <Tile label="Unsubscribed" value={fmt(r.unsubscribed)} />
        <Tile label="Reported spam" value={fmt(r.complained)} />
      </section>

      <section className="mt-8 rounded-xl border bg-card p-4 text-sm">
        <h2 className="font-medium">How these are counted</h2>
        <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
          <li>“Sent to” is the number approved before sending, which is the number the
            messaging provider was asked to deliver.</li>
          <li>Delivery, bounces, opens and unsubscribes are as reported by the messaging
            provider, counted once per person.</li>
          {r.channel === 'sms' && <li>SMS carries no open tracking, so no open rate is shown.</li>}
          <li>The open rate is a share of delivered messages, not of messages sent: one that
            bounced was never an opportunity to open.</li>
          {r.last_polled_at && (
            <li>Reports last collected{' '}
              {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
                .format(new Date(r.last_polled_at))}. These figures can still move.</li>
          )}
        </ul>
      </section>

      <footer className="mt-8 text-center text-xs text-muted-foreground">
        This page shows one campaign’s totals. It contains no customer records and no other
        campaign.
      </footer>
    </main>
  );
}

type Results = {
  campaign_name: string; brand_name: string; channel: string; sent_at: string | null;
  approved: number; accepted: number; delivered: number; bounced: number;
  opened: number; unsubscribed: number; complained: number;
  status: string | null; last_polled_at: string | null;
};

function Tile({ label, value, sub, lead }: {
  label: string; value: string; sub?: string; lead?: boolean;
}) {
  return (
    <div className={`px-4 py-4 ${lead ? 'bg-brand/[0.05]' : ''}`}>
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className={`figure mt-1.5 leading-none ${lead ? 'text-brand text-[2rem]' : 'text-2xl'}`}>
        {value}
      </div>
      {sub && <div className="mt-2 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
