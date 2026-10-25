-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260829212107, name scoring_anchor_public_read. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- scoring_anchor: allow the declared anchors to be read.
-- RLS was enabled with no policies at all (deny-all, flagged by the Supabase
-- advisor as rls_enabled_no_policy), so the "Declared scoring anchors" table on
-- /performance rendered empty for every visitor. The published no_vig_clv figure
-- is measured against a declared row here, so with the table unreadable the page
-- states a number and cannot show its basis.
-- Read-only, whole table: three rows of methodology, nothing per-user to gate.
-- Matches the model_calibration_read convention. Writes stay with service_role.

drop policy if exists scoring_anchor_read on public.scoring_anchor;
create policy scoring_anchor_read
  on public.scoring_anchor
  for select
  to public
  using (true);

grant select on public.scoring_anchor to anon, authenticated;
