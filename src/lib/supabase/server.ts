import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { cache } from 'react';

/**
 * The client for anything rendered or executed on the server on behalf of a signed-in
 * person. It carries the user's session and the anon key, so every query it makes is
 * subject to row-level security exactly as a direct API call from the browser would be.
 */
export async function createClient() {
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (toSet) => {
          try {
            for (const { name, value, options } of toSet) store.set(name, value, options);
          } catch {
            // Server Components cannot write cookies. Token rotation is handled by
            // proxy.ts, which runs before the render and can. Swallowing this is the
            // documented pattern; throwing here would break every page render.
          }
        },
      },
    },
  );
}

/**
 * Returns the signed-in user, verified against the auth server.
 *
 * Deliberately not getSession(): that reads the cookie and returns whatever it contains
 * without checking a signature, which is worthless as an authorisation input.
 *
 * Memoised for the life of one request. Verifying costs a round trip to the auth server,
 * and a single page render asks several times over — the layout and the page each resolve
 * the brand, and both start here. The check itself is not skipped; it is made once and
 * the answer reused, which is what React's cache() is for.
 */
export const getUser = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user;
});
