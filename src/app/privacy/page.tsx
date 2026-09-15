import Link from 'next/link';

export const metadata = {
  title: 'Privacy · Campaign Portal',
  description: 'What this portal stores about the people who sign in to it, and why.',
};

/**
 * A privacy policy, because Google will not publish an OAuth consent screen without one.
 *
 * It is short because the portal genuinely does very little with personal data: it holds
 * six accounts and a set of synthetic customer records supplied for an evaluation. Writing
 * a longer one would mean describing processing that does not happen.
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto min-h-dvh max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Privacy</h1>
      <p className="mt-2 text-sm text-muted-foreground">Last updated 15 September 2026</p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed">
        <section className="space-y-2">
          <h2 className="text-base font-semibold">What this is</h2>
          <p>
            Campaign Portal is a private, invite-only tool. Six accounts have access, each
            attached to one brand. It is not open for public registration, and nobody can
            create an account in it.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold">What we store about you when you sign in</h2>
          <p>
            If you sign in with Google, we receive your email address, your name and your
            profile picture URL, and nothing else. We ask Google for no other permission —
            no access to your mail, your files, your contacts or your calendar.
          </p>
          <p>
            Your email address is the only part we rely on: it is how the portal decides
            which brand you belong to. If it is not one of the six invited addresses, the
            sign-in is refused and no account is created for you.
          </p>
          <p>
            If you sign in with a password instead, we store the email address and a hashed
            password. We never store the password itself.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold">The customer data inside the portal</h2>
          <p>
            The contact records shown in this portal are synthetic. They were generated for
            an evaluation exercise and describe no real people. They are visible only to the
            brand they belong to, enforced in the database rather than in the interface.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold">Who else sees it</h2>
          <p>
            Nobody. Sign-in data is not sold, shared, or used for advertising, and it is not
            sent to any third party beyond the services that run the portal: Supabase, which
            stores the database and handles sign-in, and Vercel, which serves the pages.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold">How long it is kept, and how to remove it</h2>
          <p>
            Sign-in records are kept for as long as the account exists. An account that
            belongs to no brand is deleted automatically. To have your account removed at any
            time, email{' '}
            <a className="underline underline-offset-4" href="mailto:yahyamohmuedpro99@gmail.com">
              yahyamohmuedpro99@gmail.com
            </a>{' '}
            and it will be deleted along with everything attached to it.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold">Cookies</h2>
          <p>
            One cookie holds your sign-in session, and a second short-lived one is set if you
            unlock a shared report with a password. There is no analytics or tracking of any
            kind.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold">Contact</h2>
          <p>
            <a className="underline underline-offset-4" href="mailto:yahyamohmuedpro99@gmail.com">
              yahyamohmuedpro99@gmail.com
            </a>
          </p>
        </section>
      </div>

      <div className="mt-10 border-t pt-6">
        <Link href="/login" className="text-sm underline underline-offset-4">
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
