# Security Audit Report — schemas, migrations, compute layer

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

---

## Addendum — re-audit 2026-11-01

Live check (MaxEdge Project, `public` schema): **no table has RLS disabled and `anon` holds no INSERT/UPDATE/DELETE on any table.** No live exposure.

### A. Findings 1 and 2 above are still open
No migration after 191 adds the RLS backfill, and `computeValues.js` `fetchStatsLookups` (~1068, ~1074) and `updateBetOfDay` (~1149, ~1159) still ignore the `{ error }` result.

### B. Additional repo-drift: ledger migrations (added after the first audit)
`migrations/ledger/` (backfilled in #197) creates 17 more tables with no `ENABLE ROW LEVEL SECURITY` anywhere in the repo. All are RLS-on in the live database; a rebuild from the repo would leave them open to `anon` via PostgREST.

| Table | Created in (`migrations/ledger/`) |
|---|---|
| team_stats_cache | 20260619164631_014_ml_ensemble_columns.sql |
| edge_signals | 20260625103414_create_edge_signals.sql |
| fixture_mapping | 20260625115327_create_fixture_mapping.sql |
| match_predictions | 20260625115329_create_match_predictions.sql |
| team_stats | 20260625115332_create_team_stats.sql |
| lineups | 20260625115545_create_lineups.sql |
| research_team_ids, research_match_ratings | 20260805170742_research_pi_ratings_layer.sql |
| research_team_match, research_rolling | 20260805171110_research_rolling_form.sql |
| research_model_probs | 20260805171310_research_model_probs_tbl.sql |
| research_dc_params, research_dc_global | 20260805174014_research_dc_mle_fitter.sql |
| research_dc_preds | 20260805174458_research_dc_predictions.sql |
| research_disc_tm | 20260805174654_research_corners_cards.sql |
| research_disc_roll, research_ref_roll | 20260805174717_research_disc_model.sql |

Caveat: detection is a static scan for `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`; a few may be covered by dynamic SQL (e.g. `20260630160855_rls_policies_reference_tables.sql`). Confirm against the live catalog before shipping.

Remediation: extend the proposed `192_rls_backfill.sql` with `alter table public.<t> enable row level security;` for each table above (no-op where already enabled), and add `service_role`-only policies for the `research_*` tables.
