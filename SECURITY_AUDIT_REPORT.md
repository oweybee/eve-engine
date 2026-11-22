# Security Audit Report — schemas, migrations, compute layer

## Re-audit 2026-11-22

Scope: `migrations/*.sql` (190 files) and `migrations/ledger/*.sql` (128 files), the live `MaxEdge Project` database (read-only catalog queries and Supabase security advisors), `computeValues.js`, `lib/supabaseClient.js`. The task names `engine/computeValues.js`; the file is at the repo root.

**No live exposure found.** No `public` table has RLS off. `anon` has no INSERT/UPDATE/DELETE grant on any `public` table or view. `authenticated` can write only to `bets`, `bankroll_transactions`, `preferences`, `user_bookmakers` and `telegram_links`, and every one of those policies is scoped to `auth.uid() = user_id`.

The open items below are repo and code hygiene. All of them were already reported in draft PR #200 (1 Nov) and none has been fixed yet.

| # | Severity | Issue | Location | Status |
|---|----------|-------|----------|--------|
| 1 | Medium (repo drift) | 16 live tables have no `ENABLE ROW LEVEL SECURITY` in any migration file | see 1 | open since 2026-10-11 |
| 2 | Low | `{ error }` ignored on Supabase calls | `computeValues.js:1068`, `:1074`, `:1149`, `:1159` | open since 2026-10-11 |
| 3 | Low | `band_calibration_service_only` policy targets role `public` with `using (true)` | live DB, `band_calibration` | open since 2026-10-18 |
| 4 | Info | `rls_auto_enable()` event trigger exists live but is not defined in the repo | live DB | new note |

### Passed

- **New tables since the last audit (migrations 193–202).** `team_follows`, `lineup_alert_state` and `lineup_dm_log` (`197_lineup_alerts.sql:29,41,59`) each enable RLS and have own-row read policies. `prime_curve_points` (196) is a materialized view, so RLS does not apply to it. It is SELECT-only for `anon`/`authenticated` and holds only settled, ungated history, so the advisor's `materialized_view_in_api` warning is expected here.
- **`ML_ENSEMBLE` / Dixon-Coles rows.** There are 1,321 `ML_ENSEMBLE` rows in `fixture_predictions`, which has RLS on and a single SELECT policy (`paid_read_fixture_predictions`, authenticated). `value_signals` has 826 `DIXON_COLES` rows and 2,183 `INPLAY_DIXON_COLES` rows; it has RLS on and only SELECT policies for `anon`/`authenticated`. Neither table gives `anon` or `authenticated` a write grant. Reads work for clients and public writes are blocked.
- **`computeValues.js` client guard.** `lib/supabaseClient.js` checks `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, throws a clear error if either is missing, and caches a singleton. `main()` loads it lazily (`computeValues.js:1180`). The run is wrapped in `.catch(... process.exit(1))` (`:1355-1363`), so an error ends in a logged exit, not an unhandled rejection. Errors in individual matches are kept separate by `Promise.allSettled` (`withPool`, `:1170`). supabase-js returns network failures as `{ error }` rather than throwing, so a short connection drop cannot crash the runtime. `node --check computeValues.js` passes.

### 1. Missing `ENABLE ROW LEVEL SECURITY` in migrations

Live state: each table below has RLS on, most likely through the `rls_auto_enable()` event trigger (see 4). If the database is rebuilt from the repo (branch DB, staging, disaster recovery), these tables are created with RLS off.

From the earlier report, still open: `recommendations`, `odds_snapshots`, `value_signals`, `performance_summary`, `engine_plan`, `posted_signals`, `team_elo`, `inplay_baseline`, `paper_models`, `mx_team_match`. (`team_statistics` and `referee_stats` are now covered by files in `migrations/ledger/`.)

Created only in `migrations/ledger/` and still live: `team_stats_cache`, `fixture_mapping`, `match_predictions`, `lineups`, `research_team_ids`, `research_dc_global`.

Remediation: add one idempotent migration. Enabling RLS on a table where it is already on does nothing, so this is safe to apply to production.

```sql
-- 203_rls_backfill.sql
do $$
declare t text;
begin
  foreach t in array array[
    'recommendations','odds_snapshots','value_signals','performance_summary',
    'engine_plan','posted_signals','team_elo','inplay_baseline','paper_models',
    'mx_team_match','team_stats_cache','fixture_mapping','match_predictions',
    'lineups','research_team_ids','research_dc_global']
  loop
    execute format('alter table if exists public.%I enable row level security', t);
  end loop;
end $$;
```

### 2. Ignored Supabase errors in `computeValues.js`

- `fetchStatsLookups` (`:1068`, `:1074`): if the `team_statistics` or `referee_stats` read fails, the lookup maps come back empty and the cycle prices matches with no team or referee stats, without logging anything.
- `updateBetOfDay` (`:1149`, `:1159`): if the reset succeeds and the set fails, there is no bet of the day.

Remediation: destructure `error` and throw, as `fetchMatchesForComputation` and `fetchEloLookup` already do:

```js
const { data: teamStats, error } = await supabase.from('team_statistics').select('*');
if (error) throw new Error(`fetchStatsLookups[team_statistics]: ${error.message}`);
```

### 3. `band_calibration_service_only` targets `public`

The policy is `FOR ALL TO public USING (true) WITH CHECK (true)`. It cannot be exploited today because only `postgres` and `service_role` have table grants. But if a future grant gave `anon` or `authenticated` write access, this policy would let them write to the whole table.

```sql
alter policy band_calibration_service_only on public.band_calibration to service_role;
```

### 4. `rls_auto_enable()` is not in the repo

`migrations/ledger/20260620094315_revoke_execute_rls_auto_enable_from_public_roles.sql` revokes EXECUTE on this function, but no file creates the function or its event trigger. That trigger is the only thing that turns RLS on for the tables in item 1. Capture it with `pg_get_functiondef('public.rls_auto_enable'::regproc)` and the matching `pg_event_trigger` row, and commit both as a migration.

### Not in scope / unchanged

The Supabase advisor still lists 33 anon-executable and 46 authenticated-executable `SECURITY DEFINER` RPCs. These are the tier-gated read RPCs. The new ones checked this run (`clear_lineup_dm_block`, `my_team_follows`, `export_my_data`) are not executable by `anon` and filter on `auth.uid()`. Four functions have a mutable `search_path` (`league_season_start`, `pms_starter_from_lineup`, `pms_is_sub_from_lineup`, `lineups_resync_is_sub`). Fix with `alter function ... set search_path = public, pg_temp`.

---

## Earlier audit (2026-10-28)

Scope: `migrations/*.sql` (178 files), live Supabase project `MaxEdge Project` (read-only catalog query), `computeValues.js`, `lib/supabaseClient.js`.
Note: the task referenced `engine/computeValues.js`; the file lives at repo root `computeValues.js`.

## Summary

| # | Severity | Issue | Location |
|---|----------|-------|----------|
| 1 | Medium (repo drift) | 12 tables have no `ENABLE ROW LEVEL SECURITY` in any migration | see below |
| 2 | Low | Unchecked Supabase `{ error }` results in compute helpers | `computeValues.js:1066-1077`, `1148-1160` |

**No live exposure was found.** Every one of the 12 tables has RLS enabled and correct policies in the live database, and `anon` holds no INSERT/UPDATE/DELETE grant on any of them. The RLS state was applied out-of-band and is not reproducible from the repo.

## 1. Missing `ENABLE ROW LEVEL SECURITY` in migrations

Searched every `CREATE TABLE` across all migrations for a matching `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` (any later migration counted). No table is dropped or has RLS disabled. These have none:

| Table | Created in | Live RLS | Live policy |
|---|---|---|---|
| recommendations | 002_intelligence_platform.sql | on | tiered_read (SELECT anon/authenticated) |
| odds_snapshots | 002_intelligence_platform.sql | on | tiered_read (SELECT) |
| value_signals | 006_value_signals.sql | on | tiered_read + gating policies (SELECT) |
| performance_summary | 007_performance_summary.sql | on | anon_read (SELECT) |
| engine_plan | 014_engine_plan.sql | on | public read (SELECT) |
| posted_signals | 015_posted_signals.sql | on | service_role only |
| team_statistics | 027_team_and_referee_stats.sql | on | anon_read (SELECT) |
| referee_stats | 027_team_and_referee_stats.sql | on | anon_read (SELECT) |
| team_elo | 031_team_elo.sql | on | service_role only |
| inplay_baseline | 032_inplay_baseline.sql | on | service_role only |
| paper_models | 050_paper_trade_harness.sql | on | service_role only |
| mx_team_match | 051_paper_trade_writer.sql | on | service_role only |

Risk: policies exist in migrations for the first three, but a fresh environment rebuilt from `migrations/` (staging, branch DB, disaster recovery) would leave all 12 with RLS off. On Supabase that makes them readable and writable by `anon` through PostgREST by default.

Remediation: add an idempotent migration (e.g. `192_rls_backfill.sql`):

```sql
alter table public.recommendations      enable row level security;
alter table public.odds_snapshots       enable row level security;
alter table public.value_signals        enable row level security;
alter table public.performance_summary  enable row level security;
alter table public.engine_plan          enable row level security;
alter table public.posted_signals       enable row level security;
alter table public.team_statistics      enable row level security;
alter table public.referee_stats        enable row level security;
alter table public.team_elo             enable row level security;
alter table public.inplay_baseline      enable row level security;
alter table public.paper_models         enable row level security;
alter table public.mx_team_match        enable row level security;
```

Also capture the live policies for the 9 tables whose policies are not in the repo (all except recommendations, odds_snapshots, value_signals). Running `ENABLE` on an already-enabled table is a no-op, so this is safe to apply to production.

## 2. `ML_ENSEMBLE` / `Dixon-Coles` rows

These appear as `model_architecture` values (CHECK constraints in migrations 022, 023, 025, 028, 030, 032, 038, 039, 055) on `computed_values` and `value_signals`, and as methodology text elsewhere. Live check: both tables have RLS on, SELECT-only policies for `anon`/`authenticated`, and `anon` has no INSERT/UPDATE/DELETE privilege. Writes happen via the service-role client. **Pass**: public reads preserved, public writes blocked.

## 3. `computeValues.js` client guard

- Client creation is in `lib/supabaseClient.js`; it throws a clear error if `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` is missing (fail fast), and caches a singleton. `main()` loads it lazily and the call chain ends in `.catch(... process.exit(1))` (`computeValues.js` tail), so a failure produces a logged fatal exit rather than an unhandled rejection. Per-match errors are isolated via `Promise.allSettled` (`withPool`). **Pass.**
- Gap (Low): some helpers ignore the `{ error }` returned by supabase-js, so a dropped connection degrades silently rather than crashing:
  - `fetchStatsLookups` (lines ~1066, ~1074): on error `teamStats`/`data` is null, the maps come back empty, and the cycle proceeds with no team/referee stats.
  - `updateBetOfDay` (lines ~1149, ~1159): the reset of `is_bet_of_day` and the set of the new value are both unchecked; a failure between them leaves no bet of the day.

  Remediation: destructure `error` in each call and log it, or throw for the stats fetches so the cycle aborts instead of pricing without data (as `fetchMatchesForComputation` and `fetchEloLookup` already do).

## Not checked

Only the 12 tables above plus `computed_values`/`matches` were queried live. Tables that already have RLS statements in migrations were not re-verified against the live database.
