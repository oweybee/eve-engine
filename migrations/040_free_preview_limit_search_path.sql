-- 040_free_preview_limit_search_path.sql
-- =============================================================================
-- Hardening (Low): public.free_preview_limit() (added in 034_tiered_premium_access.sql)
-- was the one function in that migration missing `set search_path`, unlike its
-- sibling preview_*_ids() helpers. Flagged by the Supabase advisor as
-- function_search_path_mutable (audit 2026-07-19). Same fix already applied to
-- public.set_updated_at() in 035_db_housekeeping.sql.
-- =============================================================================

create or replace function public.free_preview_limit()
returns integer language sql immutable
set search_path = public, pg_catalog as $$ select 5 $$;
