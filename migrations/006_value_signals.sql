-- 006_value_signals.sql
-- CLV (closing line value) tracking foundation.
-- Records a historical row for every value signal EVE detects, so closing odds
-- and results can later be joined in to compute CLV.
--
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query → Run)
-- BEFORE the first engine run that writes to value_signals.

create table if not exists value_signals (
  id uuid primary key default gen_random_uuid(),
  match_id uuid references matches(id),
  outcome text not null check (outcome in ('home','draw','away')),
  detected_at timestamptz not null default now(),
  detected_odds numeric(7,3) not null,
  detected_edge numeric(6,4) not null,
  detected_mes int,
  bookmaker text,
  closing_odds numeric(7,3),
  clv numeric(6,4),
  result text check (result in ('win','loss','void','pending')) default 'pending',
  kickoff_at timestamptz
);

create index if not exists idx_vs_match on value_signals(match_id);
create index if not exists idx_vs_detected on value_signals(detected_at desc);
