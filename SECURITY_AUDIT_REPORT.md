# Security Audit Report — Database Schema, Migrations & Compute Layer

**Date:** 2026-08-02
**Scope:** SQL migrations (`migrations/`), fixture/signal tables holding model output
(`value_signals`, `computed_values`, `recommendations`, `suggested_accas`,
`fixture_predictions`), and `computeValues.js` Supabase client usage.
**Method:** Static review of all 44 files in `migrations/`, cross-checked against
live production state (project `zlbmpeiuhyllxwegtayu` / MaxEdge) via the Supabase
advisors, `pg_policies`, and `list_tables`.

## Summary

Production database state is currently sound: every table checked has row level
security enabled, and the tables holding paid model output (`ML_ENSEMBLE`,
`DIXON_COLES`, etc.) are correctly gated — public write is blocked and read is
tier-limited. The issues below are about the **versioned migration history not
matching production**, not about a live hole in the running system. Left
unaddressed, they're a reproducibility/disaster-recovery risk: rebuilding the
schema from `migrations/` alone would not reproduce the current protections.

---

## 1. Missing `ENABLE ROW LEVEL SECURITY` in migration files (drift from production)

**Severity:** Medium (reproducibility / disaster-recovery risk, not a live exposure)

Four tables are created in `migrations/` without an accompanying
`ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` statement in the same (or any
later) migration file:

| Table | Created in | RLS statement in migrations? | RLS enabled in production? |
|---|---|---|---|
| `team_statistics` | `migrations/027_team_and_referee_stats.sql:15` | No | Yes |
| `referee_stats` | `migrations/027_team_and_referee_stats.sql:37` | No | Yes |
| `team_elo` | `migrations/031_team_elo.sql:20` | No | Yes |
| `inplay_baseline` | `migrations/032_inplay_baseline.sql:13` | No | Yes |

Production currently has RLS enabled on all four (confirmed live), so there is
no active exposure today — but the protection was applied out-of-band (directly
against the database) rather than through a committed migration. `migrations/`
is the only artifact that reproduces the schema for a fresh environment, staging
rebuild, or disaster recovery, and as committed it would **not** enable RLS on
these four tables, defaulting them to the standard Supabase `anon`/`authenticated`
grants with no row-level restriction.

Contrast with `migrations/040_inplay_market_series.sql:52` and
`migrations/041_engine_state.sql:10`, which correctly include the
`ENABLE ROW LEVEL SECURITY` statement alongside `CREATE TABLE` — that's the
pattern the four tables above should follow.

**Remediation:** Add a follow-up migration (e.g.
`migrations/045_backfill_missing_rls.sql`) that brings the migration history in
line with production:

```sql
ALTER TABLE public.team_statistics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referee_stats    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_elo         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inplay_baseline  ENABLE ROW LEVEL SECURITY;
```

## 2. `team_elo` and `inplay_baseline` have RLS enabled with zero policies

**Severity:** Low (informational — flagged by Supabase security advisor
`rls_enabled_no_policy`, not currently a vulnerability)

`team_elo`, `inplay_baseline`, and `engine_state` all have RLS enabled with no
policies defined, so `anon`/`authenticated` get zero rows (default-deny); only
the service-role key (used exclusively by this engine's server-side scripts,
per `lib/supabaseClient.js`) can read/write them. That matches how they're
actually consumed — `lib/elo.js` and `lib/halftimeFeatures.js` read `team_elo`
and `inplay_baseline` server-side only; no frontend/anon-key path touches them.

This is not a bug, but it's indistinguishable from an oversight without a
comment. **Remediation:** add a one-line comment in
`migrations/031_team_elo.sql` and `migrations/032_inplay_baseline.sql` (next to
the `ENABLE ROW LEVEL SECURITY` statement added per §1) noting these tables are
intentionally service-role-only with no public policies, so a future audit
doesn't need to re-derive that from the codebase.

## 3. Stale "not yet applied" header on an already-applied migration

**Severity:** Low (documentation accuracy)

`migrations/034_tiered_premium_access.sql:3` reads:

```
-- ⚠️  STAGED FOR REVIEW — NOT YET APPLIED TO PRODUCTION.  ⚠️
```

This migration has in fact been applied — confirmed live via `pg_policies`:
`tiered_read_value_signals`, `tiered_read_computed_values`,
`tiered_read_recommendations`, `tiered_read_suggested_accas`, and
`paid_read_fixture_predictions` all exist in production exactly as defined in
the file. The stale header risks misleading a future reviewer into believing
the premium tables (which hold `ML_ENSEMBLE`/`DIXON_COLES` model rows) are
still fully public, or into re-running the migration unnecessarily.

**Remediation:** Update the header to reflect applied status and date (the
sibling migrations `035` and `037` already follow this convention, e.g.
`-- APPLIED to production 2026-07-06.`).

---

## Item-by-item results

**1. New tables vs. RLS statements in migrations —** 2 of the 5 migrations that
create new tables (`040`, `041`) correctly include the RLS statement; 3
(`027`, `031`, `032`) do not, though production has been patched to enable RLS
on all of them regardless. See §1.

**2. `ML_ENSEMBLE` / `Dixon-Coles` fixture data (public write vs. read) — PASS.**
Rows with `model_architecture` values `ML_ENSEMBLE`, `DIXON_COLES`, and
`INPLAY_DIXON_COLES` live in `value_signals`, `computed_values`,
`recommendations`, `suggested_accas`, and `fixture_predictions`. All five have
RLS enabled with `SELECT`-only policies for `anon`/`authenticated`
(`migrations/034_tiered_premium_access.sql`, confirmed live), tier-gated via
`current_tier()` with a capped preview for free/anon. No `INSERT`/`UPDATE`/
`DELETE` policy exists for `anon` or `authenticated` on any of the five tables
— writes are default-denied for those roles; only the service-role key (engine
writes) bypasses RLS. Unauthorized public write is blocked; client read access
is preserved.

**3. `computeValues.js` Supabase client guard — PASS.**
`lib/supabaseClient.js:24-38` fails fast only on missing `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` at startup (intentional, by design). Every
downstream query in `computeValues.js` either checks the returned `error` and
throws a wrapped `Error` (e.g. `fetchMatchesForComputation` at
`computeValues.js:108`, `upsertComputedValues` at `computeValues.js:358`) — all
of which are caught by the top-level `main().catch()` at
`computeValues.js:598-601`, which logs and calls `process.exit(1)` rather than
crashing with an unhandled rejection — or soft-fails to an empty `Map`/array on
error (`fetchEloLookup` at `computeValues.js:496`, `fetchStatsLookups` at
`computeValues.js:504-511`). A momentary network drop on any individual query
surfaces as a handled `error`, not a process crash.

---

## Recommendation

No emergency action required — production is currently correctly configured.
Land a follow-up migration for §1/§2 to bring `migrations/` back in sync with
production, and fix the stale header in §3 (of this section)/migration `034`
so the committed schema history is trustworthy on its own.
