# Security Audit Report — EVE Engine

**Date:** 2026-06-30  
**Scope:** SQL migrations, Supabase RLS posture, fixture table access controls, `computeValues.js` compute layer  
**Project:** MaxEdge Project (`zlbmpeiuhyllxwegtayu`)

---

## Executive Summary

Four issues were identified ranging from a critical runtime crash bug to medium and low severity gaps. All 26 public-schema tables have RLS enabled on the live database. ML_ENSEMBLE and Dixon-Coles fixture data is correctly protected against public writes. Three specific issues require schema fixes; one requires a code-level guard in the compute engine.

---

## Issue 1 — CRITICAL: `signal_category = 'PriceMove'` violates live CHECK constraint

**Location:** `computeValues.js:349` / `migrations/019_value_signals_signal_category.sql`

### Description

Migration `019_value_signals_signal_category.sql` constrains `value_signals.signal_category` to:

```sql
CHECK (signal_category = ANY (ARRAY['Prime'::text, 'Longshot Edge'::text, 'Standard'::text]))
```

`computeValues.js:insertValueSignals()` assigns a fourth value not present in that array:

```javascript
// computeValues.js line 349
signal_category = 'PriceMove';
```

When any batch of signals contains a `PriceMove` row, the entire `INSERT` is rejected by PostgREST with a `check constraint violation`. This propagates through:

```
insertValueSignals → throw new Error() → main().catch → process.exit(1)
```

Every engine run that detects a price movement will crash completely, dropping all signals for that cycle.

### Remediation

**Option A — extend the constraint (recommended):** Add a new migration that widens the allowed values:

```sql
-- migrations/030_signal_category_pricemove.sql
ALTER TABLE value_signals DROP CONSTRAINT IF EXISTS value_signals_signal_category_check;
ALTER TABLE value_signals ADD CONSTRAINT value_signals_signal_category_check
  CHECK (signal_category = ANY (ARRAY[
    'Prime'::text,
    'Longshot Edge'::text,
    'Standard'::text,
    'PriceMove'::text
  ]));
```

**Option B — normalise in code:** Map `'PriceMove'` to `'Standard'` inside `insertValueSignals()` until the constraint is widened. This loses the category signal but prevents crashes immediately.

---

## Issue 2 — HIGH: Three tables have RLS enabled but no policies

**Location:** Live database (confirmed by Supabase security advisor)  
**Affected tables:** `public.referee_stats`, `public.team_statistics`, `public.suggested_accas`

### Description

All three tables have `rowsecurity = true` but zero RLS policies. PostgreSQL's default when RLS is enabled without any policies is to **deny all access to non-superuser roles**. The Supabase service role bypasses RLS (so the engine can still write/read), but any frontend client using the `anon` or `authenticated` roles receives an empty result set with no error — a silent data blackout.

- `referee_stats` and `team_statistics` are read by `computeValues.js:fetchStatsLookups()` via the service role, so engine reads work. But no frontend/API consumer can read them.
- `suggested_accas` has no write path defined in any migration either; its data is inaccessible to all non-engine consumers.

The migrations that create `team_statistics` and `referee_stats` (`027_team_and_referee_stats.sql`) do not include `ENABLE ROW LEVEL SECURITY` or any policy definition.

### Remediation

Add read-only policies consistent with the existing pattern for similar reference tables:

```sql
-- For referee_stats and team_statistics (public reference data)
ALTER TABLE public.referee_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read" ON public.referee_stats
  FOR SELECT TO anon, authenticated USING (true);

ALTER TABLE public.team_statistics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read" ON public.team_statistics
  FOR SELECT TO anon, authenticated USING (true);

-- For suggested_accas (confirm intended audience first)
-- If client-readable:
CREATE POLICY "anon_read" ON public.suggested_accas
  FOR SELECT TO anon, authenticated USING (true);
-- If engine-write-only (no client reads needed):
CREATE POLICY "service_role_only" ON public.suggested_accas
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

---

## Issue 3 — MEDIUM: Migration files create tables without `ENABLE ROW LEVEL SECURITY`

**Location:** Multiple migration files (see table below)

### Description

The live database has RLS enabled on all 26 tables, which is correct. However, the following migration files create tables **without** the `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` statement. A fresh deployment from these migrations alone would leave those tables without RLS, fully open to the public role.

| Migration | Table(s) Created | RLS Statement Present |
|-----------|------------------|-----------------------|
| `002_intelligence_platform.sql` | `recommendations`, `odds_snapshots` | No |
| `007_performance_summary.sql` | `performance_summary` | No |
| `014_engine_plan.sql` | `engine_plan` | No |
| `015_posted_signals.sql` | `posted_signals` | No |
| `027_team_and_referee_stats.sql` | `team_statistics`, `referee_stats` | No |

Migration `021_match_lineups_stats.sql` is the only migration that correctly pairs `CREATE TABLE` with `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and serves as the reference pattern.

### Remediation

Add a consolidating migration that re-enables RLS on all affected tables and is safe to re-run against the live database (all statements are idempotent):

```sql
-- migrations/030_backfill_rls_enable.sql (or merge into 030_signal_category_pricemove.sql)

ALTER TABLE public.recommendations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.odds_snapshots        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performance_summary   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engine_plan           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posted_signals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_statistics       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referee_stats         ENABLE ROW LEVEL SECURITY;
```

Also update each originating migration file to include the `ENABLE ROW LEVEL SECURITY` statement directly after the `CREATE TABLE`, so future re-deployments are self-contained.

---

## Issue 4 — LOW: No transient-error resilience in primary compute path

**Location:** `computeValues.js:fetchMatchesForComputation()`, `upsertComputedValues()`, `insertValueSignals()`; `lib/supabaseClient.js`

### Description

The Supabase client is correctly initialised as a singleton and will throw early if `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` are absent. However, there is no retry logic for transient network failures during the primary compute path:

```javascript
// Any of these will throw on a network blip → process.exit(1)
const matches = await fetchMatchesForComputation(supabase);
await upsertComputedValues(supabase, computedRows);
await insertValueSignals(supabase, valueRows);
```

By contrast, the secondary-markets path **is** protected:

```javascript
try {
  // ... secondary market calls
} catch (err) {
  console.error('[secondary] pricing failed (1X2 unaffected):', err.message);
}
```

A momentary Supabase availability blip (~1–2 seconds) will crash the entire engine run and abort the GitHub Actions job, requiring a manual re-run.

Note: `getClient()` itself is safe — `_client` is cached at module scope, so re-entrancy is not an issue. The gap is at the query layer, not the client-init layer.

### Remediation

Add a lightweight retry wrapper around transient-error-prone operations:

```javascript
async function withRetry(fn, label, retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`[engine] ${label} attempt ${attempt} failed, retrying in ${delayMs}ms:`, err.message);
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
}

// Usage:
const matches = await withRetry(
  () => fetchMatchesForComputation(supabase),
  'fetchMatchesForComputation'
);
```

Apply the same pattern to `upsertComputedValues` and `insertValueSignals`.

---

## Passing Checks

| Check | Result |
|-------|--------|
| All 26 `public` tables have RLS enabled in live DB | **PASS** |
| `computed_values` (holds ML_ENSEMBLE / DIXON_COLES rows) — public SELECT only, no public write | **PASS** |
| `value_signals` (holds all model signals) — anon/authenticated SELECT only, no public write | **PASS** |
| `model_architecture` CHECK constraint covers `DIXON_COLES` and `ML_ENSEMBLE` on both `computed_values` and `value_signals` | **PASS** |
| `posted_signals`, `fixture_mapping`, `watchlist`, `team_stats` — service_role ALL, no public access | **PASS** |
| `getClient()` throws early on missing env vars; singleton pattern prevents double-init | **PASS** |
| `auth: { persistSession: false, autoRefreshToken: false }` correct for service-role use | **PASS** |
| Secondary-market compute errors are non-fatal (wrapped in try/catch) | **PASS** |
| Seed scripts use `SUPABASE_SERVICE_ROLE_KEY` server-side; no anon key exposure in committed code | **PASS** |

---

## Remediation Priority

| # | Severity | Action | Effort |
|---|----------|--------|--------|
| 1 | CRITICAL | Extend `signal_category` CHECK to include `'PriceMove'` (new migration) | ~5 min |
| 2 | HIGH | Add read policies on `referee_stats`, `team_statistics`, `suggested_accas` | ~10 min |
| 3 | MEDIUM | Backfill `ENABLE ROW LEVEL SECURITY` in affected migrations | ~15 min |
| 4 | LOW | Add `withRetry()` wrapper in `computeValues.js` primary path | ~30 min |
