import { Suspense } from 'react';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in · Campaign Portal' };

export default function LoginPage() {
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
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
