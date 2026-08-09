# Security Audit Report — Database Schema, Migrations & Compute Layer

**Date:** 2026-08-09
**Scope:** `migrations/*.sql` (58 files, 002–058), `engine/computeValues.js` (repo root `computeValues.js`), `lib/supabaseClient.js`
**Method:** Static review of every `CREATE TABLE` in the migration history, cross-referenced against every `ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` statement in the same history; manual read of the compute engine's Supabase client usage.

## Summary

| # | Area | Result |
|---|------|--------|
| 1 | New tables — RLS coverage | **7 tables fail** (see below) |
| 2 | `value_signals` (holds `ML_ENSEMBLE` / `DIXON_COLES` rows) | **Fails — no RLS at all** |
| 3 | `computeValues.js` Supabase client guard | **Pass** — no crash risk found |
| 4 | Syntax review of migration files | **Pass** — no defects found |

Two tables in the migration history do this correctly and were used as the reference pattern for the remediation below: `inplay_market_series` (migration 040) and `disagreement_calibration` (migration 054).

---

## Finding 1 (Critical): `value_signals` has no Row Level Security

- **Location:** `migrations/006_value_signals.sql`, lines 9–22 (`create table if not exists value_signals (...)`)
- **Issue:** The table is created with no `ALTER TABLE value_signals ENABLE ROW LEVEL SECURITY` anywhere in the subsequent 52 migrations that touch it (`019`, `020`, `025`, `026`, `028`, `030`, `032`, `033`, `038`, `039`, `048`, `049`, `050`, `055`, `056`, `057`, `058` all add/rename columns or constraints on it, but none enable RLS).
- **Why it matters:** `value_signals` is exactly the table the task asked about — it is where every `model_architecture = 'ML_ENSEMBLE'` and `model_architecture = 'DIXON_COLES'` row lives (allowed values enumerated in the `value_signals_model_architecture_check` constraint added in `migrations/032_inplay_baseline.sql`, lines 25–38). On a Supabase project, a table with RLS disabled is reachable through the PostgREST API by the `anon`/`authenticated` roles with no per-row restriction — i.e. it is fully readable **and writable** by anyone holding the publishable (anon) key, not just the service-role key the engine uses. That means an unauthenticated caller could insert, update, or delete predictions/signals directly, which is worse than a read-only leak: it lets someone forge or corrupt the exact fixture data (ML ensemble and Dixon-Coles signals) the product shows to paying users.
- **Remediation:** Enable RLS and add a read-only policy for public/authenticated roles, leaving writes to the service-role key only (which bypasses RLS by design). This mirrors the pattern already used correctly in `migrations/054_shin_devig_and_disagreement.sql` (lines 147–153) for `disagreement_calibration`:

  ```sql
  alter table value_signals enable row level security;

  drop policy if exists value_signals_read on value_signals;
  create policy value_signals_read
    on value_signals for select
    to anon, authenticated
    using (true);

  -- No insert/update/delete policy is created — only the service-role key
  -- (used by computeValues.js / insertValueSignals) can write, because
  -- service_role bypasses RLS entirely.
  ```

---

## Finding 2 (Critical): Team/referee/ELO reference tables have no RLS

- **Locations:**
  - `migrations/027_team_and_referee_stats.sql` — `team_statistics` (line 15), `referee_stats` (line 37)
  - `migrations/031_team_elo.sql` — `team_elo` (line 20)
  - `migrations/032_inplay_baseline.sql` — `inplay_baseline` (line 13)
- **Issue:** None of these four `CREATE TABLE` statements is followed by an `ENABLE ROW LEVEL SECURITY` anywhere in the migration history (confirmed by grepping every later migration that references these table names — `038`, `048`, `052` — none add RLS).
- **Why it matters:** These are the tables `computeValues.js` reads to build the Dixon-Coles / secondary-market and ELO-based ensemble inputs (`fetchStatsLookups()` at `computeValues.js:718-730`, `fetchEloLookup()` at `computeValues.js:709-715`). `inplay_baseline` freezes the pre-match λ (goal-expectation) values the in-play win-probability model anchors to. With RLS off, these are open to unauthenticated write via the API — someone could poison team stats, ELO ratings, or the frozen in-play baseline that downstream models and signals are computed from, silently corrupting every prediction derived from them.
- **Remediation:** Same pattern as Finding 1 — enable RLS, allow public/authenticated `SELECT`, no write policy:

  ```sql
  alter table team_statistics enable row level security;
  create policy team_statistics_read on team_statistics for select to anon, authenticated using (true);

  alter table referee_stats enable row level security;
  create policy referee_stats_read on referee_stats for select to anon, authenticated using (true);

  alter table team_elo enable row level security;
  create policy team_elo_read on team_elo for select to anon, authenticated using (true);

  alter table inplay_baseline enable row level security;
  create policy inplay_baseline_read on inplay_baseline for select to anon, authenticated using (true);
  ```

---

## Finding 3 (High): `recommendations` and `odds_snapshots` have no RLS

- **Location:** `migrations/002_intelligence_platform.sql` — `recommendations` (line 22), `odds_snapshots` (line 53); extended by `migrations/004_market_tracking.sql`.
- **Issue:** Same gap as above — created, never RLS-enabled.
- **Why it matters:** `recommendations` stores the immutable per-signal CLV record (recommended odds, edge, AI probability) and `odds_snapshots` stores the odds time series used for closing-line-value grading. Both are fixture/pricing "ticker" data in the sense the audit request describes, and both are currently writable by anyone with the anon key.
- **Remediation:**

  ```sql
  alter table recommendations enable row level security;
  create policy recommendations_read on recommendations for select to anon, authenticated using (true);

  alter table odds_snapshots enable row level security;
  create policy odds_snapshots_read on odds_snapshots for select to anon, authenticated using (true);
  ```

---

## What's already correct (reference pattern)

- `migrations/040_inplay_market_series.sql:52-60` — `inplay_market_series` is created, RLS is enabled, and a `for select using (true)` policy is added for public read, with no write policy.
- `migrations/041_engine_state.sql:10` — `engine_state` has RLS enabled (no public read policy at all, correctly, since it's engine-internal state).
- `migrations/054_shin_devig_and_disagreement.sql:129-155` — `disagreement_calibration` is created, RLS enabled, public `select` policy added, and the comment at lines 144-146 explicitly documents the read/write reasoning. This is the template the fixes above follow.

All new tables going forward should follow one of these two shapes: public-read-only (RLS + `select` policy `using (true)`, no write policy) for anything client-facing, or RLS-with-no-policies at all for engine-internal state.

---

## Item 3: `engine/computeValues.js` — Supabase client initialization guard

**Result: Pass.** No crash risk found.

- `lib/supabaseClient.js:24-38` (`getClient()`) fails fast and intentionally: it throws only if `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` are missing at startup, so misconfiguration is caught immediately rather than mid-run. This is the correct guard for that failure mode.
- `computeValues.js:814-815` calls `getClient()` lazily inside `main()` (documented at lines 16-20) specifically so the pure pricing functions (`computeConsensus`/`computeMatch`) remain unit-testable without a live DB connection.
- The Supabase JS client is a stateless HTTP (PostgREST) client — it does not hold a persistent connection that can "drop." A transient network failure surfaces as a per-call `{ data, error }` result or a rejected promise on that one request, not a process crash. Every call site in `computeValues.js` that matters already handles this correctly, e.g.:
  - `fetchMatchesForComputation` (`computeValues.js:121-164`) checks `matchError`/`oddsError` and throws a descriptive error rather than letting `undefined` propagate.
  - `upsertComputedValues`, `insertValueSignals`, `insertSecondarySignals` all check `error` before proceeding.
  - The non-critical secondary/ensemble blocks in `main()` (`computeValues.js:865-880`, `888-938`) are wrapped in `try/catch` specifically so a transient failure there degrades gracefully ("Non-fatal: never lose the 1X2 work") instead of crashing the whole run.
  - `withPool()` (`computeValues.js:797-811`) uses `Promise.allSettled` per batch, so one match's fetch/compute failure can't take down the others.

No missing guard was identified. No changes recommended for this item.

---

## Item 4: Migration file syntax review

**Result: Pass.** All 58 migration files were scanned for structural issues (unbalanced parentheses, unterminated statements). Two files initially flagged by an automated paren-balance check (`035_db_housekeeping.sql`, `054_shin_devig_and_disagreement.sql`) were manually reviewed and are false positives — the imbalance comes from parentheses inside prose comments, not SQL syntax. No actual syntax defects were found.

---

## Remediation priority

1. **`value_signals`** — critical, do first (directly matches the ML_ENSEMBLE/Dixon-Coles concern raised).
2. **`team_statistics`, `referee_stats`, `team_elo`, `inplay_baseline`** — critical, these feed the same models.
3. **`recommendations`, `odds_snapshots`** — high, CLV/pricing history.

All remediation SQL above is additive (`ENABLE ROW LEVEL SECURITY` + a read-only `SELECT` policy) and does not change any existing read behavior for the frontend or the engine (which writes via the service-role key and is unaffected by RLS). Recommend landing it as a new migration (next available number: `059_rls_public_data_tables.sql`) following the exact pattern already established in migration `054`.
