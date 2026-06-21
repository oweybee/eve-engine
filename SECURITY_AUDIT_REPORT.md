# Security Audit Report — EVE Engine

**Date:** 2026-06-21  
**Scope:** SQL migrations, RLS policies, fixture data, `computeValues.js` compute layer  
**Project:** MaxEdge / `zlbmpeiuhyllxwegtayu`

---

## Summary

| Severity | Count |
|----------|-------|
| High     | 2     |
| Medium   | 1     |
| Low      | 1     |

Four issues were identified. No issues found with ML_ENSEMBLE or Dixon-Coles fixture data access controls (see §5).

---

## Issue 1 — HIGH: Migration files create tables without `ENABLE ROW LEVEL SECURITY`

**Files:**
- `migrations/002_intelligence_platform.sql` — creates `recommendations`, `odds_snapshots`
- `migrations/006_value_signals.sql` — creates `value_signals`
- `migrations/007_performance_summary.sql` — creates `performance_summary`

**Description:**  
Each of these migrations runs a `CREATE TABLE IF NOT EXISTS ...` statement but never issues `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`. The live Supabase project has RLS enabled on all four tables (confirmed via `pg_tables`), meaning RLS was applied out-of-band after the fact. However, the migration files are the durable, reproducible source of truth. Any fresh deployment, branch reset, or CI seed that re-runs these migrations will leave the four tables **world-readable and world-writable** via the anon key until someone manually enables RLS.

This is particularly dangerous for `recommendations` and `value_signals`, which contain proprietary signal data that should never be publicly writable.

**Remediation:**  
Add `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` immediately after each `CREATE TABLE` block in the affected migrations, and add the corresponding read policies inline.

```sql
-- 002_intelligence_platform.sql  (add after each CREATE TABLE)
ALTER TABLE recommendations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE odds_snapshots    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read" ON recommendations
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "anon_read" ON odds_snapshots
  FOR SELECT TO anon, authenticated USING (true);

-- 006_value_signals.sql  (add after CREATE TABLE)
ALTER TABLE value_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read" ON value_signals
  FOR SELECT TO anon, authenticated USING (true);

-- 007_performance_summary.sql  (add after CREATE TABLE)
ALTER TABLE performance_summary ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read" ON performance_summary
  FOR SELECT TO anon, authenticated USING (true);
```

---

## Issue 2 — HIGH: `watchlist` table permits unauthenticated writes (`anon_all`)

**Location:** Supabase RLS policy — `pg_policies`

**Description:**  
The `watchlist` table has a single policy named `anon_all` with `cmd = ALL` granted to both `anon` and `authenticated` roles. This means any unauthenticated API caller holding the public anon key can INSERT, UPDATE, and DELETE rows in the watchlist — no login required.

```sql
-- Current (insecure):
CREATE POLICY "anon_all" ON watchlist
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
```

If `watchlist` is intended as a per-user feature, write operations must be scoped to `authenticated` only and rows should be constrained to the calling user's ID.

**Remediation:**  
Drop the permissive `anon_all` policy and replace it with separated read/write policies:

```sql
-- Drop the overly-permissive policy
DROP POLICY "anon_all" ON watchlist;

-- Unauthenticated clients may read (optional — remove if not needed)
CREATE POLICY "anon_read" ON watchlist
  FOR SELECT TO anon, authenticated USING (true);

-- Only authenticated users may write their own rows
CREATE POLICY "auth_write_own" ON watchlist
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

Apply this as a new numbered migration (e.g. `migrations/014_watchlist_rls.sql`).

---

## Issue 3 — MEDIUM: `getClient()` in `computeValues.js` has no null-guard for `createClient`

**File:** `computeValues.js` lines 22–27, 95–100

**Description:**  
The module-level import wraps the `require` in a try/catch and sets `createClient = null` on failure:

```js
let createClient;
try {
  ({ createClient } = require('@supabase/supabase-js'));
} catch (_) {
  createClient = null;    // ← silently swallowed
}
```

However, `getClient()` only guards against missing env vars; it never checks whether `createClient` itself is callable:

```js
function getClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  }
  return createClient(SUPABASE_URL, SUPABASE_KEY);  // TypeError if null
}
```

If the package is absent or fails to load (e.g. a corrupt `node_modules`, a deployment packaging error, or a transient native module fault), the engine crashes with an opaque `TypeError: createClient is not a function` deep inside `run()`, making the root cause difficult to diagnose from logs.

**Remediation:**  
Add an explicit null-check in `getClient()`:

```js
function getClient() {
  if (!createClient) {
    throw new Error('@supabase/supabase-js failed to load — check node_modules');
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  }
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}
```

---

## Issue 4 — LOW: Hard-coded Supabase project URL in `backfill_fixtures.py`

**File:** `backfill_fixtures.py` line 8

**Description:**  
The script uses a hard-coded project URL as the default fallback:

```python
SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL", "https://zlbmpeiuhyllxwegtayu.supabase.co")
```

Embedding the project reference ID in source code leaks the database endpoint. While the URL alone is not a credential, it reduces the cost for an attacker to probe the API (combined with a valid anon key, it grants read access to all public-read tables). It also means the script silently connects to production if the environment variable is unset — which can cause data corruption during local or CI development runs.

**Remediation:**  
Remove the default value and fail fast if the variable is absent:

```python
SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]   # raises KeyError if unset
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
```

---

## Section 5 — Fixtures: ML_ENSEMBLE and Dixon-Coles Access Controls (PASS)

**Files checked:** `backfill_fixtures.py`, `ensemble/backfill_competitions.py`  
**Table:** `fixture_predictions`

Both backfill scripts insert rows with `model_architecture: "ML_ENSEMBLE"` into `fixture_predictions`. Live RLS audit confirms:

- `fixture_predictions` has `rowsecurity = true`.
- The only policy is `anon_read` (SELECT only for `anon` and `authenticated`).
- No INSERT/UPDATE/DELETE policy exists for public roles — write access is exclusively available to the service-role key used by the backend scripts.

**Result:** ML_ENSEMBLE fixture rows are correctly protected against unauthorized public write access while remaining readable by client consumers. No action required.

Dixon-Coles is a code-only algorithm; it does not populate any fixture table and therefore has no data-layer exposure.

---

## Appendix: Full RLS Status Snapshot (2026-06-21)

| Table               | RLS Enabled | Policies                          |
|---------------------|-------------|-----------------------------------|
| computed_values     | ✓           | public read (SELECT)              |
| fixture_predictions | ✓           | anon_read (SELECT)                |
| head_to_head        | ✓           | anon_read (SELECT)                |
| leagues             | ✓           | public read (SELECT)              |
| matches             | ✓           | public read (SELECT)              |
| model_probabilities | ✓           | anon_read (SELECT)                |
| odds                | ✓           | public read (SELECT)              |
| odds_snapshots      | ✓           | anon_read (SELECT)                |
| performance_summary | ✓           | anon_read (SELECT)                |
| recent_form         | ✓           | anon_read (SELECT)                |
| recommendations     | ✓           | anon_read (SELECT)                |
| team_stats_cache    | ✓           | anon_read (SELECT)                |
| teams               | ✓           | public read (SELECT)              |
| value_signals       | ✓           | anon_read (SELECT)                |
| watchlist           | ✓           | **anon_all (ALL) ← ISSUE 2**     |
