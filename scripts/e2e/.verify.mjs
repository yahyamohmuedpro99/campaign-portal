import { chromium } from 'playwright';
const OUT = '/private/tmp/claude-501/-Users-yahyamohmued-Desktop-Projects-Private-campaign-portal/728d9346-b2ad-47c9-be50-0d20e69d76b9/scratchpad/shots';
const BASE = 'https://campaign-portal-ivory.vercel.app';
const b = await chromium.launch();
let bad = 0; const check=(l,p,d='')=>{console.log(`  ${p?'PASS':'FAIL'}  ${l}${d?'  · '+d:''}`);if(!p)bad++;};

const shoot = async (email, pwEnv, slug, file, w=1400) => {
  const ctx = await b.newContext({ viewport:{width:w,height:1000} }); const p = await ctx.newPage();
  await p.goto(`${BASE}/login`, { waitUntil:'networkidle' });
  await p.fill('#email', email); await p.fill('#password', process.env[pwEnv]);
  await Promise.all([p.waitForURL(/dashboard/,{timeout:60000}), p.click('button[type=submit]')]);
  await p.waitForTimeout(800);
  await p.screenshot({ path:`${OUT}/${file}.png` });
  const r = await p.evaluate(()=>({vw:document.documentElement.clientWidth, sw:document.documentElement.scrollWidth}));
  check(`${slug} dashboard fits ${w}px`, r.sw <= r.vw+1, `scrollWidth=${r.sw}`);
  await ctx.close();
};
console.log('live, production:');
await shoot('yahyamohmuedpro99@gmail.com','SEED_PASSWORD_KILELE_OWNER','kilele','prod-kilele');
await shoot('owner@karoo.vg-eval.test','SEED_PASSWORD_KAROO_OWNER','karoo','prod-karoo');
await shoot('yahyamohmuedpro99@gmail.com','SEED_PASSWORD_KILELE_OWNER','kilele','prod-mobile',390);

const ctx = await b.newContext({ viewport:{width:900,height:1000} }); const s = await ctx.newPage();
await s.goto(`${BASE}/share/cIIxd4DKg3oSmFm0Kqu3PnUz5lym_X-JUbKVfBRR0r4`, { waitUntil:'networkidle' });
const before = await s.evaluate(()=>document.body.innerText);
check('nothing shown before the password', !/delivered|bounced|opened/i.test(before));
await s.fill('input[type=password]','review-2026-marrakech');
await Promise.all([s.waitForFunction(()=>!/password protected/i.test(document.body.innerText),{timeout:30000}), s.click('button[type=submit]')]);
await s.waitForTimeout(500);
const html = await s.content(); const text = await s.evaluate(()=>document.body.innerText);
check('the report still opens', /delivered/i.test(text));
check('no email addresses in the page source', !/@[a-z0-9-]+\.[a-z]{2,}/i.test(html.replace(/<style[\s\S]*?<\/style>/g,'')));
check('no links back into the portal', (await s.locator('a[href*="/b/"]').count())===0);
await s.screenshot({ path:`${OUT}/prod-share.png` });
await b.close();
console.log(bad?`\n${bad} problem(s).`:'\nProduction verified.');
process.exit(bad?1:0);
