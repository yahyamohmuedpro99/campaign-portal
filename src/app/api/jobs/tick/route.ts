import { NextResponse, type NextRequest } from 'next/server';
import { syncDeliveryReports } from '@/lib/send/sync';
import { dispatchSend } from '@/lib/send/dispatch';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * The heartbeat.
 *
 * The provider has no webhooks, so delivery, bounces, opens and unsubscribes only reach
 * us if something asks for them. This is that something, called every minute by pg_cron
 * from inside the database. It also restarts any send whose dispatcher disappeared, which
 * is what makes an interrupted send resume without anyone noticing it stopped.
 *
 * Protected by a shared secret rather than a user session, because no user is involved.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.JOB_SECRET;
  if (!secret) return NextResponse.json({ error: 'JOB_SECRET is not configured' }, { status: 500 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const started = Date.now();
  const resumed: { send_id: string; claimed: number; status: string }[] = [];

  try {
    const db = createAdminClient();
    const { data: stalled } = await db.rpc('sync_stalled_sends', { p_limit: 3 });
    for (const s of (stalled ?? []) as { send_id: string }[]) {
      if (Date.now() - started > 90_000) break;
      const o = await dispatchSend(s.send_id, { budgetMs: 60_000, worker: 'cron-resume' });
      resumed.push({ send_id: s.send_id, claimed: o.claimed, status: o.status });
    }

    const sync = await syncDeliveryReports({
      limit: 20,
      budgetMs: Math.max(20_000, 200_000 - (Date.now() - started)),
    });

    return NextResponse.json(
      { ok: true, ms: Date.now() - started, resumed, sync },
      { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
