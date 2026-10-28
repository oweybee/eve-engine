-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261016170532, name predictor_winner_nicks. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

alter table public.predictor_rounds add column if not exists winner_nicks jsonb not null default '{}'::jsonb;
comment on column public.predictor_rounds.winner_nicks is 'Winners'' server nicknames before the trophy was added (discord_user_id -> nick or null), so the next round can put them back.';
