/**
 * What someone actually sees when they press "Continue with Google".
 *
 * `scripts/e2e/google-check.mjs` asks the auth server whether the provider is configured.
 * This asks the browser what the button does about it. The two are different questions: a
 * disabled provider used to send the browser to the auth server, which answered with a raw
 * JSON error — so the check that matters here is not "was a message shown" but "was the
 * authorisation endpoint contacted at all".
 *
 *   SMOKE_BASE_URL=https://… node --env-file=.env scripts/e2e/google-button.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
let failures = 0;
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  · ' + detail : ''}`);
  if (!pass) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage();
const authorize = [];
page.on('request', (r) => { if (/\/auth\/v1\/authorize/.test(r.url())) authorize.push(r.url()); });

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
const settings = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`,
  { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY } }).then((r) => r.json());
const enabled = settings?.external?.google === true;
console.log(`\nGoogle provider is ${enabled ? 'enabled' : 'NOT enabled'} on the auth server.\n`);

await page.click('text=Continue with Google');
await page.waitForTimeout(4000);

const body = await page.evaluate(() => document.body.innerText);
const alerts = await page.$$eval('[role=alert]', (els) => els.map((e) => e.textContent?.trim()).filter(Boolean));
const button = page.locator('button', { hasText: 'Continue with Google' });

if (enabled) {
  // Configured: the button's job is to reach Google, so it should leave.
  check('the authorisation endpoint was reached', authorize.length > 0, `${authorize.length} request(s)`);
  check('the browser left for the sign-in flow', !page.url().startsWith(`${BASE}/login`), page.url().slice(0, 60));
} else {
  // Not configured: the button's job is to say so, without sending anyone anywhere.
  check('the authorisation endpoint was never contacted', authorize.length === 0,
        authorize.length ? `${authorize.length} request(s) — still redirecting` : 'no requests');
  check('the browser stayed on the sign-in page', page.url().startsWith(`${BASE}/login`), page.url().slice(0, 60));
  check('it explains itself in the page', alerts.some((a) => /not switched on/i.test(a)),
        alerts[0]?.slice(0, 64) ?? 'no message shown');
  check('no raw provider error is on screen', !/validation_failed|Unsupported provider/.test(body));
  check('the button is left usable', (await button.count()) === 1 && (await button.isEnabled()));
}

await browser.close();
console.log(failures === 0
  ? '\nThe button behaves for the state the provider is actually in.'
  : `\n${failures} problem(s).`);
process.exit(failures ? 1 : 0);
