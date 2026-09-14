// One place that knows how to reach Postgres. Discrete parameters rather than a URL,
// because the generated database password contains characters (space, quote, hash)
// that a URL parser mangles.
import pg from 'pg';

export function dbConfig() {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!ref || !password) throw new Error('SUPABASE_PROJECT_REF and SUPABASE_DB_PASSWORD are required');
  return {
    host: process.env.SUPABASE_DB_HOST ?? 'aws-1-eu-west-1.pooler.supabase.com',
    port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
    user: `postgres.${ref}`,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  };
}

export async function connect() {
  const c = new pg.Client(dbConfig());
  await c.connect();
  return c;
}

export function pool(max = 4) {
  return new pg.Pool({ ...dbConfig(), max });
}
