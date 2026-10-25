-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261016202215, name performance_signals_pending_security_invoker. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Pending signals must respect value_signals RLS (tier gate). The view had lost
-- security_invoker, letting anon read every upcoming signal and bypass the paywall.
alter view public.performance_signals_pending set (security_invoker = true);
comment on view public.performance_signals_pending is 'Pending signals. MUST stay security_invoker=true so value_signals tier RLS applies. Re-set the option if this view is ever recreated.';
