# Security Audit — Database Schema, Migrations & Compute Layer

**Date:** 2026-07-05
**Scope:** `migrations/`, fixture/model-architecture data, `computeValues.js` (Supabase client guard)
**Live database checked:** Supabase project `zlbmpeiuhyllxwegtayu` ("MaxEdge Project"), via `get_advisors`, `list_tables`, and direct `pg_policies`/`pg_class` queries.

## Summary

The **live production database is not currently exposed**: every table in `public` has row level security enabled, and no policy anywhere grants `INSERT`/`UPDATE`/`DELETE`/`ALL` to `anon` or `authenticated`. Tables carrying `ML_ENSEMBLE` / `DIXON_COLES` architecture rows (`value_signals`, `fixture_predictions`) are read-only for public clients — writes only happen through the service-role key, which bypasses RLS by design.

The real issues are **schema drift and hygiene**, not an active hole:

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | 13 tables have RLS/policies applied live but never captured in tracked migrations | Medium (reproducibility) | Fixed — `migrations/034_rls_hardening.sql` |
| 2 | `team_elo` / `inplay_baseline`: RLS enabled, zero policies (Supabase advisor `rls_enabled_no_policy`) | Low (currently deny-all, matches intended backend-only use) | Fixed — explicit `service_role` policy added |
| 3 | `public.set_updated_at()` trigger function has a mutable `search_path` (Supabase advisor `function_search_path_mutable`, WARN) | Low | Fixed — pinned `SET search_path = ''` |
| 4 | `backfill_fixtures.py` hardcoded a production Supabase URL and a placeholder key as `.getenv()` fallbacks, unlike every other script in the repo | Low | Fixed |
| 5 | `computeValues.js` / `lib/supabaseClient.js` Supabase guard | No issue found | Pass |

---

## 1. Migrations vs. new tables — RLS coverage

Every `CREATE TABLE` in `migrations/` was checked for a paired `ENABLE ROW LEVEL SECURITY` statement.

**Only one migration does this correctly:** `migrations/021_match_lineups_stats.sql` enables RLS immediately after each `CREATE TABLE` (`match_lineups`, `match_stats`, `match_predictions_af`).

**None of the following tables have an `ENABLE ROW LEVEL SECURITY` statement anywhere in `migrations/`**, even though they hold public match/odds/prediction data:

- `recommendations`, `odds_snapshots` — `migrations/002_intelligence_platform.sql`
- `value_signals` — `migrations/006_value_signals.sql`
- `performance_summary` — `migrations/007_performance_summary.sql`
- `engine_plan` — `migrations/014_engine_plan.sql`
- `posted_signals` — `migrations/015_posted_signals.sql`
- `team_statistics`, `referee_stats` — `migrations/027_team_and_referee_stats.sql`
- `team_elo` — `migrations/031_team_elo.sql`
- `inplay_baseline` — `migrations/032_inplay_baseline.sql`

Additionally, `computed_values`, `matches`, `odds`, and `leagues`/`teams` are referenced (via `ALTER TABLE`) starting in `migrations/002_intelligence_platform.sql` but their `CREATE TABLE` is not in this repo at all — they predate the tracked migration history.

**Why this matters despite the live DB being safe today:** these `ENABLE ROW LEVEL SECURITY` and policy statements were applied directly against the live database out of band (confirmed via `pg_policies`), not through a tracked migration. If `migrations/` were replayed against a fresh database — a new environment, a disaster-recovery restore, a staging clone — every one of these tables would come up with **RLS disabled and full default grants**, i.e. publicly writable, until someone remembered to re-apply the untracked hardening by hand.

**Remediation:** `migrations/034_rls_hardening.sql` (added in this PR) enables RLS on all 13 tables and recreates the exact read-only policies that already exist in production, so the migration history is idempotent and reproducible. No behavior change on the current database — it only makes the existing security posture explicit and replayable.

## 2. Fixture data tagged `ML_ENSEMBLE` / `Dixon-Coles`

- `lib/dixonColes.js` implements the Dixon-Coles (1997) goals model; results flow into `value_signals.model_architecture = 'DIXON_COLES'` (and `INPLAY_DIXON_COLES` via `computeInplayValues.js`).
- `ensemble/inference.js` computes `ML_ENSEMBLE` rows, also written to `value_signals`.
- `backfill_fixtures.py` writes World Cup backfill rows with `model_architecture: "ML_ENSEMBLE"` into a table called **`fixture_predictions`**, which has **no `CREATE TABLE` in `migrations/` at all** (found by grepping the whole repo — it's schema drift, not a migration oversight).

Checked live (`pg_policies` on `zlbmpeiuhyllxwegtayu`):

- `value_signals`: policy `anon_read` — `SELECT` only, roles `{anon,authenticated}`. No write policy exists.
- `fixture_predictions`: policy `anon_read` — `SELECT` only, roles `{anon,authenticated}`. No write policy exists.

**Conclusion:** both tables are correctly read-only for public/client consumption and protected from unauthorized public writes today. The gap is that `fixture_predictions`'s schema and RLS state live entirely outside version control — nobody can audit or reproduce it from this repo. Recommend adding a proper `CREATE TABLE IF NOT EXISTS fixture_predictions (...)` migration (with RLS + the same read-only policy) as a follow-up so the table is no longer undocumented.

## 3. `computeValues.js` — Supabase client guard

`lib/supabaseClient.js#getClient()` throws synchronously only when `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` are missing at process start — a deliberate fail-fast on misconfiguration, not a runtime crash path. It does not attempt to probe connectivity, so a momentary network blip doesn't happen at `getClient()` time at all.

At the call sites in `computeValues.js`:
- Per-match work runs through `withPool()` using `Promise.allSettled`, so one match's transient Supabase error is caught and logged (`[engine] match error: ...`) without aborting the batch.
- Secondary-market pricing (`lib/secondaryMarkets.js` calls) is explicitly wrapped in `try/catch` so a failure there never loses the primary 1X2 results (see comment at `computeValues.js:536`).
- The top-level `main()` is wrapped in `.catch()` (`computeValues.js:570-573`), so any unhandled error — including a dropped connection during `fetchMatchesForComputation`/`upsertComputedValues` — is caught, logged, and exits with a controlled `process.exit(1)` rather than crashing with an unhandled rejection.

**No issue found.** This is a batch/cron job; failing loudly with a clean log line and a non-zero exit code on a genuine connection failure is correct behavior, not a bug — the scheduler is expected to retry the next cycle. No changes made here.

## 4. `backfill_fixtures.py` — hardcoded fallback credentials pattern

Before this audit, the file read:

```python
SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL", "https://zlbmpeiuhyllxwegtayu.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "your-service-role-key")
```

Every other script in the repo (`ensemble/backfill_competitions.py`, `ensemble/seed_*.py`, `ensemble/train.py`) reads these from the environment and calls `sys.exit(...)` if either is missing. `backfill_fixtures.py` was the one outlier: it hardcoded the production project URL as a default and silently fell back to a non-functional placeholder key instead of failing fast. Neither value is a live secret (the key default is a placeholder, not a real key), but hardcoding a specific production project URL as a script default is bad practice and inconsistent with the rest of the codebase.

**Fixed** to match the established pattern (`os.environ.get(...)` + `sys.exit` guard, no hardcoded fallbacks).

## Live database advisor output (reference)

```
INFO  rls_enabled_no_policy  public.inplay_baseline — RLS enabled, no policies exist
INFO  rls_enabled_no_policy  public.team_elo         — RLS enabled, no policies exist
WARN  function_search_path_mutable  public.set_updated_at — mutable search_path
```

All three addressed in `migrations/034_rls_hardening.sql`.
