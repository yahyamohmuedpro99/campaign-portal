// Creates the three brands and the six portal logins. Idempotent: safe to re-run.
//
// Public sign-up is disabled on the project, so these six users are the only accounts
// that exist. Google sign-in still works for them because GoTrue links a Google identity
// to an existing user whose verified email matches; only the create-a-new-user branch is
// blocked. Anyone else signing in with Google is refused and lands on /no-access.
import { createClient } from '@supabase/supabase-js';
import { connect } from './lib/db.mjs';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const BRANDS = [
  { slug: 'kilele',    code: 'KILELE',    name: 'Kilele Rides',      country: 'KE', timezone: 'Africa/Nairobi' },
  { slug: 'karoo',     code: 'KAROO',     name: 'Karoo Coaches',     country: 'ZA', timezone: 'Africa/Johannesburg' },
  { slug: 'marrakech', code: 'MARRAKECH', name: 'Marrakech Express', country: 'MA', timezone: 'Africa/Casablanca' },
];

// The two Kilele accounts are real Google-capable addresses so that Google sign-in can be
// demonstrated live for both roles, not just described.
const USERS = [
  { brand: 'kilele',    role: 'owner',   email: 'yahyamohmuedpro99@gmail.com', pw: 'SEED_PASSWORD_KILELE_OWNER' },
  { brand: 'kilele',    role: 'analyst', email: 'yahya.mo.asr@gmail.com',      pw: 'SEED_PASSWORD_KILELE_ANALYST' },
  { brand: 'karoo',     role: 'owner',   email: 'owner@karoo.vg-eval.test',       pw: 'SEED_PASSWORD_KAROO_OWNER' },
  { brand: 'karoo',     role: 'analyst', email: 'analyst@karoo.vg-eval.test',     pw: 'SEED_PASSWORD_KAROO_ANALYST' },
  { brand: 'marrakech', role: 'owner',   email: 'owner@marrakech.vg-eval.test',   pw: 'SEED_PASSWORD_MARRAKECH_OWNER' },
  { brand: 'marrakech', role: 'analyst', email: 'analyst@marrakech.vg-eval.test', pw: 'SEED_PASSWORD_MARRAKECH_ANALYST' },
];

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const db = await connect();

for (const b of BRANDS) {
  await db.query(
    `insert into public.brands (slug, code, name, country, timezone) values ($1,$2,$3,$4,$5)
     on conflict (slug) do update set code=excluded.code, name=excluded.name,
       country=excluded.country, timezone=excluded.timezone`,
    [b.slug, b.code, b.name, b.country, b.timezone]);
}
console.log(`brands: ${BRANDS.length}`);

// listUsers is paginated; six accounts fit comfortably in one page.
const { data: existing, error: listErr } = await admin.auth.admin.listUsers({ perPage: 200 });
if (listErr) throw listErr;
const byEmail = new Map(existing.users.map((u) => [u.email?.toLowerCase(), u]));

for (const u of USERS) {
  const password = process.env[u.pw];
  if (!password) throw new Error(`missing ${u.pw} in the environment`);
  let user = byEmail.get(u.email.toLowerCase());
  if (user) {
    const { error } = await admin.auth.admin.updateUserById(user.id, { password, email_confirm: true });
    if (error) throw error;
    console.log(`user  ${u.email.padEnd(38)} updated`);
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email: u.email, password, email_confirm: true,
      user_metadata: { brand: u.brand, role: u.role },
    });
    if (error) throw new Error(`${u.email}: ${error.message}`);
    user = data.user;
    console.log(`user  ${u.email.padEnd(38)} created`);
  }
  await db.query(
    `insert into public.brand_members (user_id, brand_id, role)
     select $1, b.id, $3 from public.brands b where b.slug = $2
     on conflict (user_id, brand_id) do update set role = excluded.role`,
    [user.id, u.brand, u.role]);
}

const { rows } = await db.query(
  `select b.slug, m.role, count(*)::int n from public.brand_members m
   join public.brands b on b.id = m.brand_id group by 1,2 order by 1,2`);
console.table(rows);
await db.end();
