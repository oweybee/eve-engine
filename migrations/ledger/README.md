# migrations/ledger

SQL that was applied straight to production (Supabase MCP `apply_migration` /
`execute_sql`) and recorded in `supabase_migrations.schema_migrations`, but
never committed as a file. Each file here is that ledger row's `statements`,
copied verbatim on 25 Oct 2026, named `<ledger version>_<ledger name>.sql`.

- **Nothing runs this folder.** Every statement is already in the database.
  Do not re-apply any of it.
- It is a subfolder on purpose: `engine.archconstraint.test.js` reads only
  top-level `migrations/*.sql`, and the numbered sequence there is unchanged.
- One anon JWT (a public key) in `20260629074941_schedule_trigger_engine_cron.sql`
  is replaced with `<REDACTED_JWT>` because this repo is public.

## How the gaps were found
All 331 ledger rows were matched against `migrations/*.sql` two ways: by name
(the ledger name, its slug, or its version appearing in a file name or body)
and by content (a normalised fingerprint of the row's SQL appearing in a repo
file). A row counts as missing only when BOTH failed. 127 rows are missing:
~70 from June to early August (portal, research scratch tables, early engine
setup), ~33 from late August and September (the 110–122 health batch, paper
harness pieces, view fixes) and 24 from October (price freshness, predictor
league, referrals, promo codes, quote trust gate, rung rules of 25 Oct, the
free-pick revoke).

## Known the other way round
Repo files applied with `execute_sql`, so they have no ledger row: 176
(social queue) and 180–183 (the ledger holds placeholder rows for those).
190 and 191 are covered by ledger rows under other names
(`snapshot_existence_rpc`, `player_recent_refresh_gate`,
`security_definer_views_resolved`).
