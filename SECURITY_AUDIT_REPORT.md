# Security Audit Report — Database Schema, Migrations & Compute Layer

> **RE-CHECKED AGAINST PRODUCTION, 6 Sep 2026.** Scope: every migration added
> since the 24 Aug re-check (095–120), the three tables/views they created
> (`band_calibration`, `performance_band`, `inplay_momentum`, plus the
> `performance_signals`/`performance_signals_pending` views), the `ML_ENSEMBLE`
> / `Dixon-Coles` config rows, and `computeValues.js` / `lib/supabaseClient.js`
> again. Checked against the live database via the Supabase advisors and
> `information_schema`/`pg_catalog`, not only against migration text.
>
> **1 new issue found: `performance_band` is TRUNCATE-able by `anon` and
> `authenticated`.** Fixed below by migration 121. Everything else re-checked
> clean — see "6 Sep 2026 re-check" for the detail, and the table below for
> what carried over unchanged from 24 Aug.
>
> | Finding | Verdict on live production, 6 Sep 2026 |
> |---|---|
> | New — `performance_band` writable/truncatable | **REAL.** `anon`/`authenticated` hold INSERT/UPDATE/DELETE/TRUNCATE. RLS blocks the first three; TRUNCATE bypasses RLS entirely. | **FIXED** — migration 121 |
> | `band_calibration`, `inplay_momentum` (new since 24 Aug) | Both revoke all client privileges at creation (096, 111). Confirmed live: zero grants to `anon`/`authenticated`. | Clean |
> | `performance_signals` / `performance_signals_pending` views (new, 119/120) | `security_invoker=false` on the settled view is a deliberate, documented choice — mirrors `performance_summary`'s "public record" pattern and only ever exposes **settled** (non-actionable) rows; `_pending` keeps `security_invoker=true` so the paywall still applies to open picks. Both carry stray INSERT/UPDATE/DELETE/TRUNCATE grants inherited from Supabase's table defaults, but neither view is auto-updatable (`DISTINCT ON` + joins) and neither carries an `INSTEAD OF` trigger — confirmed live: `insert into performance_signals` raises `cannot insert into view`. Inert, not exploitable. | No action needed |
> | Findings 1–2 (23 Aug): `scoring_anchor`, `model_selection_anchor`, `league_strength` | Still RLS-on / zero-policy / write-revoked in production, exactly as migration 095 left them. | Still fixed |
> | Finding 3 (23 Aug): 7 tables with no RLS in tracked history | Still RLS-on with zero client write grants in production (an audit-trail gap, not a live exposure) — re-confirmed for all seven plus `performance_summary`. | Still no live issue |
> | `ML_ENSEMBLE` / `Dixon-Coles` rows | `ML_ENSEMBLE` only ever appears as a `model_architecture` value inside `value_signals`/`computed_values`, governed by the same tiered read policy as every other row in those tables (034/047/059) — no separate exposure. `Dixon-Coles`/`DIXON_COLES` lives in `model_selection_anchor`, which stays fail-closed (no client read, as migration 095's note explains: nothing client-side reads it, so a read policy would be a widening, not a hardening). | Confirmed clean |
> | Compute layer (`computeValues.js`, `lib/supabaseClient.js`) | Unchanged since 24 Aug; re-read in full. Still fail-fast at startup, still catches every query error, still fails closed. | Confirmed clean |
>
> One housekeeping note, not a security finding: the migrations directory has
> two files each numbered `038` and `110` (`038_completed_matches_require_
> score.sql`/`038_second_half_sniper.sql`, `110_band_window_opens_at_the_epoch_
> not_midnight.sql`/`110_the_dedupe_trigger_discards_every_inplay_signal.sql`).
> Both pairs are already applied and neither pair conflicts, so nothing to
> replay-fix — flagging only so a future contributor doesn't reuse a taken
> number a third time.
>
> ---
>
> **RE-CHECKED AGAINST PRODUCTION, 24 Aug 2026 — read this before acting on
> anything below.** Every finding was re-measured against the live database
> rather than against the migration history, on the standing rule that a
> migration is what someone intended and the table is what is true. Two
> findings hold and are now FIXED; one does not reproduce at all; one stands
> but is narrower than it reads.
>
> | Finding | Verdict on live production | Status |
> |---|---|---|
> | 1 — anchors writable | **REAL, and mis-described.** RLS is *enabled* on both anchors with **zero policies**, so INSERT/UPDATE/DELETE are already denied. What was genuinely exposed is **TRUNCATE**, which is never governed by RLS at all, plus the same grant on `league_strength`. | **FIXED** — migration 095 |
> | 2 — `league_strength` enable missing | **REAL.** RLS is on in production but no tracked migration enables it, so a replay creates it unprotected. | **FIXED** — migration 095 |
> | 3 — seven tables with no RLS | **DOES NOT REPRODUCE.** All seven (`mx_team_match`, `posted_signals`, `engine_plan`, `team_statistics`, `referee_stats`, `team_elo`, `inplay_baseline`, `performance_summary`) have RLS **on**, a policy, and **zero** client write grants. The claim that they are "open to full public read and write via the anon key" is false. | **NO ACTION** |
> | 4 — RLS-enable statements not in tracked history | **STANDS**, as an audit-trail concern only. All eight core product tables are RLS-protected in production today; the exposure is to migration *replay*, not to a live caller. | Open |
>
> Migration 095 also caught four VIEWS the audit's own sweep missed, because it
> filtered on tables. `settled_match_prices` is auto-updatable over the
> 77,438-row settled corpus and carried INSERT/UPDATE/DELETE/TRUNCATE for
> `anon`. Its closing assertion is now stated as the RULE rather than as a
> list — outside `bets`, `bankroll_transactions`, `preferences` and
> `user_bookmakers`, the client holds no write privilege anywhere in `public` —
> so it cannot go stale the way the 7 Aug sweep did.
>
> **Finding 1's remediation was NOT taken as written.** It recommends adding a
> public `SELECT` policy to both anchors. Declined: nothing in either repo
> reads them from a browser, and granting fresh public read on model-gate
> configuration to satisfy a linter is a widening, not a hardening. They stay
> fail-closed.

**Date:** 2026-08-23
**Scope:** `migrations/*.sql` (094 files), `computeValues.js`, `lib/supabaseClient.js`

## Summary

This audit checked every migration for `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
coverage on tables that carry public "ticker" data (fixtures/odds/model output) or
user state, checked model-configuration rows referencing `ML_ENSEMBLE` and
`Dixon-Coles` for unauthorized public write access, and reviewed the Supabase
client initialization path in `computeValues.js`.

Supabase grants `anon`/`authenticated` full table privileges (SELECT, INSERT,
UPDATE, DELETE) on new tables in `public` by default via `ALTER DEFAULT
PRIVILEGES`. This repo already relies on that fact explicitly — see the
`revoke insert, update, delete ...` statements in migrations 072, 073, 077 and
082, and migration 059's own note: *"a REST endpoint does not need a caller in
our app — being unread by our own code is not a control."* Any table that skips
**both** RLS and an explicit `REVOKE` is fully readable and writable by anyone
holding the public/anon key.

**4 issues found** (2 High, 1 Medium-High, 1 Medium/informational) and one item
confirmed clean (compute-layer client guard).

---

## Finding 1 (High) — `model_selection_anchor` / `scoring_anchor` have no RLS and no write revoke

**Location:** `migrations/074_gate_requires_independent_anchor.sql` (lines 31–66)

`scoring_anchor` and `model_selection_anchor` are created with no
`ENABLE ROW LEVEL SECURITY` and no `REVOKE` of write privileges — unlike every
other model-parameter table in this repo (072, 073, 077, 082 all pair RLS with
an explicit revoke). `model_selection_anchor` holds the row:

```sql
('DIXON_COLES','totals', array['bet365', ...], 'shin', 'panel_best_vector', ...)
```

and `value_signals`/`computed_values` carry `'ML_ENSEMBLE'` as a valid
`model_architecture` value throughout the migration history (022, 023, 025, 028,
030, 032, 038, 039, 055). `model_selection_anchor` is read directly by
`paper_trade_gate()` (074, lines 133–145) to decide whether a model's CLV is
measured against an independent benchmark. With default Supabase privileges in
effect, any anonymous request can currently `INSERT`/`UPDATE`/`DELETE` rows in
either table — e.g. rewrite `DIXON_COLES`'s declared `book_set`/`devig_method`
so `paper_trade_gate()` is fooled into treating a self-referential benchmark as
independent, turning a HOLD into a false PASS.

**Remediation:**

```sql
alter table public.scoring_anchor enable row level security;
alter table public.model_selection_anchor enable row level security;

create policy scoring_anchor_public_read
  on public.scoring_anchor for select to anon, authenticated using (true);
create policy model_selection_anchor_public_read
  on public.model_selection_anchor for select to anon, authenticated using (true);

revoke insert, update, delete on public.scoring_anchor from anon, authenticated;
revoke insert, update, delete on public.model_selection_anchor from anon, authenticated;
```

---

## Finding 2 (High) — `league_strength` RLS-enable statement missing from migration history

**Location:** `migrations/077_league_strength.sql` (table created, only a
`REVOKE` on writes at line 179) and `migrations/081_league_scale_is_readable.sql`
(lines 4–6, 46–50)

081 states *"RLS is enabled on `league_strength` and no policy was ever written
for it"* and then adds a `SELECT` policy — but no migration in this repo ever
runs `ALTER TABLE league_strength ENABLE ROW LEVEL SECURITY`. This matches a
pattern already documented in this repo for `board_signals` (059: *"already set
... directly against production"*): the change was applied out-of-band and
never captured in a migration file.

**Impact:** replaying the migrations directory against a fresh database (a
disaster-recovery restore, a new environment, or `supabase db reset`) will
create `league_strength` with **RLS disabled** and no `SELECT` policy — meaning
the table falls back to the plain table-level grant and is **fully readable by
anyone**, and — separately — the write-facing REVOKE in 077 does still apply,
so writes stay blocked either way. Read access, however, is unverifiable from
source and depends entirely on undocumented production-only state.

**Remediation:** add the missing enable statement to the tracked history (safe,
idempotent to re-run):

```sql
alter table public.league_strength enable row level security;
```

Add this near the top of a new migration, and audit whether any other table
touched only through the Supabase dashboard/SQL editor (rather than a tracked
migration) has similar drift.

---

## Finding 3 (Medium-High) — Several data/model tables have neither RLS nor a write revoke

None of the following tables (all created inside tracked migrations) have an
`ENABLE ROW LEVEL SECURITY` statement or a write `REVOKE` anywhere in the
migration history:

| Table | Migration | Role |
|---|---|---|
| `mx_team_match` (+ `mx_team_form`, `mx_referee_form` views) | 051_paper_trade_writer.sql | Per-team-per-match fact table feeding corners/cards models |
| `posted_signals` | 015_posted_signals.sql | Dedup ledger for outbound Telegram/X posts |
| `engine_plan` | 014_engine_plan.sql | Daily odds-polling schedule |
| `team_statistics`, `referee_stats` | 027_team_and_referee_stats.sql | Feeds the "Team Stats" UI panel and corners/cards models |
| `team_elo` | 031_team_elo.sql | Persistent ELO ladder feeding in-play/pre-match models |
| `inplay_baseline` | 032_inplay_baseline.sql | Frozen pre-match λ anchor for the in-play win-probability engine |
| `performance_summary` | 007_performance_summary.sql | The public track-record surface (explicitly meant to be public per 047) |

With default Supabase privileges, all of these are currently open to full
public **read and write** via the anon key. Beyond the confidentiality concern,
write access lets anyone directly corrupt values that feed live models or the
public track record — e.g. rewrite `team_elo` ratings to bias predictions,
falsify `performance_summary` (the very thing migration 047 calls "proof
accruing in public"), or inject bogus rows into `posted_signals` to break its
idempotency guarantee.

**Remediation** — split by intended audience:

Public-read, engine-write-only (`team_statistics`, `referee_stats`, `team_elo`,
`inplay_baseline`, `performance_summary`, `mx_team_match`/`mx_coverage`):

```sql
alter table public.<table> enable row level security;
create policy <table>_public_read on public.<table>
  for select to anon, authenticated using (true);
revoke insert, update, delete on public.<table> from anon, authenticated;
```

Fully internal, no client surface (`posted_signals`, `engine_plan`):

```sql
alter table public.<table> enable row level security;
-- no policy granted to anon/authenticated → default-deny; service_role
-- (used by the engine) bypasses RLS entirely, same as everywhere else in this repo.
```

---

## Finding 4 (Medium / audit-trail gap) — RLS-enable statements for core product tables aren't in the tracked migration history

`value_signals`, `recommendations`, `odds_snapshots`, `computed_values`,
`matches`, `odds`, `suggested_accas`, and `fixture_predictions` are clearly
RLS-protected in production today — migrations 034, 047 and 059 all `drop
policy if exists` and recreate policies on these tables, which only works if
RLS was already enabled. But no tracked migration (002 onward) ever runs
`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` for any of them — they predate this
migrations directory or had RLS turned on directly against production, same as
`board_signals` and (per Finding 2) `league_strength`.

**Impact:** the migration history is not a reproducible source of truth for
this database's security posture on its most important tables — the ones
carrying the paid product (odds, prices, signals). A fresh restore from
migrations alone would leave these tables fully open, silently defeating the
tiered-access paywall built in 034/047.

**Remediation:** capture current production state as a new migration —
`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` is idempotent and safe to re-run —
so `migrations/` becomes authoritative again. Recommend an explicit process
going forward: no schema change (including RLS toggles) applied directly via
the Supabase dashboard/SQL editor without a same-day migration file recording
it, closing off the drift pattern that has now recurred at least three times
(`board_signals`, `league_strength`, and this batch of core tables).

---

## Compute layer: `computeValues.js` / `lib/supabaseClient.js` — reviewed, no issue found

`lib/supabaseClient.js`'s `getClient()` throws synchronously at startup only
when `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are absent — a deliberate
fail-fast documented both in that file and in `computeValues.js`'s top-of-file
note (the lazy `require` exists specifically so pure pricing functions stay
unit-testable without a live DB). This is an initialization-time guard, not a
per-query one, and it does not run on every call.

Every actual Supabase query in `computeValues.js` (`fetchMatchesForComputation`,
`upsertComputedValues`, `insertValueSignals`, `insertSecondarySignals`,
`fetchEloLookup`, `fetchStatsLookups`) checks the returned `error` object and
throws a descriptive `Error` rather than letting an unhandled rejection escape.
A momentary dropped connection surfaces as a normal caught/logged error, not a
raw crash. The two non-critical enrichment blocks in `main()` (secondary-market
pricing, ensemble inference) are additionally wrapped in `try/catch` so a
transient failure there can't take down the core 1X2 compute path. The
top-level `main().catch(...)` in the CLI entrypoint exits the process
deliberately (`process.exit(1)`) on any unrecovered error — appropriate for a
scheduled batch job that should fail loudly rather than silently write partial
or stale data, consistent with the fail-closed philosophy documented
throughout this codebase (e.g. migration 074, `computeConsensus`'s "IT FAILS
CLOSED" note).

**No remediation needed.** Do not wrap the core Supabase calls in a
swallow-and-continue `try/catch` to avoid the process exiting on a dropped
connection — that would contradict this repo's explicit fail-closed design and
risk masking real data-integrity failures rather than fixing anything.

---

## Finding 5 (High) — `performance_band` is TRUNCATE-able by `anon` and `authenticated`

**Found:** 6 Sep 2026 re-check. **Location:** `migrations/103_performance_by_band.sql`
(table created, lines 24–63) — no revoke statement anywhere in the file or
in 104/119/120, which only touch the refresh function and the two ledger
views built on top of this table.

`performance_band` is the table `/performance` and every published PRIME/EDGE/
Longshots yield figure is rendered from (see migration 103's own comment: "the
performance record is kept PER BAND"). It enables RLS and grants `SELECT` to
`anon`/`authenticated`, but — unlike its siblings `band_calibration` (096) and
`inplay_momentum` (111), which both `revoke all ... from anon, authenticated`
in the same migration that creates them — it never revokes the write
privileges Supabase's default privileges hand to those roles on every new
table in `public`. Measured live via `information_schema.role_table_grants`:

```
 table_name        | grantee       | privileges
--------------------+---------------+----------------------------------------------
 performance_band   | anon          | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
 performance_band   | authenticated | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
```

RLS on the table carries only two permissive policies —
`performance_band_anon_read` (`for select using (published)`) and
`performance_band_service` (`for all to service_role`) — so INSERT/UPDATE/
DELETE from `anon`/`authenticated` are already denied by RLS (no matching
policy means no rows pass `WITH CHECK`/`USING`). **TRUNCATE is not governed by
RLS at all**, which is exactly Finding 1 from the 23 Aug audit re-check
("What was genuinely exposed is TRUNCATE ... the same grant on
`league_strength`", fixed by migration 095) — the same class of gap,
recurring on the table this session's public track record depends on. Anyone
holding the `anon` or `authenticated` key can currently empty
`performance_band`, wiping every published PRIME/EDGE/Longshots figure with no
RLS check able to stop it.

**Remediation:** the same revoke its siblings already carry:

```sql
revoke insert, update, delete, truncate on public.performance_band from anon, authenticated;
```

**Status: FIXED** — see `migrations/121_performance_band_revoke_public_write.sql`,
added by this audit. Not yet applied to production; apply it the same way 095
was applied.

---

## Remediation priority

0. **High** — Finding 5 (6 Sep 2026): apply `migrations/121_performance_band_revoke_public_write.sql` to production — `anon`/`authenticated` can currently `TRUNCATE` the public performance record.
1. **High** — Finding 1: lock down `scoring_anchor` / `model_selection_anchor` (public write currently open on model-gating data). **Applied 23 Aug via migration 095** — re-confirmed live 6 Sep 2026.
2. **High** — Finding 2: add the missing `league_strength` RLS-enable statement to the tracked history and verify production state. **Applied 23 Aug via migration 095** — re-confirmed live 6 Sep 2026.
3. **Medium-High** — Finding 3: enable RLS (with appropriate read policy) on the seven tables listed with no protection at all. **Does not reproduce on production** (all seven are RLS-protected live) — re-confirmed 6 Sep 2026; remains an audit-trail gap only.
4. **Medium** — Finding 4: backfill migrations recording RLS-enable for the core product tables already protected in production, to close the recurring drift pattern. Still open.
