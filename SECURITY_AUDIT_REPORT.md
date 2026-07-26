# Security Audit — Database Schema, Migrations & Compute Layer

Date: 2026-07-26
Scope: SQL migrations (`migrations/`), Supabase project `zlbmpeiuhyllxwegtayu` (live schema via Supabase advisors), and `computeValues.js`.

## Summary

| # | Area | Result |
|---|------|--------|
| 1 | RLS on tables that interact with public/user data | **1 critical gap found** — `public.match_results` |
| 2 | `ML_ENSEMBLE` / `Dixon-Coles` model-architecture rows (`value_signals`, `computed_values`, `fixture_predictions`, `recommendations`, `suggested_accas`) | Pass — read-gated by tier, no public write path |
| 3 | `computeValues.js` Supabase client init guard | Pass — fail-fast by design, no runtime-crash risk |

---

## Finding 1 (Critical): `public.match_results` has RLS disabled

**Location:** live Supabase schema (table not created via a migration file in this repo — no `migrations/*.sql` references `match_results`, so it was created out-of-band, e.g. via SQL editor or CSV import).

**Detail:** Confirmed via `mcp__Supabase__get_advisors` (security, level `ERROR`, lint `0013_rls_disabled_in_public`) and `mcp__Supabase__list_tables` (`rls_enabled: false`):

> Table `public.match_results` is public, but RLS has not been enabled.

The table holds 77,438 rows of historical match results (`home_team`, `away_team`, full-time/half-time scores, shots, cards, odds, etc. — the training-data feed used by the ML ensemble). It is **not referenced anywhere in the application code** (`computeValues.js`, `ensemble/*`, `ml/*`, frontend) — it appears to be a standalone dataset table left over from model training/backfill.

Because RLS is disabled, Postgres grants govern access directly, and this project grants the default Supabase role set full CRUD:

```
anon:          SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
authenticated: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
```

**Impact:** anyone holding the public `anon` key (embedded in every frontend bundle) can, with no login required, read the entire dataset via `GET /rest/v1/match_results?select=*`, and can also `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` it via the same REST endpoint — i.e. the table can be silently corrupted or wiped by an unauthenticated request.

**Remediation:** enable RLS. Since the table isn't consumed by any client code, the safe default is to enable RLS with **no policies**, which blocks all `anon`/`authenticated` access while leaving it fully readable/writable by the `service_role` key used server-side (RLS is bypassed for `service_role`, same pattern already used for `bets`, `value_signals`, etc.). If a future feature needs client-side read access, add an explicit `select` policy at that time.

```sql
alter table public.match_results enable row level security;
```

A staged migration implementing this is included in this PR: `migrations/039_match_results_rls.sql`. Per the Supabase advisor's own guidance ("do not auto-apply — enabling RLS without policies will block all access"), it has **not** been applied to the live database; it is staged for review, following the same pattern as `migrations/034_tiered_premium_access.sql`.

---

## Finding 2 (Low/Informational): `free_preview_limit()` has a mutable `search_path`

**Location:** `migrations/034_tiered_premium_access.sql:33`

**Detail:** Supabase advisor `0011_function_search_path_mutable` (level `WARN`) flags `public.free_preview_limit()` for not pinning `search_path`. The sibling `SECURITY DEFINER` preview helpers in the same migration (`preview_value_signal_ids`, etc.) do pin `set search_path = public, pg_catalog`, but `free_preview_limit` was defined without it. `migrations/035_db_housekeeping.sql` explicitly called out pinning `search_path` on security-relevant functions (advisor `0011`) as a hardening step, so this one function looks like an oversight rather than a deliberate omission.

**Impact:** low — `free_preview_limit()` is a trivial `immutable sql` function (`select 5`) with no table access, so a hijacked `search_path` can't be leveraged to redirect it to a malicious object. Included for completeness/consistency with the rest of the migration.

**Remediation:**

```sql
alter function public.free_preview_limit() set search_path = '';
```

Included in `migrations/039_match_results_rls.sql`.

---

## Reviewed, no action needed

- **`ML_ENSEMBLE` / `Dixon-Coles` fixture data** (`value_signals`, `computed_values`, `fixture_predictions`, `recommendations`, `suggested_accas` — all carry rows with `model_architecture = 'ML_ENSEMBLE'`): all five tables have RLS enabled, and `pg_policies` shows only `SELECT` policies granted to `anon`/`authenticated` (tier-gated via `current_tier()` + bounded `preview_*_ids()` helpers from migration 034). No `INSERT`/`UPDATE`/`DELETE` policy exists for those roles, so public write is not possible; the engine writes exclusively via `SUPABASE_SERVICE_ROLE_KEY` (`lib/supabaseClient.js`), which bypasses RLS by design. Read access for paying tiers and a capped free/anon preview both work as intended.
- **`computeValues.js` / `lib/supabaseClient.js` client init:** `getClient()` is a lazy-initialized singleton that throws immediately if `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are missing — intentional fail-fast behavior documented in the module's own comments. `computeValues.js` is a one-shot batch/cron script (`if (require.main === module) { main().catch(...) }`), not a long-lived server process; an unhandled query error correctly logs and `process.exit(1)`s so the scheduler can retry the next cycle, rather than leaving a corrupted process running. A momentarily dropped connection during a query surfaces as a normal Supabase client error (`{ data, error }`), which the code already checks and throws on with a descriptive message — there is no code path where a dropped connection crashes the Node process with an unhandled exception/segfault. No change needed.
- **Other advisor items reviewed and judged intentional/low-priority, not part of this report's scope:** `anon`/`authenticated` execute grants on `preview_*_ids()`/`current_tier()`/`export_my_data()`/`settle_my_bets()` SECURITY DEFINER functions are narrow, bounded-return helpers by design (migration 034); `auth_leaked_password_protection` (Supabase Auth setting, not a schema/migration change) is worth enabling separately; `team_elo`/`inplay_baseline` having RLS enabled with zero policies is over-restrictive but not a vulnerability (it fully blocks `anon`/`authenticated` access rather than exposing anything).

---

## Files changed

- `migrations/039_match_results_rls.sql` — staged fix for Finding 1 and Finding 2 (not applied to production; requires manual review/apply, same as `034_tiered_premium_access.sql`).
