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
