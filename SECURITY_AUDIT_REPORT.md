# Security Audit Report — EVE Engine

**Audit date:** 2026-06-28  
**Scope:** Database schemas, migrations, fixture tables, and compute layer  
**Auditor:** Automated security audit (Claude Code)

---

## Summary

The live Supabase project (`zlbmpeiuhyllxwegtayu`) has RLS enabled on all 23 public tables and passes the Supabase Security Advisor with zero lints. However, four actionable issues were found during a deeper review of migration files, fixture write-access patterns, and the compute layer client.

| Severity | Finding |
|----------|---------|
| HIGH | Migration files do not codify RLS enablement — fresh deploys ship without RLS |
| HIGH | `backfill_fixtures.py` hardcodes the production Supabase URL with wrong env-var name |
| MEDIUM | 18 tables have no explicit write policy — rely on implicit `service_role` RLS bypass |
| MEDIUM | `match_lineups` and `match_predictions_af` tables are absent from the live database |
| LOW | `computeValues.js` has no retry on transient Supabase HTTP failures |

---

## Finding 1 — HIGH: Migration files do not codify `ENABLE ROW LEVEL SECURITY`

### Location
`migrations/002_intelligence_platform.sql` through `migrations/025_value_signals_model_architecture.sql` (all except `021_match_lineups_stats.sql`)

### Description
`ALTER TABLE … ENABLE ROW LEVEL SECURITY` is present in only one migration file (`021_match_lineups_stats.sql`). Every other migration that creates a new table omits this statement. The affected tables include:

- `recommendations` (002)
- `odds_snapshots` (002)
- `value_signals` (006)
- `performance_summary` (007)
- `engine_plan` (014)
- `posted_signals` (015)

The live database has RLS enabled on all tables (confirmed via `pg_class.relrowsecurity`), but this was applied outside of the tracked migration history (likely via the Supabase dashboard). This means:

- Restoring the database from migration files alone would produce tables with **no RLS** and fully open public read/write access.
- CI/CD pipelines that apply migrations to staging or branch databases will inherit insecure defaults.
- The security posture is not reproducible or auditable from the repository.

### Remediation
Add a follow-up migration (e.g. `026_enable_rls_all_tables.sql`) that enables RLS on all existing tables and is idempotent:

```sql
-- Migration 026: Codify RLS enablement for all tables missing it from earlier migrations
ALTER TABLE public.recommendations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.odds_snapshots       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.value_signals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performance_summary  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engine_plan          ENABLE ROW LEVEL SECURITY;
-- (repeat for all tables not already covered by migration 021)
```

Going forward, every `CREATE TABLE` statement in a migration must be immediately followed by `ALTER TABLE … ENABLE ROW LEVEL SECURITY`.

---

## Finding 2 — HIGH: `backfill_fixtures.py` hardcodes production Supabase URL with wrong env-var name

### Location
`backfill_fixtures.py`, lines 8–9

```python
SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL", "https://zlbmpeiuhyllxwegtayu.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "your-service-role-key")  # Use service role key to pass RLS blocks
```

### Description
Two problems in two lines:

1. **Wrong env-var name**: The script reads `NEXT_PUBLIC_SUPABASE_URL` (a Next.js client-side convention) instead of `SUPABASE_URL` (used by every other script in this repo). In any non-Next.js execution environment (GitHub Actions, local terminal, Docker) this variable is never set, so the script silently falls back to the hardcoded URL. The developer almost certainly intended to write `os.getenv("SUPABASE_URL")`.

2. **Hardcoded production URL**: The fallback value `https://zlbmpeiuhyllxwegtayu.supabase.co` is the real production Supabase project URL, committed to the repository. If this repo is ever made public or forked, the endpoint is immediately visible. While the URL alone cannot authenticate, it gives attackers a stable target and makes credential-stuffing and API-abuse enumeration easier. It is also inconsistent with the rest of the codebase which uses environment variables exclusively.

### Remediation
Replace lines 8–9 with the same pattern used by `ensemble/seed_world_cup.py`, `ensemble/seed_datahub.py`, and `lib/supabaseClient.js`:

```python
SUPABASE_URL = os.environ.get('SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
```

Remove the hardcoded URL from the file and commit. If the URL has already been indexed by any public system, consider rotating the project credentials.

---

## Finding 3 — MEDIUM: 18 tables have no explicit write policy (rely on implicit `service_role` bypass)

### Location
Live database RLS policy table (`pg_policies`)

### Description
18 of the 23 public tables have only a `SELECT` policy for `public`, `anon`, or `authenticated` roles. They have no `INSERT`, `UPDATE`, `DELETE`, or `ALL` policy for any role. Writes succeed today only because Supabase's `service_role` key bypasses RLS by default — a behaviour that is implicit, not codified.

Affected tables (confirmed via `pg_policies` query):
`computed_values`, `engine_plan`, `fixture_predictions`, `head_to_head`, `leagues`, `lineups`, `match_predictions`, `match_stats`, `matches`, `model_probabilities`, `odds`, `odds_snapshots`, `performance_summary`, `recent_form`, `recommendations`, `team_stats_cache`, `teams`, `value_signals`

The other five tables (`edge_signals`, `fixture_mapping`, `posted_signals`, `team_stats`, `watchlist`) do have explicit `service_role ALL` policies. This inconsistency creates an unclear security posture:

- Future developers may assume all writable tables have explicit write policies and be confused when new service_role clients can or cannot write.
- If Supabase ever changes the default RLS bypass behaviour, these tables would silently become unwritable.
- There is no policy audit trail showing *which role is intended to write* to each table.

### Remediation
Add explicit `service_role ALL` policies to all tables the engine writes to, matching the pattern already used on `posted_signals`:

```sql
CREATE POLICY "service_role_write_computed_values"
  ON public.computed_values
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_write_value_signals"
  ON public.value_signals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- repeat for: recommendations, odds_snapshots, performance_summary, engine_plan
```

Read-only tables (e.g. `teams`, `leagues`, `matches`, `odds`) that are never written by the engine should be left with `SELECT`-only policies, but the intent should be documented in a comment on the migration.

---

## Finding 4 — MEDIUM: `match_lineups` and `match_predictions_af` tables are absent from live database

### Location
`migrations/021_match_lineups_stats.sql` vs. live `information_schema.tables`

### Description
Migration `021` creates three tables:

```sql
create table if not exists public.match_lineups (…);
create table if not exists public.match_stats (…);
create table if not exists public.match_predictions_af (…);
```

Querying the live database shows that `match_stats` exists, but `match_lineups` and `match_predictions_af` do not. This indicates migration 021 was partially applied, or those two tables were dropped after creation. Their `ENABLE ROW LEVEL SECURITY` statements and any dependent RLS policies are therefore also missing from the live schema.

Any code path that references `match_lineups` or `match_predictions_af` (e.g. `fetchMatchDetails.js`, `computeApiValues.js`) will fail with `relation "public.match_lineups" does not exist`.

### Remediation
1. Confirm whether the tables are intentionally absent (tables renamed/deprecated) or missing due to an incomplete migration run.
2. If they should exist, re-apply the relevant `CREATE TABLE` and `ENABLE ROW LEVEL SECURITY` statements for the two missing tables.
3. Add a migration `027` (or similar) that is idempotent and creates them with RLS if absent:

```sql
CREATE TABLE IF NOT EXISTS public.match_lineups (…);
ALTER TABLE public.match_lineups ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.match_predictions_af (…);
ALTER TABLE public.match_predictions_af ENABLE ROW LEVEL SECURITY;
```

---

## Finding 5 — LOW: `computeValues.js` has no retry on transient Supabase failures

### Location
`computeValues.js`, lines 374–421 (`main()` function and error handler)

### Description
The Supabase client initialization guard in `lib/supabaseClient.js` is correctly implemented — it validates `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on first call and throws immediately if either is absent, preventing silent misconfigurations. The `auth: { persistSession: false, autoRefreshToken: false }` options are appropriate for a server-side process.

However, any Supabase HTTP error that occurs *during* a compute run (network timeout, brief connectivity drop, transient 5xx from the Supabase REST API) propagates uncaught to:

```javascript
main().catch(err => {
  console.error('[engine] fatal:', err.message);
  process.exit(1);
});
```

This terminates the entire compute run. A single momentary network hiccup during `fetchMatchesForComputation`, `upsertComputedValues`, or `insertValueSignals` aborts all pending matches. The GitHub Actions cron will restart the job on the next tick, but any compute window missed in the interim represents lost signal coverage.

### Remediation
Wrap the three database-facing async calls with a simple retry helper:

```javascript
async function withRetry(fn, attempts = 3, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === attempts - 1) throw err;
      console.warn(`[engine] transient error, retry ${i + 1}/${attempts}: ${err.message}`);
      await new Promise(r => setTimeout(r, delayMs * 2 ** i));
    }
  }
}
```

Apply it to the three critical operations:

```javascript
const matches = await withRetry(() => fetchMatchesForComputation(supabase));
await withRetry(() => upsertComputedValues(supabase, computedRows));
await withRetry(() => insertValueSignals(supabase, valueRows));
```

---

## Items Confirmed Passing

| Check | Result |
|-------|--------|
| Live database RLS enabled on all 23 tables | ✅ PASS |
| Supabase Security Advisor | ✅ 0 lint findings |
| `fixture_predictions` (ML\_ENSEMBLE / Dixon-Coles rows) — no public write | ✅ PASS — `anon_read` SELECT-only policy |
| `computed_values` (ML\_ENSEMBLE / Dixon-Coles rows) — no public write | ✅ PASS — `public read` SELECT-only policy |
| `computeValues.js` client initialization guard (env-var validation) | ✅ PASS — throws on missing vars before any DB call |
| `lib/supabaseClient.js` singleton guard | ✅ PASS — single client instance per process lifetime |
| `auth.autoRefreshToken: false` on server-side client | ✅ PASS — appropriate for service role |
| Migration 021 RLS enablement statements | ✅ PASS — present for all three tables it creates |

---

*Report generated by automated security audit on 2026-06-28.*
