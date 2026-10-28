-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260629074757, name enable_pg_net. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

CREATE EXTENSION IF NOT EXISTS pg_net SCHEMA extensions;
