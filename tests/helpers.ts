import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';

export const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
export const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
export const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const LOGINS = {
  kileleOwner:     { email: 'yahyamohmuedpro99@gmail.com',       pw: process.env.SEED_PASSWORD_KILELE_OWNER! },
  kileleAnalyst:   { email: 'yahya.mo.asr@gmail.com',            pw: process.env.SEED_PASSWORD_KILELE_ANALYST! },
  karooOwner:      { email: 'owner@karoo.vg-eval.test',          pw: process.env.SEED_PASSWORD_KAROO_OWNER! },
  karooAnalyst:    { email: 'analyst@karoo.vg-eval.test',        pw: process.env.SEED_PASSWORD_KAROO_ANALYST! },
  marrakechOwner:  { email: 'owner@marrakech.vg-eval.test',      pw: process.env.SEED_PASSWORD_MARRAKECH_OWNER! },
  marrakechAnalyst:{ email: 'analyst@marrakech.vg-eval.test',    pw: process.env.SEED_PASSWORD_MARRAKECH_ANALYST! },
} as const;

/** A client carrying a real user session, exactly as the browser would hold it. */
export async function signIn(who: keyof typeof LOGINS): Promise<SupabaseClient> {
  const c = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email: LOGINS[who].email, password: LOGINS[who].pw });
  if (error) throw new Error(`sign-in failed for ${who}: ${error.message}`);
  return c;
}

/** An unauthenticated client: the anon key and nothing else. */
export function anonClient(): SupabaseClient {
  return createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function db() {
  const c = new pg.Client({
    host: process.env.SUPABASE_DB_HOST ?? 'aws-1-eu-west-1.pooler.supabase.com',
    port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
    user: `postgres.${process.env.SUPABASE_PROJECT_REF}`,
    password: process.env.SUPABASE_DB_PASSWORD,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  return c;
}

/** Tables that legitimately carry no brand_id, each with the reason it is exempt. */
export const TENANT_EXEMPT: Record<string, string> = {
  brands: 'is the tenant list; its own id is what the policy filters on',
  share_access_attempts: 'rate-limit ledger for public share links; denied to every signed-in role',
};

/**
 * The isolation predicate each brand-scoped table's SELECT policy is expected to use.
 * The default is the standard one. The two exceptions are deliberately *tighter* than
 * the default, and are named here so that quietly relaxing either one fails the suite.
 */
export const DEFAULT_PREDICATE = 'user_brand_ids';
export const TIGHTER_PREDICATE: Record<string, string> = {
  // Your own membership row only, so colleagues' user ids cannot be enumerated.
  brand_members: 'auth.uid()',
  // Owners only, not every member of the brand.
  campaign_shares: 'is_brand_owner',
};
