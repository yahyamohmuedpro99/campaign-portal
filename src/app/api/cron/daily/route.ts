import { NextResponse, type NextRequest } from 'next/server';
import { syncDeliveryReports } from '@/lib/send/sync';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * A once-a-day backstop, which is all the hosting plan allows and all it needs to be.
 *
 * The real delivery-report scheduler is pg_cron inside the database, ticking every minute
 * and calling /api/jobs/tick. This exists for two reasons: it catches anything that
 * scheduler missed, and its daily request keeps the database from being paused for
 * inactivity, which would take the portal down between reviews.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.JOB_SECRET;
  const auth = request.headers.get('authorization');
  const fromVercelCron = request.headers.get('x-vercel-cron') !== null;
  if (!fromVercelCron && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const sync = await syncDeliveryReports({ limit: 40, budgetMs: 240_000 });
    return NextResponse.json({ ok: true, sync }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
