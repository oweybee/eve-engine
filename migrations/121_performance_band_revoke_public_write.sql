-- 121 — `performance_band` is TRUNCATE-able by anon and authenticated.
--
-- FOUND BY THE 6 Sep 2026 AUDIT, measured against production rather than
-- against the migration text. Every sibling table that shipped alongside
-- `performance_band` revokes default write privileges from the client roles
-- before granting the read it actually wants:
--
--   096  alter table public.band_calibration enable row level security;
--        ... revoke all on public.band_calibration from anon, authenticated;
--   111  alter table public.inplay_momentum enable row level security;
--        revoke all on public.inplay_momentum from anon, authenticated;
--
-- `performance_band` (103) enables RLS and grants SELECT, but never revokes
-- the INSERT/UPDATE/DELETE/TRUNCATE that Supabase's default privileges hand to
-- `anon`/`authenticated` on every new table in `public`. Measured live:
--
--   grantee        privileges on public.performance_band
--   anon           DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--   authenticated  DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- RLS still stops INSERT/UPDATE/DELETE — the only permissive policies on this
-- table are `performance_band_anon_read` (select using (published)) and
-- `performance_band_service` (all, to service_role): with no INSERT/UPDATE/
-- DELETE policy granted to anon or authenticated, RLS denies every row on
-- those three verbs regardless of the table-level grant.
--
-- TRUNCATE IS THE EXPOSURE, and it is not a new class of bug — it is exactly
-- Finding 1 from the 23 Aug audit (migrations 074/095): "RLS is enabled ...
-- with zero policies, so INSERT/UPDATE/DELETE are already denied. What was
-- genuinely exposed is TRUNCATE, which is never governed by RLS at all."
-- `performance_band` is the table this product's public track record is
-- rendered from (`/performance`, migration 112's rebuild trigger, the PRIME/
-- EDGE/Longshots yield figures) — a TRUNCATE against it from either client
-- role empties the published record with no RLS check able to stop it.
--
-- FIX: the same revoke the sibling tables already carry. Idempotent — safe to
-- re-run, and a no-op once applied.

begin;

revoke insert, update, delete, truncate on public.performance_band from anon, authenticated;

commit;

-- ── probe ───────────────────────────────────────────────────────────────────
do $$
declare v_priv boolean;
begin
  select bool_or(has_table_privilege(r, 'public.performance_band', p))
    into v_priv
    from unnest(array['anon', 'authenticated']) r,
         unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p;
  if coalesce(v_priv, false) then
    raise exception 'a client role can still write or truncate performance_band';
  end if;
  raise notice 'OK — anon/authenticated hold no write or truncate privilege on performance_band';
end $$;
