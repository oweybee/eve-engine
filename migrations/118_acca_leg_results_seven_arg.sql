-- 118: my_acca_leg_results() grades every leg through the 7-arg bet_leg_outcome.
--
-- RECORD, NOT TO BE RE-RUN. Applied via the Supabase MCP on 16 Oct 2026 as
-- schema_migrations `118_acca_leg_results_seven_arg`. pg_get_functiondef() in
-- the database is the source of truth.
--
-- WHY. Migration 117 added a 7-argument overload of bet_leg_outcome (with
-- corners and cards, defaulting to null) beside the original 5-argument one.
-- my_acca_leg_results() called it with five arguments, and with both
-- overloads in place Postgres cannot choose: the call raised
--   42725: function public.bet_leg_outcome(text, text, numeric, smallint, smallint) is not unique
-- on EVERY invocation. So from 117 onwards no member saw any acca leg result
-- in My Bets, not just the legs on the new markets. Settlement was unaffected:
-- settle_my_bets() passes all seven arguments, which only one overload takes.
-- (A 5-argument call with integer arguments is ambiguous too, so the old
-- overload is now unreachable by any 5-argument call; it was left in place.)
--
-- CORNERS AND CARDS COME FROM v_match_extras, NOT match_extra_stats. This
-- function runs with the CALLER's rights (it is not security definer), and a
-- signed-in member reads ZERO rows of match_extra_stats (RLS on, no policy),
-- while v_match_extras is readable (385 rows at the time). Joining the table
-- the way settle_my_bets() does would have graded every corners and cards leg
-- as unknown without an error.
--
-- VERIFIED. Rehearsed in a rolled-back transaction, then applied, then read
-- back as the one member holding accas (14 tickets, 62 legs): 55 finished legs
-- graded (35 won, 20 lost), 7 unfinished ungraded. All 55 grade identically to
-- the old 5-argument logic (34 h2h, 17 totals, 4 btts). EXECUTE grants for
-- authenticated and service_role are unchanged.

create or replace function public.my_acca_leg_results()
 returns table(bet_id uuid, leg_index integer, outcome text, finished boolean, goals_home integer, goals_away integer)
 language sql stable
 set search_path to 'public', 'pg_catalog'
as $function$
  select b.id,
         (l.ord - 1)::integer,
         case when m.status = 'completed' then
           public.bet_leg_outcome(l.leg->>'market', l.leg->>'selection',
             nullif(l.leg->>'market_line', '')::numeric,
             m.goals_home::integer, m.goals_away::integer,
             x.corners::integer, x.cards::integer)
         end,
         coalesce(m.status = 'completed', false),
         case when m.status = 'completed' then m.goals_home::integer end,
         case when m.status = 'completed' then m.goals_away::integer end
  from public.bets b
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(b.acca_legs) = 'array' then b.acca_legs else '[]'::jsonb end
  ) with ordinality as l(leg, ord)
  left join public.matches m
    on m.id = case when (l.leg->>'match_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   then (l.leg->>'match_id')::uuid end
  left join public.v_match_extras x on x.match_id = m.id
  where b.is_acca = true
    and b.user_id = auth.uid()
$function$;
