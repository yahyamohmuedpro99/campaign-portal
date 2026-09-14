// CLI entry point for the importer.
//
// This runs outside the web app deliberately. The largest contact export is 11.7 MB and
// a Vercel function accepts a 4.5 MB request body, so an in-app upload could not carry
// it. The results are written to the database and shown in the portal on the data page,
// which is where a marketer looks to see what did not load and why.
//
//   pnpm import                 all files, in dependency order
//   pnpm import -- kilele       only files for one brand
//   pnpm import -- --file=x.csv one file
import { connect } from './lib/db.mjs';
import { PROFILES } from './import/profiles.mjs';
import { importFile } from './import/run.mjs';

const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const fileArg = args.find((a) => a.startsWith('--file='))?.slice(7);
const dir = process.env.SEED_DIR ?? 'data/seed';

const client = await connect();
await client.query(`set statement_timeout = '600s'`);

const brands = Object.fromEntries((await client.query(
  `select slug, id, code, timezone from public.brands`)).rows.map((b) => [b.slug, b]));
if (Object.keys(brands).length === 0) throw new Error('no brands: run pnpm seed:users first');

// Order matters: campaigns before contacts before events, so foreign references resolve.
const ORDER = { campaigns: 0, contacts: 1, events: 2, send_log: 3 };
const todo = PROFILES
  .filter((p) => (only.length === 0 || only.includes(p.brand)))
  .filter((p) => (!fileArg || p.file === fileArg))
  .sort((a, b) => ORDER[a.entity] - ORDER[b.entity] || a.file.localeCompare(b.file));

console.log(`importing ${todo.length} file(s) from ${dir}\n`);
const results = [];
for (const profile of todo) {
  const t0 = Date.now();
  process.stdout.write(`  ${profile.file.padEnd(40)}`);
  const r = await importFile({ client, profile, path: `${dir}/${profile.file}`, brands });
  results.push(r);
  console.log(`read ${String(r.read).padStart(7)}  new ${String(r.inserted).padStart(7)}  ` +
    `updated ${String(r.updated).padStart(6)}  rejected ${String(r.rejected).padStart(5)}  ` +
    `warned ${String(r.warned).padStart(6)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

console.log('\nreasons:');
const all = {};
for (const r of results) for (const [k, v] of Object.entries(r.counts)) all[k] = (all[k] ?? 0) + v;
for (const [k, v] of Object.entries(all).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(46)} ${String(v).padStart(8)}`);
}

const { rows } = await client.query(
  `select b.slug,
          (select count(*) from public.contacts        c where c.brand_id = b.id) as contacts,
          (select count(*) from public.campaigns       c where c.brand_id = b.id) as campaigns,
          (select count(*) from public.contact_events  e where e.brand_id = b.id) as events,
          (select count(*) from public.contacts c where c.brand_id = b.id
             and c.contactable_static
             and (c.suppressed_until is null or c.suppressed_until <= now()))     as contactable
     from public.brands b order by contacts desc nulls last`);
console.log('');
console.table(rows);
await client.end();
