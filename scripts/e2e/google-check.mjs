// Reports whether Google sign-in is configured, without needing a browser.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const app = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
if (!url || !anon) throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required');

const settings = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anon } }).then((r) => r.json());
const google = settings?.external?.google === true;
console.log(`Google provider enabled:      ${google ? 'yes' : 'NO'}`);
console.log(`New sign-ups allowed:         ${settings?.disable_signup ? 'no (only existing users)' : 'yes'}`);

// Follow the authorize endpoint far enough to see where it points, without signing in.
const authorize = `${url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(app + '/auth/callback')}`;
const res = await fetch(authorize, { redirect: 'manual' });
const location = res.headers.get('location') ?? '';
const toGoogle = location.startsWith('https://accounts.google.com');
console.log(`Authorize redirects to Google: ${toGoogle ? 'yes' : 'NO'}`);
if (toGoogle) {
  const q = new URL(location).searchParams;
  console.log(`  client id ends with:        …${(q.get('client_id') ?? '').slice(-14)}`);
  console.log(`  redirect uri:               ${q.get('redirect_uri')}`);
} else if (location) {
  console.log(`  redirected to instead:      ${location.slice(0, 120)}`);
}
console.log(google && toGoogle
  ? '\nGoogle sign-in is live. Open the site and try it with both Kilele accounts.'
  : '\nNot configured yet. See docs/google-sign-in-setup.md.');
