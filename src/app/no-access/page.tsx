import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { signOut } from '../(auth)/login/actions';
import { ShieldX } from 'lucide-react';

export const metadata = { title: 'No access · Campaign Portal' };

export default function NoAccessPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10 text-center">
      <div className="w-full max-w-md">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-muted">
          <ShieldX className="size-6 text-muted-foreground" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">This account has no brand</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You signed in successfully, but this account is not attached to any brand in this
          portal, so there is nothing here for it to show. Access is limited to the accounts
          your team was given.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <form action={signOut}>
            <Button type="submit" variant="outline" className="w-full sm:w-auto">Sign out</Button>
          </form>
          <Button asChild className="w-full sm:w-auto"><Link href="/login">Back to sign in</Link></Button>
        </div>
      </div>
    </main>
  );
}
