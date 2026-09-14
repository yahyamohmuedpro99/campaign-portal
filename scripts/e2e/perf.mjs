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

  console.log(`\n${brand}`);
  for (const [label, path, marker] of [
    ['dashboard',      `/b/${slug}/dashboard`,               'Total customers'],
    ['contacts',       `/b/${slug}/contacts`,                'Customer'],
    ['contacts page 2',`/b/${slug}/contacts`,                'Customer'],
    ['campaigns',      `/b/${slug}/campaigns`,               'Campaign'],
    ['data health',    `/b/${slug}/data`,                    'Rows read'],
  ]) {
    // warm once, then measure
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    const t0 = Date.now();
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`text=${marker}`, { timeout: 60000 });
    console.log(`  ${label.padEnd(16)} ${String(Date.now() - t0).padStart(5)} ms`);
  }
  await ctx.close();
}
await browser.close();
