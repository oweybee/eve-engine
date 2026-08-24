-- 095_the_anchors_can_still_be_emptied.sql
--
-- The 7 Aug revoke (`the client key can no longer write anything`) derived its
-- set from a RULE — revoke every write privilege where no permissive policy
-- could ever admit it — so that it could not go stale. Three tables created
-- AFTER it have gone stale anyway, because a rule applied once is not a rule.
-- Measured against production from a full seat, 24 Aug 2026:
--
--     table                     rls   policies   anon + authenticated hold
--     scoring_anchor            on           0   INSERT UPDATE DELETE TRUNCATE
--     model_selection_anchor    on           0   INSERT UPDATE DELETE TRUNCATE
--     league_strength           on           1   TRUNCATE
--
-- against the four the client is SUPPOSED to write, which are correct and are
-- not touched here: `bets`, `bankroll_transactions`, `preferences` and
-- `user_bookmakers`, all `authenticated`-only, all with policies.
--
-- ── WHAT IS AND IS NOT EXPLOITABLE TODAY ───────────────────────────────────
--
-- Be exact about this, because overclaiming a hole is how the next reader
-- stops believing the file. RLS is ON with ZERO policies on both anchors, so
-- INSERT, UPDATE and DELETE are DENIED to anon and authenticated right now —
-- the grants are inert against those three verbs. And PostgREST exposes no
-- TRUNCATE verb, so the publishable key alone does not empty a table over
-- HTTP.
--
-- What is left standing is the same thing 7 Aug refused to leave standing:
-- **TRUNCATE IS NEVER GOVERNED BY RLS AT ALL.** The privilege is real, it is
-- held by a role whose key ships in the browser bundle, and the only thing
-- between it and an empty table is that no route currently reaches it. That is
-- the definition of a control we do not have — "being unread by our own code
-- is not a control" (059), and one loose SECURITY DEFINER helper or one direct
-- connection is the whole distance.
--
-- ── WHY THESE THREE TABLES ARE WORTH THE MIGRATION ─────────────────────────
--
-- They are not leaf data. `scoring_anchor` and `model_selection_anchor` are
-- read by `paper_trade_gate()` (074) to decide whether a model's CLV is being
-- measured against an INDEPENDENT benchmark — the condition that is not a
-- number, and the one an architecture cannot argue its way past. Emptying them
-- does not make the gate fail closed; it removes the evidence that the
-- independence check ever had an anchor to check against. `league_strength`
-- (077) is the cross-league ELO offset behind every rating comparison the
-- product draws, and `lib/leagueScale` already records what a missing offset
-- costs: `theta ?? 0` files an unplaceable league at the TOP of the ladder.
--
-- ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
--
-- **It does not add a read policy to either anchor.** The audit report merged
-- alongside this migration recommends `create policy ... for select to anon,
-- authenticated using (true)` on both. That is DECLINED: nothing in either
-- repo reads these tables from a browser (checked — the only client reference
-- to any of the three is `lib/leagueScale.ts`, which reads the `league_scale`
-- VIEW), and granting fresh public read on model-gate configuration to satisfy
-- a linter is a widening, not a hardening. They stay fail-closed.
--
-- **It does not touch SELECT on `league_strength`.** `league_scale` is a view
-- and 059 set `security_invoker = on` without exception, so the view reads as
-- its caller and anon's SELECT on the base table is load-bearing for
-- /how-it-works §04. Revoking it would blank the ladder.
--
-- ── AND FOUR VIEWS CARRIED THE SAME LEFTOVER ───────────────────────────────
--
-- Found by re-running the sweep after the three tables were fixed, because the
-- first sweep filtered on `relkind = 'r'` and views are not tables. Default
-- privileges do not care about that distinction:
--
--     league_scale             INSERT UPDATE DELETE TRUNCATE   not updatable
--     settled_match_seasons    INSERT UPDATE DELETE TRUNCATE   not updatable
--     uncalibrated_writers     INSERT UPDATE DELETE TRUNCATE   not updatable
--     settled_match_prices     INSERT UPDATE DELETE TRUNCATE   **UPDATABLE**
--
-- `settled_match_prices` is the simple projection /leagues reads, and a simple
-- projection is AUTO-UPDATABLE — Postgres reports `is_updatable = YES` — so a
-- write through it is a write to `match_results`, the 77,438-row settled
-- corpus. It is not exploitable today for the same reason the anchors are not:
-- the view is `security_invoker`, so the write is attempted with the caller's
-- rights against the base table, and `match_results` grants anon SELECT and
-- nothing else. That is a SECOND control doing the work of a first one, which
-- is the arrangement this whole migration exists to stop relying on.
--
-- All four are revoked. None of them loses a read, and the closing assertion
-- says so per view rather than in aggregate.
--
-- Reversible: `grant <priv> on public.<table> to <role>`.

begin;

-- 077 never ran this. RLS is on in production (verified), so this is a no-op
-- there — it exists so that replaying this directory against a fresh database
-- (a restore, a new environment, `supabase db reset`) does not create the
-- table with RLS off. `board_signals` had the same shape in 059.
alter table public.league_strength        enable row level security;
alter table public.scoring_anchor         enable row level security;
alter table public.model_selection_anchor enable row level security;

revoke insert, update, delete, truncate on public.scoring_anchor         from anon, authenticated;
revoke insert, update, delete, truncate on public.model_selection_anchor from anon, authenticated;
revoke insert, update, delete, truncate on public.league_strength        from anon, authenticated;

revoke insert, update, delete, truncate on public.league_scale           from anon, authenticated;
revoke insert, update, delete, truncate on public.settled_match_prices   from anon, authenticated;
revoke insert, update, delete, truncate on public.settled_match_seasons  from anon, authenticated;
revoke insert, update, delete, truncate on public.uncalibrated_writers   from anon, authenticated;

do $$
declare
  n_write   int;
  n_select  int;
  n_client  int;
  n_views   int;
begin
  -- Stated as the RULE rather than as a list, so this cannot go stale the way
  -- 7 Aug's did: OUTSIDE the four member tables, the client holds no write
  -- privilege anywhere in `public` — tables and views alike.
  select count(*) into n_write
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    and table_name not in ('bets', 'bankroll_transactions', 'preferences', 'user_bookmakers');

  if n_write <> 0 then
    raise exception '095: % write grants survive outside the four member tables', n_write;
  end if;

  -- The ladder can still be read. This is the assertion that says the fix did
  -- not blank /how-it-works §04.
  select count(*) into n_select
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee = 'anon'
    and privilege_type = 'SELECT'
    and table_name = 'league_strength';

  if n_select <> 1 then
    raise exception '095: anon lost SELECT on league_strength — the league scale would go blank';
  end if;

  -- The four paths the client legitimately writes are untouched. Asserted
  -- rather than eyeballed, because a revoke that overreaches presents as a
  -- member being unable to record a bet.
  select count(distinct table_name) into n_client
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee = 'authenticated'
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
    and table_name in ('bets', 'bankroll_transactions', 'preferences', 'user_bookmakers');

  if n_client <> 4 then
    raise exception '095: the client write surface changed — % of 4 tables still writable', n_client;
  end if;

  -- Every view revoked above must still be readable, per view. An aggregate
  -- count here would pass with one view blanked and another double-counted.
  select count(*) into n_views
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee = 'anon'
    and privilege_type = 'SELECT'
    and table_name in ('league_scale', 'settled_match_prices',
                       'settled_match_seasons', 'uncalibrated_writers');

  if n_views <> 4 then
    raise exception '095: anon lost SELECT on a view (% of 4) — a surface would go blank', n_views;
  end if;

  raise notice '095 ok — the anchors, league_strength and four views are read-only to the client; the four member tables are unchanged';
end $$;

commit;
