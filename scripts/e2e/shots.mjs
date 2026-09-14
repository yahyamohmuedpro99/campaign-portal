import { chromium } from 'playwright';
const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`);
await page.fill('#email', 'yahyamohmuedpro99@gmail.com');
await page.fill('#password', process.env.SEED_PASSWORD_KILELE_OWNER);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 60000 }), page.click('button[type=submit]')]);
for (const [name, path] of [
  ['dashboard', '/b/kilele/dashboard'],
  ['contacts', '/b/kilele/contacts'],
  ['data', '/b/kilele/data'],
]) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `.scratch/ui-${name}.png`, fullPage: false });
}
// phone width
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const mp = await m.newPage();
await mp.goto(`${BASE}/login`);
await mp.fill('#email', 'yahyamohmuedpro99@gmail.com');
await mp.fill('#password', process.env.SEED_PASSWORD_KILELE_OWNER);
await Promise.all([mp.waitForURL(/dashboard/, { timeout: 60000 }), mp.click('button[type=submit]')]);
await mp.waitForTimeout(900);
await mp.screenshot({ path: '.scratch/ui-mobile-dashboard.png', fullPage: false });
// does anything overflow horizontally?
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log('horizontal overflow at 390px:', overflow, 'px');
await browser.close();
