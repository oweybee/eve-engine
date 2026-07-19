# Security Audit Report — Database Schema, Migrations & Compute Layer

**Date:** 2026-07-19
**Scope:** SQL migrations (`migrations/`), live Supabase project `MaxEdge Project` (`zlbmpeiuhyllxwegtayu`), and `engine/computeValues.js` / `lib/supabaseClient.js`.
**Method:** Static review of every migration file in the repo, cross-checked against the *live* database state (`pg_policies`, `pg_class.relrowsecurity`, `information_schema.role_table_grants`, and the Supabase security advisor) rather than the migration files alone, since repo history and applied state had already diverged in one place (see Finding 3).

---

## Finding 1 — CRITICAL: `public.match_results` has RLS disabled; anon/authenticated can write and truncate it

**Location:** Live database only. No corresponding file exists under `migrations/` — the table was created directly against the database via an out-of-band Supabase migration (`20260716135233 create_match_results`) that was never committed to this repo.

**Issue:** `public.match_results` holds 77,438 rows of historical match results (1993‑08‑14 → 2026‑05‑24: full/half-time score, shots, corners, cards, referee, odds — the training corpus that feeds the Dixon‑Coles / `ML_ENSEMBLE` model architectures referenced in `migrations/032_inplay_baseline.sql`'s `model_architecture` check constraint). It is the *only* table in the `public` schema with `relrowsecurity = false`. Every comparable fixture/reference table (`matches`, `teams`, `leagues`, `odds_snapshots`, `team_statistics`, `referee_stats`, `team_elo`, `inplay_baseline`, …) has RLS **enabled**.

Supabase grants `anon`/`authenticated` broad table-level privileges (`SELECT, INSERT, UPDATE, DELETE, TRUNCATE, …`) by default on every table in `public`; RLS is what narrows those defaults down to what a policy allows. With RLS off, the default grants apply unfiltered. Confirmed live:

```
grantee=anon         SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
grantee=authenticated SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
```

**Impact:** Anyone holding only the publishable/anon key (embedded in any client that talks to this project) can, with no authentication, read, insert, modify, delete, or `TRUNCATE` the entire `match_results` table via `POST/PATCH/DELETE https://<project>.supabase.co/rest/v1/match_results`. This is exactly the "unauthorized public write access" scenario the audit was scoped to catch, on a table that feeds model training/backfill.

Also flagged independently by the Supabase security advisor as `rls_disabled_in_public` (**ERROR**, ID `0013`).

**Remediation:** Enable RLS and add a public read-only policy, mirroring the pattern already used for every other fixture/reference table in this schema (`matches`/`teams`/`leagues` use `for select to public using (true)`; `odds_snapshots`/`team_statistics`/`referee_stats` use `anon_read` for `select to anon, authenticated using (true)`). No write policy is added — writes stay restricted to the service-role key (used by the engine's backfill scripts), which bypasses RLS entirely, exactly as it does for every other table here.

A ready-to-apply fix has been added at `migrations/039_match_results_rls.sql` in this PR. **It has not been applied to the live database** — apply it via the Supabase SQL editor/CLI after review, the same way `034_tiered_premium_access.sql` was staged.

---

## Finding 2 — LOW / informational: `team_elo` and `inplay_baseline` have RLS enabled with no policies (default-deny, not a vulnerability)

**Location:** Live database (`migrations/031_team_elo.sql`, `migrations/032_inplay_baseline.sql` create the tables but neither file — nor any other file in the repo — enables RLS or adds a policy for them; RLS was turned on directly against the database, likely as part of the untracked `add_rls_policies_analytics_and_watchlist` / `rls_policies_reference_tables` migrations visible in `mcp__Supabase__list_migrations` but not present as files in this repo).

**Issue:** RLS is enabled on both tables but no policy exists, so both are fully inaccessible to `anon`/`authenticated` (default-deny — Postgres denies all rows when RLS is on and no policy matches). This is **safe**, not a security hole — the engine reads/writes them exclusively via the service-role key, which bypasses RLS. Flagged by the Supabase advisor only at `INFO` level (`rls_enabled_no_policy`).

Noted because it means these two tables are currently unreadable by any client-side (anon-key) code, which may or may not be the intended product behavior — worth a deliberate "add a public/tiered read policy" or "confirm intentionally engine-only" decision, but it is not a security defect.

**Remediation:** No action required for security. If these values are meant to be surfaced to the frontend, add an explicit `for select` policy (as done for `team_statistics`/`referee_stats`) rather than leaving it as an accidental default-deny.

---

## Finding 3 — INFO: stale "NOT YET APPLIED" comment in `migrations/034_tiered_premium_access.sql`

**Location:** `migrations/034_tiered_premium_access.sql:3-5`

**Issue:** The file's header still reads "⚠️ STAGED FOR REVIEW — NOT YET APPLIED TO PRODUCTION." Verified against the live database that this migration **has in fact been applied** — `tiered_read_value_signals`, `tiered_read_computed_values`, `tiered_read_recommendations`, `tiered_read_suggested_accas`, and `paid_read_fixture_predictions` are all live, and the free-tier paywall bypass this migration fixes (anon could `GET /rest/v1/value_signals?select=*` and read every paid signal) is closed in production today. The `ML_ENSEMBLE`/`DIXON_COLES`-tagged rows in `value_signals` (see the `model_architecture` check constraint in `migrations/032_inplay_baseline.sql`) are correctly tiered: full read for paid tiers, a capped "latest 5" preview for free/anon, and no public write policy exists anywhere in the schema for these tables (writes are service-role only).

**Impact:** None today — this is a documentation/hygiene gap, not a live vulnerability. But a stale "not applied" warning on a *security* migration risks someone re-running the rollback block at the bottom of the file (which restores `USING (true)` anon-read policies) under the false belief that the tiered policies were never live, reopening Finding 3's predecessor vulnerability.

**Remediation:** Update the header comment in `migrations/034_tiered_premium_access.sql` to reflect that it was applied (with a date), so the rollback block isn't mistaken for the currently-active state. Done in this PR (comment-only change; no live behavior change since the migration was already applied).

---

## Finding 4 — LOW: `free_preview_limit()` has a mutable search_path

**Location:** `migrations/034_tiered_premium_access.sql:33-34` (live function `public.free_preview_limit`)

**Issue:** Unlike its sibling functions in the same file (`preview_value_signal_ids`, `preview_computed_value_ids`, etc., which all include `set search_path = public, pg_catalog`), `free_preview_limit()` does not pin its `search_path`. Flagged by the Supabase advisor as `function_search_path_mutable` (`WARN`). A mutable search_path on a `SECURITY DEFINER`-adjacent helper is the standard Postgres schema-hijacking vector (a malicious `search_path` could shadow an unqualified identifier), though the practical risk here is low since the function body has no unqualified references.

**Remediation:** Add `set search_path = public, pg_catalog` to `free_preview_limit()`, consistent with the rest of the file and with the hardening already done in `migrations/035_db_housekeeping.sql` for `public.set_updated_at()`. Fixed in `migrations/040_free_preview_limit_search_path.sql` in this PR (not yet applied to production).

---

## Finding 5 — INFO: Leaked-password protection disabled (Supabase Auth config, not this repo)

**Issue:** The Supabase project has "leaked password protection" (HaveIBeenPwned check on signup/password-change) disabled. Flagged by the Supabase advisor (`auth_leaked_password_protection`, `WARN`). This is a dashboard/project setting, not something expressed in this repo's migrations.

**Remediation:** Enable it in Supabase Dashboard → Authentication → Policies. No code change needed.

---

## Item-by-item audit checklist (as requested)

1. **New tables interacting with public tickers/user states have RLS enabled** — **FAIL**: `public.match_results` does not (Finding 1). Every other table with a matching profile (fixture/reference data or user state) does have RLS enabled. Fix staged in `migrations/039_match_results_rls.sql`, not yet applied.
2. **`ML_ENSEMBLE` / `Dixon-Coles`-tagged rows protected against unauthorized public write, with read preserved for clients** — **PASS**. These are `model_architecture` values on `value_signals`/`computed_values` (see `migrations/032_inplay_baseline.sql`'s check constraint), not separate tables. No `INSERT`/`UPDATE`/`DELETE`/`ALL` policy granting `anon`/`authenticated` write access exists anywhere in `migrations/*.sql` or in the live `pg_policies` table — all writes go through the service-role key, which bypasses RLS. Read access is correctly tiered (paid tiers get full access, free/anon get a capped preview) per the live, applied `034_tiered_premium_access.sql` (Finding 3).
3. **`computeValues.js` Supabase client init guard cannot crash the runtime on a momentary connection drop** — **PASS**. `lib/supabaseClient.js:getClient()` only validates that `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are present at process start and throws immediately if not (intentional fail-fast, documented in `computeValues.js`'s top-of-file note so pure pricing functions can still be unit-tested without env vars). It does not open a connection at init time — the underlying `@supabase/supabase-js` client makes a fresh HTTP request per call, so a transient network drop surfaces as a rejected promise on the specific call site (already handled via the `{ data, error }` destructuring pattern used throughout the file), not a crash at client construction. No change needed.
4. **Report + draft PR if issues found** — done; this file, plus a remediation migration for Finding 1, are included in this PR.

---

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `match_results` RLS disabled, anon/authenticated can write/truncate | **Critical** | Fix staged (`migrations/039_match_results_rls.sql`), **not yet applied to production** |
| 2 | `team_elo`/`inplay_baseline` RLS-enabled-no-policy (default-deny) | Low / informational | No action required; flag for product decision |
| 3 | Stale "NOT YET APPLIED" comment on an already-live security migration | Info | Fixed (comment-only) in this PR |
| 4 | `free_preview_limit()` mutable search_path | Low | Fix staged (`migrations/040_free_preview_limit_search_path.sql`), not yet applied |
| 5 | Leaked password protection disabled (Auth config) | Info | Recommend enabling in dashboard |

**Action required:** Review and apply `migrations/039_match_results_rls.sql` to close Finding 1 — it is the only issue in this report with an active, unauthenticated public write/delete/truncate path in production.
