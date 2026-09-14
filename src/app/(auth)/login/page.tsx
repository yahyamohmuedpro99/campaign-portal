import { Suspense } from 'react';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in · Campaign Portal' };
export const dynamic = 'force-dynamic';

/**
 * Whether the auth server will actually accept a Google sign-in.
 *
 * `signInWithOAuth` cannot answer this: it builds the authorisation URL in the browser
 * without contacting anything, so it returns success even for a provider that is switched
 * off, and the browser then lands on the auth server's raw JSON error. The only party that
 * knows is the auth server, and it will say so on a public endpoint.
 *
 * Null means the question could not be answered here — a timeout or a bad response. That
 * is deliberately not the same as "no": hiding a working sign-in method because of a blip
 * would be its own bug, so the button stays and asks again from the browser before it
 * sends anyone anywhere.
 */
async function googleIsEnabled(): Promise<boolean | null> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const settings = await res.json();
    return settings?.external?.google === true;
  } catch {
    return null;
  }
}

export default async function LoginPage() {
  const googleEnabled = await googleIsEnabled();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 7l9 6 9-6" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="3" y="5" width="18" height="14" rx="2" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Campaign Portal</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to your brand’s workspace.</p>
        </div>
        <Suspense>
          <LoginForm googleEnabled={googleEnabled} />
        </Suspense>
      </div>
    </main>
  );
}
