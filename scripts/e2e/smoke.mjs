// Signs in as each seeded user and checks what they can see. Credentials come from the
// environment; nothing secret is printed.
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const USERS = [
  ['kilele owner',    'yahyamohmuedpro99@gmail.com',       'SEED_PASSWORD_KILELE_OWNER',    'kilele'],
  ['kilele analyst',  'yahya.mo.asr@gmail.com',            'SEED_PASSWORD_KILELE_ANALYST',  'kilele'],
  ['karoo owner',     'owner@karoo.vg-eval.test',          'SEED_PASSWORD_KAROO_OWNER',     'karoo'],
  ['karoo analyst',   'analyst@karoo.vg-eval.test',        'SEED_PASSWORD_KAROO_ANALYST',   'karoo'],
  ['marrakech owner', 'owner@marrakech.vg-eval.test',      'SEED_PASSWORD_MARRAKECH_OWNER', 'marrakech'],
  ['marrakech analyst','analyst@marrakech.vg-eval.test',   'SEED_PASSWORD_MARRAKECH_ANALYST','marrakech'],
];

const browser = await chromium.launch();
let failures = 0;

for (const [label, email, pwVar, expectSlug] of USERS) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('#email', email);
    await page.fill('#password', process.env[pwVar]);
    await Promise.all([
      page.waitForURL(/\/b\/[a-z]+\/dashboard/, { timeout: 30000 }),
      page.click('button[type=submit]'),
    ]);
    const url = page.url();
    await page.waitForSelector('text=Total customers', { timeout: 30000 });
    const total = await page.locator('.tabular').first().textContent()
      .catch(() => null);
    const slugOk = url.includes(`/b/${expectSlug}/`);
    const body = await page.textContent('body');
    const leak = ['Kilele', 'Karoo', 'Marrakech']
      .filter((n) => body.includes(n))
      .filter((n) => !url.includes(n.toLowerCase().slice(0, 6)));
    console.log(`${slugOk && leak.length === 0 ? 'PASS' : 'FAIL'}  ${label.padEnd(19)} ${url.replace(BASE, '')}` +
      `  customers=${(total ?? '?').trim()}${leak.length ? `  LEAKED:${leak}` : ''}` +
      `${errors.length ? `  console-errors=${errors.length}` : ''}`);
    if (!slugOk || leak.length) failures++;
    await page.screenshot({ path: `.scratch/shot-${expectSlug}-${label.split(' ')[1]}.png` });
  } catch (e) {
    console.log(`FAIL  ${label.padEnd(19)} ${String(e.message).split('\n')[0].slice(0, 110)}`);
    failures++;
  }
  await ctx.close();
}
await browser.close();
console.log(failures === 0 ? '\nAll six logins land in their own brand.' : `\n${failures} failure(s).`);
process.exit(failures ? 1 : 0);
