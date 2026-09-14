// Stores the endpoint and bearer token that pg_cron uses, in Supabase Vault.
//
// Kept out of the migration on purpose: a migration lives in a public repository and a
// bearer token does not. Run once per environment, and again if JOB_SECRET changes.
import { connect } from './lib/db.mjs';

const appUrl = process.env.NEXT_PUBLIC_APP_URL;
const secret = process.env.JOB_SECRET;
if (!appUrl || !secret) throw new Error('NEXT_PUBLIC_APP_URL and JOB_SECRET are required');

const c = await connect();
const put = async (name, value) => {
  const { rows } = await c.query(`select id from vault.secrets where name = $1`, [name]);
  if (rows.length) await c.query(`select vault.update_secret($1, $2, $3)`, [rows[0].id, value, name]);
  else await c.query(`select vault.create_secret($1, $2)`, [value, name]);
};

await put('job_tick_url', `${appUrl.replace(/\/$/, '')}/api/jobs/tick`);
await put('job_secret', secret);

const { rows: names } = await c.query(
  `select name, created_at from vault.secrets where name in ('job_tick_url','job_secret') order by name`);
console.table(names);

const { rows: jobs } = await c.query(
  `select jobid, schedule, jobname, active from cron.job order by jobid`);
console.table(jobs);
await c.end();
