// Proves that importing the same files again leaves one set of customers, not two.
import { connect } from './lib/db.mjs';
import { execFileSync } from 'node:child_process';

const c = await connect();
const snapshot = async () => (await c.query(`
  select b.slug,
    (select count(*) from public.contacts       x where x.brand_id=b.id)::int contacts,
    (select count(*) from public.campaigns      x where x.brand_id=b.id)::int campaigns,
    (select count(*) from public.contact_events x where x.brand_id=b.id)::int events,
    (select count(*) from public.contacts x where x.brand_id=b.id and x.contactable_static
        and (x.suppressed_until is null or x.suppressed_until<=now()))::int contactable,
    (select count(*) from public.contacts x where x.brand_id=b.id and x.unsubscribed_at is not null)::int unsubscribed
  from public.brands b order by b.slug`)).rows;

const before = await snapshot();
console.log('before:'); console.table(before);
await c.end();

execFileSync('node', ['--env-file=.env', 'scripts/import.mjs'], { stdio: 'inherit' });

const c2 = await connect();
const after = (await c2.query(`
  select b.slug,
    (select count(*) from public.contacts       x where x.brand_id=b.id)::int contacts,
    (select count(*) from public.campaigns      x where x.brand_id=b.id)::int campaigns,
    (select count(*) from public.contact_events x where x.brand_id=b.id)::int events,
    (select count(*) from public.contacts x where x.brand_id=b.id and x.contactable_static
        and (x.suppressed_until is null or x.suppressed_until<=now()))::int contactable,
    (select count(*) from public.contacts x where x.brand_id=b.id and x.unsubscribed_at is not null)::int unsubscribed
  from public.brands b order by b.slug`)).rows;
console.log('after:'); console.table(after);
await c2.end();

const same = JSON.stringify(before) === JSON.stringify(after);
console.log(same ? '\nIDEMPOTENT: re-importing every file changed nothing.'
                 : '\nNOT IDEMPOTENT: counts moved.');
if (!same) process.exit(1);
