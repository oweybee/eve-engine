-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260819204252, name vf_export_drop. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

revoke all on vf_export from anon;
drop view if exists vf_export;
