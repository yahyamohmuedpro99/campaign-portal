import { createClient as createSupabaseClient } from '@supabase/supabase-js';

/**
 * Bypasses row-level security. Only ever used by code that is not acting as a user:
 * the campaign dispatcher, the provider-event poller, and rendering a public share page
 * after its password has been checked.
 *
 * Never import this into anything that runs for a signed-in visitor. Isolation for those
 * paths is the database's job, and handing them this client would take that job away.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
