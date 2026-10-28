-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260731120844, name grant_current_tier_execute_to_anon. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Completes migration 034 (tiered premium access): its RLS policies apply to the
-- anon role and call current_tier(), but anon was never granted EXECUTE on it,
-- so every anonymous SELECT on the five gated tables raised
-- "permission denied for function current_tier" instead of returning the
-- 5-row free preview. current_tier() is SECURITY DEFINER with a pinned
-- search_path and coalesces to 'free' for null auth.uid(), so this grant is safe.
grant execute on function public.current_tier() to anon;
