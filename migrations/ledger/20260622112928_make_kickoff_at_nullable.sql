-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260622112928, name make_kickoff_at_nullable. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

ALTER TABLE matches ALTER COLUMN kickoff_at DROP NOT NULL;
