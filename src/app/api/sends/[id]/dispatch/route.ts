import { NextResponse, type NextRequest } from 'next/server';
import { getUser, createClient } from '@/lib/supabase/server';
import { dispatchSend } from '@/lib/send/dispatch';

// Hobby functions can run for five minutes; the dispatcher keeps a margin inside that so
// it always returns its progress rather than being cut off mid-chunk.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Pushes a send forward.
 *
 * Called by the send page while it is open, and by the scheduled resumer for sends whose
 * dispatcher went away. Safe to call repeatedly and concurrently: whoever does not hold
 * the lease is told so and does nothing.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const jobSecret = process.env.JOB_SECRET;
  const auth = request.headers.get('authorization');
  const isJob = Boolean(jobSecret) && auth === `Bearer ${jobSecret}`;

  if (!isJob) {
    // An owner may push their own brand's send. Membership is checked by reading the
    // send through the user's own session, so row-level security decides, not this code.
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

    const supabase = await createClient();
    const { data: send } = await supabase
      .from('campaign_sends').select('id, brand_id').eq('id', id).maybeSingle();
    if (!send) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const { data: membership } = await supabase
      .from('brand_members').select('role').eq('brand_id', send.brand_id).maybeSingle();
    if (membership?.role !== 'owner') {
      return NextResponse.json({ error: 'only an owner can send' }, { status: 403 });
    }
  }

  const body = await request.json().catch(() => ({}));
  const maxChunks = Number.isInteger(body?.maxChunks) && body.maxChunks > 0 ? body.maxChunks : undefined;

  try {
    const outcome = await dispatchSend(id, { budgetMs: 240_000, maxChunks });
    return NextResponse.json(outcome, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
