-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260928144223, name posted_signals_skeleton. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- The X channel refuses a post whose SHAPE has gone out recently, which is the
-- pattern X's automation rules action accounts for ("duplicative or
-- substantially similar posts"). `message_hash` cannot serve: it catches an
-- identical post, and a templated poster never emits one — it emits the same
-- sentence with a different club and a different price.
--
-- So the shape is stored alongside the hash. Nullable and with no default: every
-- existing row, and every Telegram row, leaves it NULL and nothing reads it for
-- those channels.
alter table public.posted_signals
  add column if not exists skeleton text;

comment on column public.posted_signals.skeleton is
  'Structural shape of the posted text (numbers, clubs and URLs replaced), for the X channel''s substantially-similar guard. NULL for channels that do not use it.';

create index if not exists idx_posted_signals_channel_posted_at
  on public.posted_signals (channel, posted_at desc);

