# Security Audit Report — Database Schema, Migrations & Compute Layer

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

## Remediation priority

1. **High** — Finding 1: lock down `scoring_anchor` / `model_selection_anchor` (public write currently open on model-gating data).
2. **High** — Finding 2: add the missing `league_strength` RLS-enable statement to the tracked history and verify production state.
3. **Medium-High** — Finding 3: enable RLS (with appropriate read policy) on the seven tables listed with no protection at all.
4. **Medium** — Finding 4: backfill migrations recording RLS-enable for the core product tables already protected in production, to close the recurring drift pattern.
