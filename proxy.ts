import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Refreshes the session cookie and sends signed-out visitors to the login page.
 *
 * This is convenience, not security. It shapes where people land; it does not decide what
 * they can read. Authorisation lives in row-level security and in the SECURITY DEFINER
 * functions, both of which apply equally to a request that never passes through here —
 * such as a direct call to the database API with the anon key.
 *
 * The matcher deliberately excludes /share: a shared results page is for someone with no
 * account, and must never touch brand session handling.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;

  if (!user && (path.startsWith('/b/') || path === '/')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    if (path !== '/') url.searchParams.set('next', path);
    return NextResponse.redirect(url);
  }

  if (user && path === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ['/', '/b/:path*', '/login'],
};
