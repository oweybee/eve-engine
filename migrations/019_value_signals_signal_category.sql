-- 019_value_signals_signal_category.sql
--
-- Adds signal_category to value_signals so the dual-tier classification
-- (Prime / Longshot Edge / Standard) is persisted alongside every detected
-- edge and can be used by the frontend and CLV analysis without re-running
-- the model.
--
-- Classification rules (mirrors categorizeSignal() in modelMetrics.js):
--   Prime        — edge ≥ 5pp AND model probability ≥ 15%   (OUTSIDER_PROB_THRESHOLD)
--   Longshot Edge— edge ≥ 5pp AND model probability <  15%  (speculative / deprioritised)
--   Standard     — edge < 5pp or outside the sweet-spot ceiling of 25pp
--
-- DEFAULT 'Standard' means any row inserted without an explicit value falls
-- back to the least privileged tier, so there is no risk of phantom Primes
-- from legacy rows or a code path that forgets the field.

alter table value_signals
  add column if not exists signal_category text not null default 'Standard'
    check (signal_category in ('Prime', 'Longshot Edge', 'Standard'));

-- Partial index: front-end and alert queries almost always filter on Prime.
create index if not exists idx_vs_prime
  on value_signals (detected_at desc)
  where signal_category = 'Prime';
