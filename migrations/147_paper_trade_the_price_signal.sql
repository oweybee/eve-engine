-- 147 — paper-trade "the best price beats the sharp fair line", at the moment
-- a reader could first have seen it.
--
-- WHY (12 Oct 2026). Over every settled match, the last pre-kickoff
-- MARKET_ANCHORED snapshot shows best bettable price > fair, priced under 5.0,
-- returning +11.4% over 583 legs (t 2.13). It survives three checks run the
-- same day: taken at the SECOND-best price it is still +8.0%; where two or
-- more books beat fair (so no single stale quote) it is +17.2% over 213; and
-- it is stronger on fresh prices (+18.2% when the odds were fetched inside an
-- hour of kickoff) than on old ones (+7.2%).
--
-- WHAT THE BACKTEST CANNOT SAY. `computed_values` is UPSERTED, one row per
-- match and architecture, so "the last pre-kickoff snapshot" is simply the
-- last write before kickoff — median 1 minute before it. There is no history
-- of when the price first beat fair, how long it stayed, or whether it was
-- there when a reader looked. That is the confound this table exists to
-- measure, so it logs FORWARD:
--
--   · first_seen_*   the price, book, fair line and second-best price the
--                    first time the leg qualified — the honest entry price
--   · last_seen_* / seen_count / max_best
--                    whether it persisted, which is the closest thing to
--                    "takeable" the data can give without placing a bet
--   · settlement     P/L at first sight and at the second-best price, and
--                    CLV against the no-vig close in `closing_lines`
--
-- WHAT "FAIR" IS, BECAUSE THE BRIEF NAMED IT WRONGLY. For MARKET_ANCHORED,
-- `computed_values.fair_*_odds` is Pinnacle's Shin-de-vigged price
-- (computeValues.js, `ANCHOR_BOOK`), NOT a de-vig of the consensus. So this
-- signal is "a soft book's best price beats the sharp book's no-vig line",
-- which is the MARKET_ANCHORED edge > 0 and nothing else. API_PREDICTIVE rows
-- carry a MODEL price in the same column and are excluded here.
--
-- Nothing reads this table and nothing is published from it. RLS is on with no
-- policy, so neither browser seat can see it.

create table if not exists public.price_paper_legs (
  match_id          uuid        not null references public.matches(id) on delete cascade,
  selection         text        not null check (selection in ('home','draw','away')),
  kickoff_at        timestamptz not null,
  first_seen_at     timestamptz not null default now(),
  first_best        numeric     not null,
  first_book        text,
  first_fair        numeric     not null,
  first_best2       numeric,
  first_books       integer     not null,
  first_books_beating integer   not null,
  first_odds_fetched_at timestamptz,
  last_seen_at      timestamptz not null default now(),
  last_best         numeric     not null,
  max_best          numeric     not null,
  seen_count        integer     not null default 1,
  result            text        check (result in ('win','loss')),
  pnl_first         numeric,
  pnl_best2         numeric,
  close_no_vig_odds numeric,
  clv_first         numeric,
  settled_at        timestamptz,
  primary key (match_id, selection)
);

alter table public.price_paper_legs enable row level security;
revoke all on public.price_paper_legs from anon, authenticated;

create or replace function public.log_price_paper_legs()
returns integer
language sql
security definer
set search_path = public
as $$
  with cv as (
    select cv.match_id, m.kickoff_at, cv.odds_fetched_at,
           cv.all_home_odds, cv.all_draw_odds, cv.all_away_odds,
           cv.fair_home_odds::numeric fh, cv.fair_draw_odds::numeric fd, cv.fair_away_odds::numeric fa
    from computed_values cv
    join matches m on m.id = cv.match_id
    where cv.model_architecture = 'MARKET_ANCHORED'
      and m.status = 'scheduled'
      and m.kickoff_at > now()
      and m.kickoff_at < now() + interval '7 days'
      -- A price a reader could act on: fetched within the hour.
      and coalesce(cv.odds_fetched_at, cv.computed_at) > now() - interval '60 minutes'
  ), legs as (
    select match_id, kickoff_at, odds_fetched_at, 'home' sel, all_home_odds j, fh fair from cv
    union all select match_id, kickoff_at, odds_fetched_at, 'draw', all_draw_odds, fd from cv
    union all select match_id, kickoff_at, odds_fetched_at, 'away', all_away_odds, fa from cv
  ), priced as (
    select l.*,
      (select max(v::numeric) from jsonb_each_text(l.j) t(k, v)) best,
      (select k from jsonb_each_text(l.j) t(k, v) order by v::numeric desc, k limit 1) book,
      (select v::numeric from jsonb_each_text(l.j) t(k, v) order by v::numeric desc offset 1 limit 1) best2,
      (select count(*) from jsonb_each_text(l.j) t(k, v))::int books,
      (select count(*) from jsonb_each_text(l.j) t(k, v) where v::numeric > l.fair)::int beating
    from legs l
    where l.j is not null and jsonb_typeof(l.j) = 'object' and l.fair > 1
  ), hits as (
    select * from priced where books >= 3 and best > fair and best < 5
  ), up as (
    insert into price_paper_legs as p (
      match_id, selection, kickoff_at, first_best, first_book, first_fair, first_best2,
      first_books, first_books_beating, first_odds_fetched_at, last_best, max_best
    )
    select match_id, sel, kickoff_at, best, book, fair, best2, books, beating, odds_fetched_at, best, best
    from hits
    on conflict (match_id, selection) do update
      set last_seen_at = now(),
          last_best    = excluded.last_best,
          max_best     = greatest(p.max_best, excluded.last_best),
          seen_count   = p.seen_count + 1,
          kickoff_at   = excluded.kickoff_at
      where p.settled_at is null
    returning 1
  )
  select count(*)::int from up;
$$;

create or replace function public.settle_price_paper_legs()
returns integer
language sql
security definer
set search_path = public
as $$
  with src as (
    select p.match_id, p.selection, p.first_best, p.first_best2,
           (p.selection = 'home' and m.goals_home > m.goals_away)
        or (p.selection = 'draw' and m.goals_home = m.goals_away)
        or (p.selection = 'away' and m.goals_home < m.goals_away) as won,
           (select c.no_vig_odds from closing_lines c
             where c.match_id = p.match_id and c.market = 'h2h' and c.selection = p.selection
             order by c.captured_at desc limit 1) as close_nv
      from price_paper_legs p
      join matches m on m.id = p.match_id
     where p.settled_at is null and m.status = 'completed'
       and m.goals_home is not null and m.goals_away is not null
  ), done as (
    update price_paper_legs p
       set result            = case when s.won then 'win' else 'loss' end,
           pnl_first         = case when s.won then s.first_best - 1 else -1 end,
           pnl_best2         = case when s.first_best2 is null then null
                                    when s.won then s.first_best2 - 1 else -1 end,
           close_no_vig_odds = s.close_nv,
           clv_first         = case when s.close_nv > 1 then s.first_best / s.close_nv - 1 end,
           settled_at        = now()
      from src s
     where p.match_id = s.match_id and p.selection = s.selection
    returning 1
  )
  select count(*)::int from done;
$$;

revoke all on function public.log_price_paper_legs() from public, anon, authenticated;
revoke all on function public.settle_price_paper_legs() from public, anon, authenticated;

-- Every five minutes, offset from refresh-odds (*/5) and the engine trigger
-- so it reads the scan that just landed.
select cron.schedule('price-paper-log', '3-58/5 * * * *', 'select public.log_price_paper_legs()');
select cron.schedule('price-paper-settle', '47 * * * *', 'select public.settle_price_paper_legs()');

-- The read, for whoever checks on it:
--
--   select count(*) n, count(*) filter (where settled_at is not null) settled,
--          avg(pnl_first) filter (where settled_at is not null) yield_first,
--          avg(pnl_best2) filter (where settled_at is not null) yield_best2,
--          avg(clv_first) filter (where settled_at is not null) clv,
--          avg(seen_count) avg_seen,
--          avg(extract(epoch from last_seen_at - first_seen_at)/60) avg_minutes_alive,
--          avg(extract(epoch from kickoff_at - first_seen_at)/3600) avg_hours_before_ko
--     from price_paper_legs;
