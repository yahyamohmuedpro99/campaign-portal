-- =====================================================================================
-- Explicit deny policies.
--
-- A table with RLS enabled and no policy is already closed to every non-bypassing role,
-- but the intent is invisible: a reader cannot tell a deliberate lockdown from a table
-- someone forgot to write policies for. Stating the denial keeps the regression test
-- strict (every table must carry at least one policy, with no exemption list to grow).
-- =====================================================================================

-- The rate-limit ledger for share links. It records IP addresses of people attempting to
-- open a shared report, which belongs to no brand and is never shown in the product;
-- only the server, using the service role, reads or writes it.
create policy share_access_attempts_deny_all on public.share_access_attempts
  for all to authenticated, anon
  using (false) with check (false);
