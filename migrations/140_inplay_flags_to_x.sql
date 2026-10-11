-- 140 - an in-play flag posts to X at most once per match
--
-- postInplayFlags.js posts the ALERT flags (red card, favourite behind) from
-- the big competitions to X as well as Discord. This is X's own ledger, kept
-- apart from inplay_flag_posts so the two channels claim independently: a
-- flag Discord has posted can still go to X, and an X refusal never touches
-- the Discord row.
--
-- skeleton is the post with names and numbers stripped (lib/xGuard). The
-- poster reads the most recent ones to avoid "substantially similar" posts,
-- which X's automation rules prohibit.
--
-- Service role only: nothing in the browser reads or writes it.

create table if not exists public.inplay_flag_x_posts (
  match_id        uuid not null,
  flag_key        text not null,
  posted_at       timestamptz not null default now(),
  external_msg_id text,
  skeleton        text,
  primary key (match_id, flag_key)
);

comment on table public.inplay_flag_x_posts is
  'Ledger of in-play tracker flags posted to X, one row per (match, flag). Written by eve-engine postInplayFlags.js. Migration 140.';

alter table public.inplay_flag_x_posts enable row level security;
revoke all on public.inplay_flag_x_posts from anon, authenticated;

create index if not exists inplay_flag_x_posts_posted_at on public.inplay_flag_x_posts (posted_at desc);
