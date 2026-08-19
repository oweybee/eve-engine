-- 063_settle_reads_closing_lines.sql
--
-- `settle_match_signals()` was the ONLY thing that ever populated `no_vig_clv`,
-- and it built the number with PROPORTIONAL de-vig —
-- `total_implied * outcome_odds` — over whichever single bookmaker row happened
-- to be fetched last, with no book filter of any kind. lib/devig.js exists
-- precisely because proportional de-vig manufactures edge on the longer leg:
-- the 6 Aug backtest measured 49 longshots flagged, 1 winner, -70% yield, and
-- named it a de-vig artifact. The whole platform moved to Shin. This function
-- did not, and it wrote 816 rows.
--
-- It also took `closing_odds` from `odds_snapshots.snapshot_type = 'closing'`,
-- a label applied from 60 minutes before kickoff to 180 minutes AFTER it.
--
-- Both now read `closing_lines` (migration 061), the same source
-- `fetchResults.js` reads. Two settlement paths writing the same three columns
-- from two different definitions of "the close" is how they came to disagree;
-- there is one definition now and it lives in one table.
--
-- A fixture with NO closing line settles normally and gets NULL CLV. There is
-- deliberately no fallback: the fallbacks were the bug.

begin;

create or replace function public.settle_match_signals(p_match_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_match record;
begin
  select status, goals_home, goals_away into v_match
  from matches where id = p_match_id;

  if v_match.status <> 'completed' then
    raise exception 'Match % is not completed (status: %)', p_match_id, v_match.status;
  end if;

  -- Settle every pending signal on the fixture, and attach the closing line
  -- where one exists. The correlated subqueries return null when it does not,
  -- so a signal is never skipped for want of a benchmark — it settles with no
  -- CLV, which is the honest answer.
  --
  -- CLV is undefined for an in-play signal: the line closed at kickoff, so a
  -- pre-kickoff benchmark is not one. Those settle with null CLV too.
  update value_signals vs
  set
    result = case
      when vs.outcome = 'home' and v_match.goals_home > v_match.goals_away then 'win'
      when vs.outcome = 'away' and v_match.goals_away > v_match.goals_home then 'win'
      when vs.outcome = 'draw' and v_match.goals_home = v_match.goals_away  then 'win'
      else 'loss'
    end,
    closing_odds = cl.closing_odds,
    -- clv        vs the closing PRICE, margin still in it
    -- no_vig_clv vs the Shin-de-vigged FAIR close — the measure
    --            `paper_trade_gate()` opens the publication gate on
    clv = case
      when cl.closing_odds > 1 and vs.detected_odds > 1
      then round(ln(vs.detected_odds / cl.closing_odds), 4) end,
    no_vig_clv = case
      when cl.no_vig_odds > 1 and vs.detected_odds > 1
      then round(ln(vs.detected_odds / cl.no_vig_odds), 4) end
  from (
    select vs2.id,
           case when coalesce(vs2.phase, 'prematch') = 'inplay' then null else c.closing_odds end as closing_odds,
           case when coalesce(vs2.phase, 'prematch') = 'inplay' then null else c.no_vig_odds end as no_vig_odds
    from value_signals vs2
    left join lateral (
      select cl2.closing_odds, cl2.no_vig_odds
      from public.closing_lines cl2
      where cl2.match_id  = vs2.match_id
        and cl2.market    = coalesce(vs2.market, 'h2h')
        and cl2.selection = vs2.outcome
        and coalesce(cl2.market_line, -1) = coalesce(vs2.market_line, -1)
      limit 1
    ) c on true
    where vs2.match_id = p_match_id
      and vs2.result = 'pending'
  ) cl
  where vs.id = cl.id;

  update value_signals
  set signal_label = case
    when no_vig_clv is null then null
    when no_vig_clv > 0     then 'Market Steamer'
    when result = 'win'     then 'Sharp Contrarian Edge'
    when result = 'loss'    then 'Market Confirmed'
  end
  where match_id = p_match_id and result in ('win','loss');

  update recommendations r
  set
    settled = true,
    won = case
      when r.selection = 'home_win' and v_match.goals_home > v_match.goals_away then true
      when r.selection = 'away_win' and v_match.goals_away > v_match.goals_home then true
      when r.selection = 'draw'     and v_match.goals_home = v_match.goals_away  then true
      else false
    end,
    clv_pct = case
      when r.recommended_odds is not null and r.pre_kickoff_odds is not null and r.pre_kickoff_odds > 0
      then round(ln(r.recommended_odds / r.pre_kickoff_odds), 4)
      else r.clv_pct
    end
  where r.match_id = p_match_id and r.settled = false;

end;
$function$;

commit;
