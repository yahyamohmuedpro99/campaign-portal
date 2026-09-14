// Drives one real send through the interface, exactly as an owner would, and then
// watches the delivery reports arrive.
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const CAMPAIGN = process.env.E2E_CAMPAIGN_ID;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 140)); });

await page.goto(`${BASE}/login`);
await page.fill('#email', 'owner@marrakech.vg-eval.test');
await page.fill('#password', process.env.SEED_PASSWORD_MARRAKECH_OWNER);
await Promise.all([page.waitForURL(/dashboard/), page.click('button[type=submit]')]);
console.log('signed in as the Marrakech owner');

await page.goto(`${BASE}/b/marrakech/campaigns/${CAMPAIGN}/send`);
await page.waitForSelector('text=This will be sent to');
const count = (await page.locator('.tabular').first().textContent()).trim();
console.log('preview says:', count, 'recipients');

await page.screenshot({ path: '.scratch/send-1-preview.png', fullPage: true });

// Type the count to confirm, exactly as a marketer must.
await page.fill('#confirmCount', count.replace(/,/g, ''));
await Promise.all([
  page.waitForURL(/\/sends\//, { timeout: 60000 }),
  page.click('button:has-text("Send to")'),
]);
const sendUrl = page.url();
console.log('approved ->', sendUrl.replace(BASE, ''));

// The page dispatches by itself; wait for it to settle.
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(3000);
  const body = await page.textContent('body');
  const accepted = body.match(/Accepted by provider\s*([\d,]+)/)?.[1];
  const status = body.match(/^\s*(completed[a-z ]*|dispatching|approved|failed)/mi)?.[1];
  if (i % 3 === 0) console.log(`  t=${(i + 1) * 3}s accepted=${accepted ?? '?'} status=${(status ?? '?').trim()}`);
  if (body.includes('completed') && accepted && accepted !== '0') break;
}
await page.screenshot({ path: '.scratch/send-2-progress.png', fullPage: true });

// Now watch the delivery reports come in.
console.log('\ncollecting delivery reports:');
for (let i = 0; i < 8; i++) {
  await page.click('button:has-text("Refresh from provider")');
  await page.waitForTimeout(6000);
  await page.reload();
  await page.waitForSelector('text=Delivered');
  const body = await page.textContent('body');
  const grab = (label) => body.match(new RegExp(label + '\\s*([\\d,]+|—)'))?.[1] ?? '?';
  console.log(`  pass ${i + 1}: delivered=${grab('Delivered')} opened=${grab('Opened')} ` +
              `bounced=${(body.match(/([\d,]+) bounced/) ?? [])[1] ?? '?'}`);
}
await page.screenshot({ path: '.scratch/send-3-reports.png', fullPage: true });
console.log('\nsend page:', sendUrl);
await browser.close();
