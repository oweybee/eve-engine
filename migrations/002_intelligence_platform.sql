-- ===========================================================================
-- Max Edge — Intelligence Platform migration (Features #1–#8)
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- computed_values: confidence, consensus, score, EV, explainability
-- (Features #2 #3 #4 #5 #8)
-- ---------------------------------------------------------------------------
alter table computed_values add column if not exists confidence_score int;
alter table computed_values add column if not exists confidence_tier  text;
alter table computed_values add column if not exists max_edge_score   int;
alter table computed_values add column if not exists best_outcome     text;
alter table computed_values add column if not exists ev_per_unit      numeric;
alter table computed_values add column if not exists consensus        jsonb;
alter table computed_values add column if not exists explain          jsonb;

-- ---------------------------------------------------------------------------
-- recommendations: one immutable row per signal at the moment we flag it
-- (Feature #1 CLV — the anchor we measure closing line value against)
-- ---------------------------------------------------------------------------
create table if not exists recommendations (
  id                       uuid primary key default gen_random_uuid(),
  match_id                 uuid references matches(id),
  selection                text not null,          -- 'home'|'draw'|'away'|'over'|'under'
  recommendation_timestamp timestamptz not null default now(),
  recommended_odds         numeric not null,
  bookmaker                text,
  edge_at_signal           numeric,
  ai_probability           numeric,
  confidence_score         int,
  max_edge_score           int,
  league                   text,
  edge_bucket              text,                    -- '0-2','2-4','4-6','6-10','10+'
  -- captured later as the line develops:
  current_odds             numeric,
  pre_kickoff_odds         numeric,
  closing_odds             numeric,
  clv_pct                  numeric,                 -- ((rec - closing)/closing)*100
  settled                  boolean default false,
  won                      boolean,                 -- result, once known
  unique (match_id, selection, recommendation_timestamp)
);
create index if not exists idx_recs_match     on recommendations(match_id, selection);
create index if not exists idx_recs_league     on recommendations(league);
create index if not exists idx_recs_bookmaker  on recommendations(bookmaker);
create index if not exists idx_recs_bucket     on recommendations(edge_bucket);

-- ---------------------------------------------------------------------------
-- odds_snapshots: time-series of prices for market-movement + closing line
-- (Features #1 CLV, #7 Movement)
-- ---------------------------------------------------------------------------
create table if not exists odds_snapshots (
  id            bigserial primary key,
  match_id      uuid references matches(id),
  selection     text not null,
  bookmaker     text not null,
  odds          numeric not null,
  snapshot_type text not null default 'current',   -- 'open'|'signal'|'current'|'closing'
  captured_at   timestamptz not null default now()
);
create index if not exists idx_snap_match on odds_snapshots(match_id, selection, captured_at desc);
create index if not exists idx_snap_type  on odds_snapshots(match_id, snapshot_type);

-- ---------------------------------------------------------------------------
-- Row Level Security: both tables are read-only reference data for clients.
-- SELECT for anon + authenticated; writes restricted to the service role
-- (the engine), which bypasses RLS. Without these, the frontend silently
-- receives empty result sets once RLS is enabled.
-- ---------------------------------------------------------------------------
alter table recommendations enable row level security;
alter table odds_snapshots  enable row level security;

drop policy if exists anon_read on recommendations;
create policy anon_read on recommendations
  for select to anon, authenticated using (true);

drop policy if exists anon_read on odds_snapshots;
create policy anon_read on odds_snapshots
  for select to anon, authenticated using (true);
