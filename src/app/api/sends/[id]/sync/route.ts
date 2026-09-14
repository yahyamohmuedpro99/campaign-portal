import { NextResponse, type NextRequest } from 'next/server';
import { getUser, createClient } from '@/lib/supabase/server';
import { syncDeliveryReports } from '@/lib/send/sync';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

/** Collects delivery reports for one send, on demand, for anyone who can see that send. */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  // Read the chunks through the caller's own session: row-level security decides whether
  // this send is theirs to look at, so nothing here needs to re-implement that check.
  const supabase = await createClient();
  const { data: chunks } = await supabase
    .from('send_chunks').select('id').eq('send_id', id).not('provider_batch_id', 'is', null);
  if (!chunks || chunks.length === 0) {
    return NextResponse.json({ ingested: 0, note: 'nothing has been handed to the provider yet' });
  }

  try {
    const out = await syncDeliveryReports({
      chunkIds: chunks.map((c) => c.id), budgetMs: 90_000,
    });
    return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
