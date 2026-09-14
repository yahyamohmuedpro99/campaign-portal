import { chromium } from 'playwright';
const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`);
await page.fill('#email', 'yahyamohmuedpro99@gmail.com');
await page.fill('#password', process.env.SEED_PASSWORD_KILELE_OWNER);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 60000 }), page.click('button[type=submit]')]);

for (const path of ['/b/kilele/dashboard', '/b/kilele/contacts', '/b/kilele/campaigns', '/b/kilele/data']) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  const res = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        // only report the outermost offenders
        const parent = el.parentElement;
        const pr = parent?.getBoundingClientRect();
        if (pr && pr.right > vw + 1) continue;
        bad.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 70),
                   right: Math.round(r.right), text: (el.textContent || '').trim().slice(0, 30) });
      }
    }
    return { vw, scroll: document.documentElement.scrollWidth, bad: bad.slice(0, 5) };
  });
  console.log(`\n${path}  viewport=${res.vw} scrollWidth=${res.scroll}`);
  for (const b of res.bad) console.log(`  <${b.tag}> right=${b.right}  "${b.text}"  ${b.cls}`);
}
await browser.close();
