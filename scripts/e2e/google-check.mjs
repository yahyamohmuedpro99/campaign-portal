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
  // Google hands the browser back to Supabase, which then hands it to whatever was asked
  // for in redirect_to — but only if that URL is on the project's allow list. When it is
  // not, the person lands on the site URL instead, which is how a sign-in on the live
  // site ends up on somebody's laptop.
  const state = q.get('state') ?? '';
  const payload = JSON.parse(Buffer.from(state.split('.')[1] ?? '', 'base64url').toString() || '{}');
  const wanted = `${app}/auth/callback`;
  check('it will come back to this app, not somewhere else',
        (payload.site_url ?? payload.referrer ?? '') === wanted,
        payload.site_url ?? payload.referrer ?? 'not in the state token');
}

console.log(problems === 0
  ? '\nGoogle sign-in is live and the portal is invite-only. Try it with both Kilele accounts.'
  : `\n${problems} problem(s). See docs/google-sign-in-setup.md.`);
process.exit(problems ? 1 : 0);
