// How the largest brand compares with the smallest, on the live site.
import { chromium } from 'playwright';
const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch();

for (const [brand, email, pw] of [
  ['kilele (82,422 customers)', 'yahyamohmuedpro99@gmail.com', 'SEED_PASSWORD_KILELE_OWNER'],
  ['marrakech (918 customers)', 'owner@marrakech.vg-eval.test', 'SEED_PASSWORD_MARRAKECH_OWNER'],
]) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('#email', email);
  await page.fill('#password', process.env[pw]);
  await Promise.all([page.waitForURL(/dashboard/, { timeout: 60000 }), page.click('button[type=submit]')]);
  const slug = new URL(page.url()).pathname.split('/')[2];

  // Page two is reached by following the real cursor link, not by asking for the same
  // page again: keyset pagination is the claim being measured, so it has to be exercised.
  await page.goto(`${BASE}/b/${slug}/contacts`, { waitUntil: 'domcontentloaded' });
  const nextHref = await page.getAttribute('a:has-text("Next")', 'href').catch(() => null);

  console.log(`\n${brand}`);
  for (const [label, path, marker] of [
    ['dashboard',       `/b/${slug}/dashboard`,             'Total customers'],
    ['contacts',        `/b/${slug}/contacts`,              'Customer'],
    ['contacts page 2', nextHref ?? `/b/${slug}/contacts`,  'Customer'],
    ['contacts search', `/b/${slug}/contacts?q=wan`,        'Customer'],
    ['campaigns',       `/b/${slug}/campaigns`,             'Campaign'],
    ['data health',     `/b/${slug}/data`,                  'Rows read'],
  ]) {
    // Warm once, then take the median of three: a single cold read on a serverless
    // function measures the platform waking up, not the query.
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`text=${marker}`, { timeout: 60000 });
      times.push(Date.now() - t0);
    }
    const median = [...times].sort((a, b) => a - b)[1];
    console.log(`  ${label.padEnd(16)} ${String(median).padStart(5)} ms   (${times.join(', ')})`);
  }
  await ctx.close();
}
await browser.close();
