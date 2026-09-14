'use client';

import { useActionState, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { createClient } from '@/lib/supabase/browser';
import { signInWithPassword, type LoginState } from './actions';
import { AlertCircle, Loader2 } from 'lucide-react';

const OAUTH_MESSAGES: Record<string, string> = {
  signup_disabled: 'That Google account is not one of this portal’s users. Access is limited to the accounts your team was given.',
  no_membership: 'That account signed in, but it is not attached to a brand.',
  exchange_failed: 'We could not complete that sign-in. Please try again.',
  provider_email_needs_verification: 'Google has not verified the email address on that account.',
};

export function LoginForm() {
  const params = useSearchParams();
  const [state, action, pending] = useActionState<LoginState, FormData>(signInWithPassword, {});
  const [googlePending, setGooglePending] = useState(false);
  const oauthError = params.get('error');

  async function signInWithGoogle() {
    setGooglePending(true);
    const supabase = createClient();
    const next = params.get('next');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback${next ? `?next=${encodeURIComponent(next)}` : ''}`,
        queryParams: { prompt: 'select_account' },
      },
    });
    if (error) setGooglePending(false);
  }

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      {(state.error || oauthError) && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="size-4" />
          <AlertDescription>
            {state.error ?? OAUTH_MESSAGES[oauthError!] ?? 'Sign-in failed.'}
          </AlertDescription>
        </Alert>
      )}

      <form action={action} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required
                 placeholder="you@example.com" disabled={pending} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password"
                 required disabled={pending} />
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          Sign in
        </Button>
      </form>

      <div className="my-5 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <Button variant="outline" className="w-full" onClick={signInWithGoogle} disabled={googlePending}>
        {googlePending ? <Loader2 className="size-4 animate-spin" /> : <GoogleMark />}
        Continue with Google
      </Button>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" />
    </svg>
  );
}
