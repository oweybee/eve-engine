-- 139 - an in-play flag posts to Discord once per match
--
-- postInplayFlags.js reads the /in-play tracker (the site's own /api/inplay,
-- so the flag rules live in one place: eve-frontend lib/inplayTracker) and
-- posts each new flag to the Plus-only #in-play channel. This table is how it
-- knows what it has already posted, across runs.
--
-- The key is (match, flag_key). flag_key is the flag kind plus the side, and
-- for a red card the count, so a second red on the same side is a new post
-- while the same flag re-read on the next poll is not.
--
-- Service role only: nothing in the browser reads or writes it.

create table if not exists public.inplay_flag_posts (
  match_id        uuid not null,
  flag_key        text not null,
  posted_at       timestamptz not null default now(),
  external_msg_id text,
  primary key (match_id, flag_key)
);

comment on table public.inplay_flag_posts is
  'Ledger of in-play tracker flags posted to the Discord #in-play channel, one row per (match, flag). Written by eve-engine postInplayFlags.js. Migration 139.';

alter table public.inplay_flag_posts enable row level security;
revoke all on public.inplay_flag_posts from anon, authenticated;

create index if not exists inplay_flag_posts_posted_at on public.inplay_flag_posts (posted_at);
