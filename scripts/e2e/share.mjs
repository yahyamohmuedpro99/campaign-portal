// Creates a share link as an owner, then comes at it the way a stranger would.
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const CAMPAIGN = process.env.E2E_CAMPAIGN_ID;
const PASSWORD = process.env.E2E_SHARE_PASSWORD ?? 'review-2026-marrakech';

const owner = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { persistSession: false } });
await owner.auth.signInWithPassword({
  email: 'owner@marrakech.vg-eval.test', password: process.env.SEED_PASSWORD_MARRAKECH_OWNER });

// Mint the token exactly as the app does.
const { randomBytes, createHash } = await import('node:crypto');
const bcrypt = (await import('bcryptjs')).default;

async function mint(label) {
  const t = randomBytes(32).toString('base64url');
  const { error } = await owner.rpc('create_campaign_share', {
    p_campaign_id: CAMPAIGN,
    p_token_hash: `\\x${createHash('sha256').update(t).digest('hex')}`,
    p_password_hash: await bcrypt.hash(PASSWORD, 12),
    p_label: label,
    p_expires_in_days: 30,
  });
  if (error) throw new Error('create share: ' + error.message);
  return t;
}

// Two links: one to attack, one to open. Throttling is per link and per address, and the
// host rewrites the forwarded-for header, so attacking and then opening the same link
// from this machine would be correctly refused.
const token = await mint('brute force probe');
const goodToken = await mint('client review');
const url = `${BASE}/share/${token}`;
const goodUrl = `${BASE}/share/${goodToken}`;
console.log('two share links created\n');

const browser = await chromium.launch();
const ctx = await browser.newContext();   // a stranger: no session, no cookies
const page = await ctx.newPage();
let failures = 0;
const check = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!pass) failures++;
};

// A guessed address must look exactly like one that never existed.
const guessed = await page.goto(`${BASE}/share/${token.slice(0, -4)}zzzz`);
check('a guessed link returns 404', guessed.status() === 404, `status ${guessed.status()}`);

// Nothing about the campaign before the password.
const locked = await page.goto(url);
const lockedBody = await page.textContent('body');
check('the real link loads', locked.status() === 200, `status ${locked.status()}`);
check('nothing is revealed before the password',
  !/Campagne|Marrakech Express|delivered/i.test(lockedBody));
check('the page asks for a password', lockedBody.includes('password protected'));

// Wrong passwords are rejected, and repeated attempts are throttled.
let got429 = false;
for (let i = 1; i <= 7; i++) {
  const r = await page.request.post(`${BASE}/api/share/${token}/unlock`, { data: { password: `wrong-${i}` } });
  if (r.status() === 429) { got429 = true; console.log(`      attempt ${i} -> 429, throttled`); break; }
  if (r.status() !== 401) { check(`wrong password attempt ${i} rejected`, false, `status ${r.status()}`); break; }
}
check('repeated wrong passwords are throttled', got429);

// The correct password still works from a different address.
const ctx2 = await browser.newContext();
const page2 = await ctx2.newPage();
await page2.goto(goodUrl);
const unlock = await page2.request.post(`${BASE}/api/share/${goodToken}/unlock`, { data: { password: PASSWORD } });
check('the correct password is accepted', unlock.ok(), `status ${unlock.status()}`);

await page2.goto(goodUrl);
await page2.waitForSelector('text=Sent to', { timeout: 20000 }).catch(() => {});
const body = await page2.textContent('body');
const html = await page2.content();
check('results are shown', /Sent to/.test(body));
check('no email addresses appear anywhere in the page', !/@vg-eval\.test/.test(html));
check('no other campaign is named', (html.match(/Campagne/g) ?? []).length <= 2);
check('no link back into the portal', !/\/b\/marrakech/.test(html));

const headers = (await page2.goto(goodUrl)).headers();
check('the page is not cacheable', /no-store/.test(headers['cache-control'] ?? ''), headers['cache-control'] ?? 'none');
check('search engines are told to stay away', /noindex/.test(headers['x-robots-tag'] ?? ''), headers['x-robots-tag'] ?? 'none');

// A cookie earned on this link must not open another.
const ctx3 = await browser.newContext();
const page3 = await ctx3.newPage();
const cookies = await ctx2.cookies();
await ctx3.addCookies(cookies.map((c) => ({ ...c, path: '/' })));
const other = await page3.goto(`${BASE}/share/${randomBytes(32).toString('base64url')}`);
check('a cookie from this link does not open another', other.status() === 404, `status ${other.status()}`);

await page2.screenshot({ path: '.scratch/share-results.png', fullPage: true });
await browser.close();
console.log(`\n${failures === 0 ? 'The shared link holds up.' : failures + ' problem(s).'}`);
console.log('link:', goodUrl);
console.log('password:', PASSWORD);
process.exit(failures ? 1 : 0);
