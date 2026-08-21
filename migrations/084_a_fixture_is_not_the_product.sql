-- 084_a_fixture_is_not_the_product.sql
--
-- WHAT WAS BROKEN. A logged-out visitor could open NINE match pages in the
-- world, and which nine rotated every few hours. Measured on production,
-- 21 Aug 2026:
--
--     matches                        101,663 rows
--     preview_match_ids()                 49       <- what anon may read
--     upcoming fixtures                9,048
--     upcoming an anon may read           29
--
-- `preview_match_ids()` is `kickoff_at >= now() order by kickoff_at limit 20`,
-- unioned with the played 20 and the priced 9, so the set is a ROLLING WINDOW.
-- Every /match/<id> URL therefore rots: a link that resolves today 404s
-- tomorrow, for every crawler and every person who was sent one. That is not a
-- paywall — a paywall shows you what you are not getting.
--
-- WHY `matches` SHOULD NEVER HAVE BEEN GATED. Look at what is in it: two team
-- ids, a kickoff timestamp, a status, a minute and a final score. Every one of
-- those is a public football fact that this project did not compute, and the
-- three tables around it already say so —
--
--     teams            public read teams          USING (true)   1,560 rows
--     leagues          public read leagues        USING (true)      48 rows
--     match_results    public_read_match_results  USING (true)  77,438 rows
--
-- so the fixture list was the only member of that family behind the gate, and
-- `match_results` already publishes the SETTLED corpus in full, including
-- closing prices, under the standing rule that settled history is not gated
-- anywhere in this product. 047 swept `matches` up with the tables that hold
-- the actual product; this separates it back out.
--
-- WHAT STAYS SHUT, AND IT IS EVERYTHING THAT IS THE PRODUCT. Untouched by this
-- migration and still gated on `current_tier() <> 'free'` with a preview
-- exception: `computed_values` (the edge and the MES), `value_signals` (the
-- claim), `odds` and `odds_snapshots` (the 34-book price panel). The schedule
-- is not the product. The price, the edge, the claim and the forecast are.
--
-- ── THE COUPLING THAT MADE THIS DELICATE ───────────────────────────────────
--
-- `elo_forecasts` did not gate itself. Its policy was
--
--     EXISTS (SELECT 1 FROM matches m WHERE m.id = elo_forecasts.match_id)
--
-- which inherits whatever `matches` allows — the 1:1 invariant CLAUDE.md
-- records ("the model block can never be more or less available than the card
-- it sits in"). Opening `matches` without touching that line would have
-- published all 8,951 stored forecasts to the anon key, which is the model's
-- entire output and is Plus content on every surface that draws it.
--
-- So `elo_forecasts` gets its OWN gate here, in the 047 shape, over the SAME
-- `preview_match_ids()` the old policy reached through. Anon reads exactly the
-- 49 forecasts it could read before this migration — verified below. The
-- invariant is narrowed from "never more OR less available" to the half that
-- protects anything: **never MORE available than the fixture it sits on.**
--
-- ── REVERSIBLE ─────────────────────────────────────────────────────────────
--
--   create policy tiered_read_matches on public.matches for select
--     to anon, authenticated
--     using ((select current_tier()) <> 'free' or id in (select preview_match_ids()));
--
--   create policy elo_forecasts_follows_its_fixture on public.elo_forecasts
--     for select to anon, authenticated
--     using (exists (select 1 from matches m where m.id = elo_forecasts.match_id));
--
-- `(select current_tier())` rather than a bare call, per migration 059: a bare
-- STABLE call in a row filter is not hoisted and runs once PER ROW.

begin;

-- ── matches: a schedule is a public fact ────────────────────────────────────

drop policy if exists tiered_read_matches on public.matches;

create policy public_read_matches
  on public.matches
  for select
  to anon, authenticated
  using (true);

-- ── elo_forecasts: gates itself now, at exactly its old width ───────────────

drop policy if exists elo_forecasts_follows_its_fixture on public.elo_forecasts;

create policy tiered_read_elo_forecasts
  on public.elo_forecasts
  for select
  to anon, authenticated
  using (
    (select public.current_tier()) <> 'free'
    or match_id in (select public.preview_match_ids())
  );

-- ── Assertions, run as anon, BEFORE the transaction is allowed to commit ────
--
-- Reasoned-about security is how 047 shipped believing `matches` needed gating
-- and how four views served RLS-free rows for a month. These are measured.

do $$
declare
  n_matches        bigint;
  n_elo            bigint;
  n_elo_expected   bigint;
  n_computed       bigint;
  n_signals        bigint;
  n_odds           bigint;
  n_snapshots      bigint;
begin
  -- preview_match_ids() is SECURITY DEFINER and so is unaffected by the policy
  -- change: this is the width anon had before, computed the same way.
  select count(*) into n_elo_expected
    from public.elo_forecasts e
   where e.match_id in (select public.preview_match_ids());

  set local role anon;

  select count(*) into n_matches   from public.matches;
  select count(*) into n_elo       from public.elo_forecasts;
  select count(*) into n_computed  from public.computed_values;
  select count(*) into n_signals   from public.value_signals;
  select count(*) into n_odds      from public.odds;
  select count(*) into n_snapshots from public.odds_snapshots;

  reset role;

  -- The fixture list is open.
  if n_matches < 100000 then
    raise exception '084: anon reads only % matches — the schedule did not open', n_matches;
  end if;

  -- The forecast did not widen by one row.
  if n_elo <> n_elo_expected then
    raise exception '084: anon reads % elo_forecasts, expected % — the forecast changed width',
      n_elo, n_elo_expected;
  end if;

  -- Everything that IS the product is still capped. These are preview-sized;
  -- the assertion is that they are nowhere near the full table.
  if n_computed  > 100 then raise exception '084: computed_values leaked (% rows to anon)', n_computed;  end if;
  if n_signals   > 100 then raise exception '084: value_signals leaked (% rows to anon)', n_signals;      end if;
  if n_odds      > 5000 then raise exception '084: odds leaked (% rows to anon)', n_odds;                 end if;
  if n_snapshots > 50000 then raise exception '084: odds_snapshots leaked (% rows to anon)', n_snapshots; end if;

  raise notice '084 ok — anon: matches %, elo_forecasts % (was %), computed_values %, value_signals %, odds %, odds_snapshots %',
    n_matches, n_elo, n_elo_expected, n_computed, n_signals, n_odds, n_snapshots;
end $$;

commit;
