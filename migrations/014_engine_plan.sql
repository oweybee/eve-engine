-- engine_plan: daily polling schedule written by planDay.js, read by ingestOdds.js
create table if not exists engine_plan (
  date             date primary key,
  fixture_ids      integer[] not null default '{}',
  interval_minutes integer,
  next_run_at      timestamptz,
  runs_planned     integer not null default 0,
  runs_completed   integer not null default 0,
  created_at       timestamptz not null default now()
);

-- Row Level Security: public-readable schedule; writes restricted to the
-- service role (planDay.js / ingestOdds.js), which bypasses RLS.
alter table engine_plan enable row level security;

drop policy if exists "public read engine_plan" on engine_plan;
create policy "public read engine_plan" on engine_plan
  for select to public using (true);
