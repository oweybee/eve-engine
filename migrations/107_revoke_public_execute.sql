
-- 107 — `revoke ... from anon, authenticated` does not revoke anything.
--
-- Postgres grants EXECUTE to PUBLIC on every function it creates, and every
-- `create or replace` reinstates it. Revoking from two roles BY NAME leaves the
-- PUBLIC grant standing, and `anon` inherits through it. Measured before this
-- migration — proacl on all sixteen functions below begins `=X/postgres`, which
-- is the PUBLIC entry, and has_function_privilege('anon', ..., 'EXECUTE') is
-- true for every one of them.
--
-- Seven files tried and failed: 097, 098, 099, 100, 101, 104, 105 and 106 each
-- end with that revoke. None of them worked. The line looked like a control and
-- was not one, which is the same shape as the eleven call sites remembering the
-- same `.in(...)` that migration 047 was written for.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS ACTUALLY EXPLOITABLE TODAY, AND WHAT IS DEFENCE IN DEPTH.
--
-- EXPLOITABLE. `refresh_band_calibration` and `refresh_performance_by_band` are
-- SECURITY DEFINER and VOLATILE. A definer function runs with the OWNER's rights,
-- so RLS is not between them and the tables they write — anyone holding the
-- publishable key could refresh the public record on demand. `performance_band`
-- is what /performance renders.
--
-- COMPUTE. The three `research_*` functions and `mx_refresh_team_match` are
-- invoker-rights, so their writes would be denied — but the work happens BEFORE
-- the denial. `research_fit_dc` is a Dixon-Coles fit. An anonymous caller could
-- spend the database's CPU repeatedly and be refused only at the end.
--
-- DEFENCE IN DEPTH. `upsert_value_signal`, `settle_paper_trade`,
-- `capture_pre_kickoff_odds` and the six trigger functions are invoker-rights,
-- and `anon` holds no write privilege on any public relation (7 Aug 2026), so
-- RLS denies them today. That is precisely the argument the 7 Aug revoke
-- rejected: RLS as the ONLY thing between the browser bundle's key and the
-- dataset. A trigger does not check EXECUTE on its own function, so revoking
-- here cannot stop a trigger firing.
--
-- MEMBERS ONLY. `bookmaker_prime_performance` is the one STABLE function in the
-- list. Migrations 100 and 101 both state the intent — `revoke execute ... from
-- anon` — and both failed for this reason. Its internal `current_tier()` gate
-- still returns zero rows to a free caller, so nothing leaked; the gate was
-- simply the only thing working.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS DELIBERATELY LEFT ALONE. Every function below is anon-executable on
-- purpose and stays that way. Revoking across the board would take the product
-- down.
--
--   current_tier()          LOAD-BEARING. Every `tiered_read_*` policy CALLS it.
--                           Revoke it and every gated read fails for everybody,
--                           not just anon.
--   preview_*  (eight)      The RLS preview allowances themselves.
--   model_record()          Documented free surface — /models.
--   model_detail(text)      Documented free surface — /models/[id].
--   free_pick_candidates()  Migration 094. The one fixture for every reader.
--   league_scale_coverage() /how-it-works §04.
--
-- Verified before writing: all sixteen carry an EXPLICIT service_role grant, so
-- removing PUBLIC cannot orphan the engine, and `bookmaker_prime_performance`
-- carries an explicit `authenticated` grant for the members page.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- IT TAKES ALL THREE REVOKES, AND THAT IS WHY THE FIRST DRAFT OF THIS FILE WAS
-- WRONG TOO. The assertions below caught it against production.
--
-- There are two different holes here and each defeats the other's fix:
--
--   THIRTEEN of the sixteen carry an EXPLICIT `anon` AND `authenticated` grant —
--   Supabase's blanket `grant all on all functions in schema public` at creation
--   time. No migration has ever revoked those, so they have been anon-callable
--   since the day they were written. Revoking PUBLIC alone leaves them wide open.
--
--   THREE (`refresh_band_calibration`, `refresh_performance_by_band` and
--   `bookmaker_prime_performance`) had their explicit grants removed by 097-106
--   and reach anon through PUBLIC only. Revoking the named roles alone — which is
--   exactly what those seven files did — leaves them wide open.
--
-- So every revoke below names PUBLIC, anon AND authenticated. Checking one of
-- the three and declaring the hole shut is how this survived seven attempts.
--
-- Reversible: `grant execute on function public.<name>(<args>) to public;`

begin;

-- Exploitable: SECURITY DEFINER writers.
revoke execute on function public.refresh_band_calibration(integer, date)   from public, anon, authenticated;
revoke execute on function public.refresh_performance_by_band(date)         from public, anon, authenticated;

-- Members only, by its own design note.
revoke execute on function public.bookmaker_prime_performance(integer)      from public, anon;
-- authenticated KEEPS it — this is the members portal's one call, granted by 100
-- and 101. Re-stated here so the grant is visible beside the revoke that spares it.
grant execute on function public.bookmaker_prime_performance(integer) to authenticated;

-- Compute: expensive before RLS refuses.
revoke execute on function public.research_build_pi_ratings(numeric, numeric)                        from public, anon, authenticated;
revoke execute on function public.research_fit_dc(text, date, numeric, integer, integer, double precision) from public, anon, authenticated;
revoke execute on function public.research_tune_pi(numeric, numeric, integer)                        from public, anon, authenticated;
revoke execute on function public.mx_refresh_team_match()                                            from public, anon, authenticated;

-- Defence in depth: invoker-rights writers RLS denies today.
revoke execute on function public.upsert_value_signal(uuid, text, numeric, numeric, integer, text, timestamp with time zone) from public, anon, authenticated;
revoke execute on function public.settle_paper_trade(uuid, numeric, numeric, numeric)                from public, anon, authenticated;
revoke execute on function public.capture_pre_kickoff_odds()                                         from public, anon, authenticated;

-- Trigger functions. A trigger does not check EXECUTE on its own function, so
-- this removes a direct-call surface and changes no trigger behaviour.
revoke execute on function public.merge_duplicate_value_signal()      from public, anon, authenticated;
revoke execute on function public.normalise_signal_category()         from public, anon, authenticated;
revoke execute on function public.score_needs_coherent_market_prob()  from public, anon, authenticated;
revoke execute on function public.score_needs_measured_sigma()        from public, anon, authenticated;
revoke execute on function public.set_updated_at()                    from public, anon, authenticated;
revoke execute on function public.trg_settle_on_match_complete()      from public, anon, authenticated;

do $$
declare
  v_sig text;
  v_revoked text[] := array[
    'public.refresh_band_calibration(integer,date)',
    'public.refresh_performance_by_band(date)',
    'public.bookmaker_prime_performance(integer)',
    'public.research_build_pi_ratings(numeric,numeric)',
    'public.research_fit_dc(text,date,numeric,integer,integer,double precision)',
    'public.research_tune_pi(numeric,numeric,integer)',
    'public.mx_refresh_team_match()',
    'public.upsert_value_signal(uuid,text,numeric,numeric,integer,text,timestamp with time zone)',
    'public.settle_paper_trade(uuid,numeric,numeric,numeric)',
    'public.capture_pre_kickoff_odds()',
    'public.merge_duplicate_value_signal()',
    'public.normalise_signal_category()',
    'public.score_needs_coherent_market_prob()',
    'public.score_needs_measured_sigma()',
    'public.set_updated_at()',
    'public.trg_settle_on_match_complete()'
  ];
  v_kept text[] := array[
    'public.current_tier()',
    'public.model_record()',
    'public.model_detail(text)',
    'public.free_pick_candidates(integer)',
    'public.league_scale_coverage()',
    'public.preview_match_ids()',
    'public.preview_value_signal_ids()',
    'public.preview_computed_value_ids()',
    'public.preview_priced_match_ids()',
    'public.preview_signal_match_ids()',
    'public.preview_recommendation_ids()',
    'public.preview_suggested_acca_ids()',
    'public.preview_fixture_external_ids()'
  ];
begin
  -- 1. anon can no longer reach anything in the revoked set.
  foreach v_sig in array v_revoked loop
    assert not has_function_privilege('anon', v_sig::regprocedure, 'EXECUTE'),
      format('anon still holds EXECUTE on %s', v_sig);
    -- authenticated too, except the members-only reader it is granted on.
    assert v_sig = 'public.bookmaker_prime_performance(integer)'
        or not has_function_privilege('authenticated', v_sig::regprocedure, 'EXECUTE'),
      format('authenticated still holds EXECUTE on %s', v_sig);
  end loop;

  -- 2. No PUBLIC grant survives on any of them.
  foreach v_sig in array v_revoked loop
    assert not exists (
      select 1 from pg_proc p, aclexplode(p.proacl) a
       where p.oid = v_sig::regprocedure and a.grantee = 0),
      format('a PUBLIC grant survives on %s', v_sig);
    assert not exists (
      select 1 from pg_proc p, aclexplode(p.proacl) a
       where p.oid = v_sig::regprocedure
         and a.grantee = (select oid from pg_roles where rolname='anon')),
      format('an explicit anon grant survives on %s', v_sig);
  end loop;

  -- 3. The engine keeps every path it uses. fetchResults.js calls
  --    refresh_performance_by_band on every settlement run.
  foreach v_sig in array v_revoked loop
    assert has_function_privilege('service_role', v_sig::regprocedure, 'EXECUTE'),
      format('service_role LOST EXECUTE on %s', v_sig);
  end loop;

  -- 4. The members page keeps its one call.
  assert has_function_privilege('authenticated',
    'public.bookmaker_prime_performance(integer)'::regprocedure, 'EXECUTE'),
    'the members bookmaker table is no longer callable by a signed-in member';

  -- 5. The anon read surface is UNTOUCHED. current_tier() first: every
  --    tiered_read_* policy calls it, so losing it breaks reads for everyone.
  foreach v_sig in array v_kept loop
    assert has_function_privilege('anon', v_sig::regprocedure, 'EXECUTE'),
      format('anon LOST EXECUTE on %s — this breaks the public surface', v_sig);
  end loop;

  raise notice '107: % revoked, % preserved', array_length(v_revoked,1), array_length(v_kept,1);
end $$;

commit;
