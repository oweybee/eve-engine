-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260829215050, name scoring_anchor_public_read. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- scoring_anchor had RLS enabled and NO policies at all: deny-all, flagged by
-- the advisor as rls_enabled_no_policy. The declared anchors are what the
-- published no_vig_clv figure is measured against, so /performance stated a
-- number and could not show its basis. Read-only; three rows of methodology
-- (bettable_panel_consensus, independent_consensus, pinnacle_anchor). Writes
-- stay with service_role. Matches model_calibration_read.
drop policy if exists scoring_anchor_read on public.scoring_anchor;
create policy scoring_anchor_read
  on public.scoring_anchor
  for select
  to public
  using (true);

grant select on public.scoring_anchor to anon, authenticated;
