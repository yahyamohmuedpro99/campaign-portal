// Reports whether Google sign-in is configured, and whether the settings that keep this
// portal to six accounts are still in force. Exits non-zero if something is wrong, so it
// can be trusted as a gate rather than read as a wall of text.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const app = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
if (!url || !anon) throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required');

let problems = 0;
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  · ' + detail : ''}`);
  if (!pass) problems++;
};

const settings = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anon } }).then((r) => r.json());

console.log('\nInvite-only');
// Not decoration. This was switched on by hand once, reverted, and went unnoticed for a
// day because nothing checked it. Declared in supabase/config.toml now, and checked here.
check('new sign-ups are refused', settings?.disable_signup === true,
      settings?.disable_signup === true ? 'only existing users' : 'ANYONE CAN SIGN UP');

const strangerId = `adam.wanjiru@sheridanpartners.co.ke`;
const res = await fetch(`${url}/auth/v1/signup`, {
  method: 'POST',
  headers: { apikey: anon, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: strangerId, password: `Rj-${crypto.randomUUID()}` }),
});
const body = await res.json().catch(() => ({}));
check('a stranger really is turned away', res.status >= 400 && !body?.id,
      `HTTP ${res.status} ${body?.error_code ?? ''}`);

console.log('\nGoogle');
const google = settings?.external?.google === true;
check('the provider is enabled', google);

// Follow the authorize endpoint far enough to see where it points, without signing in.
const authorize = `${url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(app + '/auth/callback')}`;
const auth = await fetch(authorize, { redirect: 'manual' });
const location = auth.headers.get('location') ?? '';
check('the authorisation URL goes to Google', location.startsWith('https://accounts.google.com'),
      location.startsWith('https://accounts.google.com') ? '' : location.slice(0, 100) || 'no redirect');

if (location.startsWith('https://accounts.google.com')) {
  const q = new URL(location).searchParams;
  console.log(`         client id ends …${(q.get('client_id') ?? '').slice(-14)}`);
  console.log(`         redirect uri  ${q.get('redirect_uri')}`);
  check('Google will hand the browser back to Supabase',
        q.get('redirect_uri') === `${url}/auth/v1/callback`, q.get('redirect_uri') ?? 'missing');
}

// What is deliberately NOT asserted here: that Supabase then forwards the browser to this
// app rather than to its site_url. The allow-list is declared in supabase/config.toml and
// `supabase config diff` reports whether the project still matches it, but the auth server
// does not apply it at /authorize — every redirect_to, allow-listed or not, is answered
// with a redirect to Google, and the check happens on the way back. An earlier version of
// this script claimed to verify it by decoding the state token; the token carries no such
// claim, so that check was reading an empty object and asserting against nothing. The
// return trip is proved by signing in, which is the last line below.

console.log(problems === 0
  ? '\nGoogle sign-in is live and the portal is invite-only. Try it with both Kilele accounts.'
  : `\n${problems} problem(s). See docs/google-sign-in-setup.md.`);
process.exit(problems ? 1 : 0);
