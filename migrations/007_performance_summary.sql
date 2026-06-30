-- 007_performance_summary.sql
-- Time-series of model performance snapshots, recomputed each engine run by
-- fetchResults.js from the settled value_signals history.

create table if not exists performance_summary (
  id uuid primary key default gen_random_uuid(),
  calculated_at timestamptz default now(),
  total_signals int,
  settled_signals int,
  wins int,
  losses int,
  win_rate numeric(5,4),
  yield numeric(6,4),
  roi numeric(6,4),
  avg_clv numeric(6,4),
  avg_edge numeric(6,4),
  avg_mes numeric(5,1)
);

-- Row Level Security: read-only for clients (the dashboard reads this);
-- writes restricted to the service role, which bypasses RLS.
alter table performance_summary enable row level security;

drop policy if exists anon_read on performance_summary;
create policy anon_read on performance_summary
  for select to anon, authenticated using (true);
