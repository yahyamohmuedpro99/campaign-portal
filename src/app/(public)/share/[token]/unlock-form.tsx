'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Loader2, Lock } from 'lucide-react';

export function UnlockForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true); setError(null);
    const res = await fetch(`/api/share/${token}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const body = await res.json().catch(() => ({}));
    setPending(false);
    if (res.ok) { router.refresh(); return; }
    setError(body.error ?? 'That password is not correct.');
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl bg-muted">
            <Lock className="size-5 text-muted-foreground" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">This report is password protected</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter the password you were sent to see the results.
          </p>
        </div>

        <form onSubmit={submit} className="rounded-xl border bg-card p-6">
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle className="size-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" value={password} autoFocus
                   onChange={(e) => setPassword(e.target.value)} disabled={pending} />
          </div>
          <Button type="submit" className="mt-4 w-full" disabled={pending || !password}>
            {pending && <Loader2 className="size-4 animate-spin" />}View results
          </Button>
        </form>
      </div>
    </main>
  );
}
