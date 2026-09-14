import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Completes a Google sign-in.
 *
 * Public sign-up is switched off on the project, which is what keeps this portal to its
 * six accounts. Google still works for those six because the auth server links a Google
 * identity to an existing user whose verified email matches; only the branch that would
 * create a brand new user is refused. Anyone else arrives here with an error and is shown
 * a plain explanation rather than a stack trace.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const next = searchParams.get('next');
  const providerError = searchParams.get('error_code') ?? searchParams.get('error');

  if (providerError) {
    const reason = /signup|not.?allowed|disabled/i.test(providerError) ? 'signup_disabled' : providerError;
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(reason)}`);
  }
  if (!code) return NextResponse.redirect(`${origin}/login?error=exchange_failed`);

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const reason = /signup|not.?allowed|disabled/i.test(error.message) ? 'signup_disabled' : 'exchange_failed';
    return NextResponse.redirect(`${origin}/login?error=${reason}`);
  }

  // Signing in is not the same as belonging to a brand. An account with no membership
  // sees every route return nothing, so say so plainly instead.
  const { data: memberships } = await supabase.from('brand_members').select('brand_id').limit(1);
  if (!memberships || memberships.length === 0) {
    return NextResponse.redirect(`${origin}/no-access`);
  }

  return NextResponse.redirect(`${origin}${next && next.startsWith('/') ? next : '/'}`);
}
