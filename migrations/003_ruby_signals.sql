-- ===========================================================================
-- Max Edge — Ruby premium signal layer + signal tiers
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- Ruby = edge >= 8% AND model probability >= 60% AND value_score >= 8.0
--        (the intersection of value and confidence — deliberately scarce)
-- Tiers: STANDARD (edge>=3%) < STRONG (edge>=5% & prob>=55%) < RUBY
-- ===========================================================================

alter table computed_values add column if not exists home_value_score numeric;
alter table computed_values add column if not exists draw_value_score numeric;
alter table computed_values add column if not exists away_value_score numeric;

alter table computed_values add column if not exists home_ruby boolean default false;
alter table computed_values add column if not exists draw_ruby boolean default false;
alter table computed_values add column if not exists away_ruby boolean default false;

alter table computed_values add column if not exists signal_tier text;  -- 'RUBY'|'STRONG'|'STANDARD'|null

create index if not exists idx_cv_signal_tier on computed_values(signal_tier);
