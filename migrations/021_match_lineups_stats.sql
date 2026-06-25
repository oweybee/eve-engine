-- match_lineups: confirmed and predicted starting XIs
create table if not exists public.match_lineups (
  id          bigint generated always as identity primary key,
  fixture_id  text not null,
  team_side   text not null check (team_side in ('home','away')),
  formation   text,
  players     jsonb not null default '[]',
  is_confirmed boolean not null default false,
  fetched_at  timestamptz not null default now(),
  constraint match_lineups_fixture_side_uq unique (fixture_id, team_side)
);
alter table public.match_lineups enable row level security;

-- match_stats: post-match statistics
create table if not exists public.match_stats (
  id          bigint generated always as identity primary key,
  fixture_id  text not null,
  team_side   text not null check (team_side in ('home','away')),
  stats       jsonb not null default '[]',
  fetched_at  timestamptz not null default now(),
  constraint match_stats_fixture_side_uq unique (fixture_id, team_side)
);
alter table public.match_stats enable row level security;

-- match_predictions_af: AI predictions from API-Football
create table if not exists public.match_predictions_af (
  fixture_id    text primary key,
  home_win_pct  numeric,
  draw_pct      numeric,
  away_win_pct  numeric,
  advice        text,
  home_form     text,
  away_form     text,
  fetched_at    timestamptz not null default now()
);
alter table public.match_predictions_af enable row level security;
