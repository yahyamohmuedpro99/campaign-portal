import { NextResponse, type NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { createAdminClient } from '@/lib/supabase/admin';
import { tokenHashHex, issueShareSession, shareCookieName } from '@/lib/share/tokens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Checks the password on a shared report.
 *
 * Every failure answers the same way, whether the link never existed, was revoked, has
 * expired, or the password was simply wrong. Attempts are counted per link and per
 * address so the password cannot be worked through at speed.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { password } = await request.json().catch(() => ({ password: '' }));
  const deny = () => NextResponse.json({ error: 'That password is not correct.' }, { status: 401 });

  const db = createAdminClient();
  const hash = tokenHashHex(token);
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  const { data: gate } = await db.rpc('share_rate_limit_check', { p_token_hash: hash, p_ip: ip });
  const limit = Array.isArray(gate) ? gate[0] : gate;
  if (limit?.blocked) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again in a few minutes.' },
      { status: 429, headers: { 'Retry-After': '900' } });
  }

  const { data: share } = await db
    .from('campaign_shares')
    .select('id, password_hash, expires_at, revoked_at')
    .eq('token_hash', hash)
    .maybeSingle();

  // Hash a decoy when the link is unknown so a missing link and a wrong password take a
  // comparable amount of time to answer.
  if (!share || share.revoked_at || new Date(share.expires_at) < new Date()) {
    await bcrypt.compare(String(password ?? ''), '$2b$12$0000000000000000000000000000000000000000000000000000');
    await db.rpc('share_record_attempt', { p_token_hash: hash, p_ip: ip, p_ok: false });
    return deny();
  }

  const ok = await bcrypt.compare(String(password ?? ''), share.password_hash);
  await db.rpc('share_record_attempt', { p_token_hash: hash, p_ip: ip, p_ok: ok });
  if (!ok) return deny();

  const jwt = await issueShareSession(share.id);
  const res = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  res.cookies.set(shareCookieName(token), jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: `/share/${token}`,   // a cookie for one report opens only that report
    maxAge: 3600,
  });
  return res;
}
