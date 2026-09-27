# Security Audit Report — Database Schema, Migrations & Compute Layer

> **RE-VERIFIED AGAINST PRODUCTION, 27 Sep 2026.** Same standing rule as the
> 24 Aug pass below: a migration is what someone intended, the live table is
> what is true, so every claim in this update was checked against the
> `MaxEdge Project` database directly (Supabase advisors, `information_schema`,
> `pg_policies`, `pg_class`), not inferred from `.sql` files alone.
>
> | Finding | Verdict on live production, 27 Sep 2026 | Status |
> |---|---|---|
> | 1 — anchors writable | Re-confirmed fixed: `scoring_anchor` and `model_selection_anchor` both have RLS enabled with **zero** policies (fail-closed, as the declined-remediation note below intends) and no client write grant. | **FIXED**, holding |
> | 2 — `league_strength` enable missing from history | Not yet backfilled into a migration; live table still has RLS enabled and the correct policy. | **Open**, unchanged |
> | 3 — seven tables with no RLS at all | Re-confirmed does not reproduce. | **NO ACTION**, unchanged |
> | 4 — core product tables' RLS-enable missing from history | Not yet backfilled. | **Open**, unchanged |
> | 5 (**new**) — `team_statistics`/`referee_stats`/`team_elo`/`inplay_baseline` have the *same* migration-drift gap as Finding 2/4 | Live tables are correctly RLS-protected (this is why Finding 3 was marked NO ACTION), but their **migration files never enable RLS or revoke writes** — the narrower, real half of the old Finding 3 claim that got dropped when the broader "open to the public" claim was struck. | **New finding, open** |
> | 6 (**new**) — schema-wide default privileges leave unused write grants on ~14 tables/views | Every path checked is blocked by RLS or by the view being non-updatable — **except** `closing_lines_valid` / `closing_lines_independent_valid`, which are simple auto-updatable views one base-table policy change away from becoming exploitable. Not currently exploitable. | **New finding, open** |
>
> Findings 1–4 (24 Aug) are preserved below verbatim as the historical record.
> Findings 5–6 are this pass's additions and are detailed after them.

---

**Date:** 2026-08-23 (original), re-verified 2026-09-27
**Scope:** `migrations/*.sql`, live Supabase project schema (`MaxEdge Project`,
project ref `zlbmpeiuhyllxwegtayu`), `computeValues.js`, `lib/supabaseClient.js`

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

**Status (27 Sep 2026 re-check):** FIXED. Both tables have RLS enabled in
production with **zero** policies (`pg_policies` returns no rows for either)
and no client write grant. The public-read policy in the remediation above was
declined — see the note at the top of this document — so the tables are
fail-closed rather than fail-open-to-read: stricter than originally proposed,
not looser. No further action.

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

**Status (27 Sep 2026 re-check):** Open, unchanged. Production is still
correctly protected (RLS enabled, `SELECT` policy present); the migration file
still doesn't say so. See Finding 5 below — this exact pattern was found to
recur on four more tables.

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

**Status (27 Sep 2026 re-check):** NO ACTION, unchanged — does not reproduce.
Re-verified directly against `pg_class`/`information_schema.role_table_grants`:
every table in the list above has `rls_enabled = true`, holds no
`INSERT`/`UPDATE`/`DELETE` grant for `anon`/`authenticated`, and (for the
public-read set) a `SELECT` policy is in place. The claim that these are "open
to full public read and write via the anon key" remains false. However — see
Finding 5 — the fact that production is correctly locked down does **not**
mean the migration *files* for four of these tables (`team_statistics`,
`referee_stats`, `team_elo`, `inplay_baseline`) are safe to replay from
scratch, and that narrower point was not carried forward the last time this
finding was closed out. It's tracked separately below so it isn't dropped
again.

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

**Status (27 Sep 2026 re-check):** Open, unchanged. All eight tables remain
RLS-protected in production; none of the tracked migrations enable RLS for
them. Still worth closing, ideally in the same migration as Finding 2 and
Finding 5.

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

**Status (27 Sep 2026 re-check):** Re-reviewed independently this pass, same
conclusion. `@supabase/supabase-js` is a stateless REST/HTTP client — there is
no pooled/persistent connection object underneath `getClient()` that can "drop"
mid-run the way a raw `pg.Pool` connection can; every call is its own HTTP
request already covered by the `{ data, error }` handling described above. No
change recommended.

---

## Remediation priority (as of 24 Aug 2026 — superseded by the priority list at the end of this document)

1. **High** — Finding 1: lock down `scoring_anchor` / `model_selection_anchor` (public write currently open on model-gating data). — **DONE, migration 095.**
2. **High** — Finding 2: add the missing `league_strength` RLS-enable statement to the tracked history and verify production state.
3. **Medium-High** — Finding 3: enable RLS (with appropriate read policy) on the seven tables listed with no protection at all. — **Does not reproduce; superseded by Finding 5 for the migration-file gap.**
4. **Medium** — Finding 4: backfill migrations recording RLS-enable for the core product tables already protected in production, to close the recurring drift pattern.

---

# 27 Sep 2026 additions

## Finding 5 (Medium) — `team_statistics` / `referee_stats` / `team_elo` / `inplay_baseline` migration files never enable RLS or revoke writes

**Severity:** Medium (reproducibility / disaster-recovery risk, not a live exposure — production is currently correct)

**Location:**
- `migrations/027_team_and_referee_stats.sql` — creates `team_statistics`, `referee_stats`
- `migrations/031_team_elo.sql` — creates `team_elo`
- `migrations/032_inplay_baseline.sql` — creates `inplay_baseline`

This is the narrower, real half of Finding 3: when Finding 3 was re-checked and
its "open to full public read and write" claim was struck down as not
reproducing, the migration-file gap for these same four tables — which *is*
real, in exactly the same shape as Finding 2 and Finding 4 — was dropped along
with it rather than being carried forward on its own. None of these three
files contain `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, a `CREATE POLICY`,
or a `REVOKE`, and no later migration adds them for these four tables either
(checked by grepping every migration file for each table name).

**What's actually live (re-confirmed 27 Sep 2026):** all four tables have RLS
enabled in production, each with a permissive `SELECT` policy, and none carry
any `INSERT`/`UPDATE`/`DELETE` grant for `anon`/`authenticated`. Production is
correctly locked down — this is exactly why Finding 3 doesn't reproduce today.

**Why it still matters:** this project's Supabase instance has
`ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated`
configured at the schema level (confirmed via `pg_default_acl`) — the same
mechanism `migrations/045`, `059` (Part 2), `076`–`082`, `095` and `102` were
written to correct for other tables. Replaying `migrations/` against a clean
database — disaster recovery, a new environment, a branch/preview database —
would recreate these four tables with **no RLS and full public write access**,
silently reopening a hole this project has closed by hand at least half a
dozen times elsewhere, just not here.

**Remediation:** fold into the same cleanup migration recommended for Finding
2 and Finding 4:

```sql
alter table public.team_statistics enable row level security;
alter table public.referee_stats   enable row level security;
alter table public.team_elo        enable row level security;
alter table public.inplay_baseline enable row level security;

create policy team_statistics_read on public.team_statistics for select using (true);
create policy referee_stats_read   on public.referee_stats   for select using (true);
create policy team_elo_read        on public.team_elo        for select using (true);
create policy inplay_baseline_read on public.inplay_baseline for select using (true);

revoke insert, update, delete, truncate on public.team_statistics from anon, authenticated;
revoke insert, update, delete, truncate on public.referee_stats   from anon, authenticated;
revoke insert, update, delete, truncate on public.team_elo        from anon, authenticated;
revoke insert, update, delete, truncate on public.inplay_baseline from anon, authenticated;
```

This is a no-op against production — it exists purely so `migrations/` becomes
an accurate, replayable record of the live schema, closing the same drift
pattern as Findings 2 and 4.

---

## Finding 6 (Low) — Unused write grants from schema-wide default privileges, on ~14 tables/views

**Severity:** Low (defense-in-depth gap; not currently exploitable — RLS or
view non-updatability is doing the actual blocking in every case checked)

**Location:** schema-wide (`ALTER DEFAULT PRIVILEGES` on `public`), surfaced on
(non-exhaustive, confirmed via `information_schema.role_table_grants`):
`closing_lines_valid`, `closing_lines_independent_valid`, `performance_signals`,
`performance_signals_pending`, `v_board_rows`, `v_engine_reliability`,
`v_refresh_queue`, `signal_health_check`, `performance_band`,
`price_freshness_policy`, `engine_runs`, `pipeline_heartbeat`,
`league_refresh_scope`, `refresh_tier_occupancy`.

Every one of these has `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` granted to `anon`
and/or `authenticated` that no policy or application code ever uses — the same
default-ACL mechanism behind Findings 2, 4 and 5, just landing on objects
whose *reads* are already correctly gated so the extra grant went unnoticed.
Checked case by case, the write is blocked today by one of two mechanisms:

- **Tables with RLS enabled and no write policy at all**
  (`engine_runs`, `pipeline_heartbeat`, `league_refresh_scope`,
  `refresh_tier_occupancy`, `performance_band`, `price_freshness_policy`) —
  RLS default-denies any command with no matching policy, so the stray grant
  is currently inert. This is also flagged by Supabase's own advisor
  (`rls_enabled_no_policy`, INFO level) and matches the "service role only"
  intent documented directly in several of these tables' own comments.

- **Views** (`performance_signals`, `performance_signals_pending`,
  `v_board_rows`, `v_engine_reliability`, `v_refresh_queue`,
  `signal_health_check`) — these are non-simple views
  (`is_insertable_into = NO` in `information_schema.views`), so Postgres
  refuses DML against them structurally, independent of the grant.

- **`closing_lines_valid` / `closing_lines_independent_valid`** — these
  *are* simple, auto-updatable views (`is_insertable_into = YES`) with
  `security_invoker = true`, meaning a write through the view is evaluated
  under the caller's own privileges against the base table. The base tables
  (`closing_lines`, `closing_lines_independent`) have RLS enabled with either
  zero policies or a `SELECT`-only policy (confirmed via `pg_policies`), so
  the write is still denied — but this is the one case in this list where the
  grant on the view is one base-table RLS-policy change away from becoming a
  real, exploitable write path: if anyone ever adds a permissive policy to
  `closing_lines`/`closing_lines_independent` for any command without
  separately checking the *view's* grants, they'd unknowingly open write
  access to the base table through the view, with no fresh `GRANT` needed.

**Why it matters:** this repo's own migrations already establish the correct
pattern — explicitly revoking unused privileges on new tables/functions
(`migrations/045`, `076`–`082`, `095`, `102`) — precisely because relying on
RLS alone, with a stale/unused grant sitting underneath it, is one policy
change away from a silent privilege escalation. Every path here resolves
safely today, but the grants serve no purpose and add exactly the kind of
latent risk this project has spent multiple migrations removing elsewhere.

**Remediation:**
1. Add a migration that revokes `INSERT, UPDATE, DELETE, TRUNCATE` from
   `anon, authenticated` on the tables/views listed above (mirroring the
   `revoke ... from anon, authenticated` idiom already used throughout
   `migrations/045`–`migrations/102`).
2. Consider tightening the schema-level default going forward:
   ```sql
   alter default privileges in schema public
     revoke insert, update, delete, truncate on tables from anon, authenticated;
   ```
   so newly created tables/views stop inheriting write access by default, and
   Finding 5's failure mode can't recur for the *next* table someone adds.

---

## Remediation priority (current)

1. **Medium** — Finding 2: add the missing `league_strength` RLS-enable statement to the tracked history.
2. **Medium** — Finding 4: backfill migrations recording RLS-enable for the 8 core product tables already protected in production.
3. **Medium** — Finding 5: backfill migrations recording RLS-enable + write-revoke for `team_statistics`, `referee_stats`, `team_elo`, `inplay_baseline`. (Can land as one migration together with 2 and 4.)
4. **Low** — Finding 6: revoke the unused write grants on the ~14 tables/views listed, and tighten the schema's default privileges so this class of drift stops recurring automatically.

Finding 1 is closed (migration 095) and needs no further action. Finding 3
does not reproduce and needs no action beyond what Finding 5 already covers.
