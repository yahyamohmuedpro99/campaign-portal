import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let database: 'ok' | 'unreachable' = 'unreachable';
  try {
    const res = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
      signal: AbortSignal.timeout(5000), cache: 'no-store',
    });
    if (res.ok) database = 'ok';
  } catch { /* reported as unreachable */ }

  return NextResponse.json(
    { status: database === 'ok' ? 'ok' : 'degraded', database, time: new Date().toISOString() },
    { status: database === 'ok' ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
