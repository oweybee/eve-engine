-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260624192019, name add_engine_plan_public_read_policy. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

CREATE POLICY "public read engine_plan" ON engine_plan FOR SELECT USING (true);
