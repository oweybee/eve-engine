-- 083_settled_match_prices.sql — the settled book, with the price it closed at.
--
-- WHAT THIS IS FOR. The edge league table asks one question of settled history:
-- did a club win more often than the market's closing price said it would? That
-- needs three things per match — who played, what happened, and what the close
-- was — and all three are already in `match_results`, which holds 77,438 rows
-- of the football-data.co.uk corpus and is anon-readable under
-- `public_read_match_results` (USING true). Nothing here is newly exposed.
--
-- IT IS A PROJECTION, NOT A COMPUTATION. The prices live in an `odds` jsonb of
-- ~110 keys per row, so a client that wanted three of them would either pull all
-- 110 or reach into the jsonb through a PostgREST path expression. This view
-- lifts the three out as plain numeric columns and does nothing else. It does
-- NOT de-vig, it does NOT aggregate, and it does NOT score. Those belong to
-- `lib/devig` and `lib/edgeTable` in eve-frontend, and putting a second copy of
-- the de-vig in SQL is the mistake this project has already refused twice — the
-- match-card route reads `elo_forecasts` rather than recomputing the vector, for
-- exactly this reason, and the `MODEL_SIGMA` hand-copy shows what a second copy
-- costs when it drifts (two production failures, neither of which threw).
--
-- WHY THE CLOSING AVERAGE AND NOT THE OPENER. `AvgC{H,D,A}` is the market's
-- mean closing 1X2 across the books football-data samples; `Avg{H,D,A}` is the
-- opener. The close is the sharper number and it is also the MORE complete one
-- here — 17,078 rows carry the closing triplet against 17,043 carrying the
-- opening one. It is the same benchmark `closing_lines` (061) exists to capture
-- for our own fixtures, on a corpus that goes back to 2019/20 rather than to
-- last month. `PSC{H,D,A}` (Pinnacle's close) would be sharper still and covers
-- 39% of rows; a view that silently changed which book it quoted by division
-- would be worse than one that quotes the same thing everywhere.
--
-- ALL THREE LEGS OR NONE. A partial 1X2 vector cannot be de-vigged, and a row
-- admitted with one leg missing would be silently dropped downstream instead of
-- counted. Measured before writing this: all 17,078 rows that carry `AvgCH`
-- carry all three, every value parses as a number, and every one has an `ftr` —
-- so today the filter removes nothing that a reader would want. It is here for
-- the day the feed changes, and the cast is safe because of it.
--
-- security_invoker = on, WITHOUT EXCEPTION. A plain view runs with its owner's
-- rights, and this database's owner is a superuser — that is precisely the hole
-- four views had open until migration 059, where `board_signals` served every
-- published pending signal to anon past the 047 tier gate. `match_results` is
-- ungated anyway (settled history is not gated, and never has been), so this
-- view grants no reader a row they could not already read; the setting is here
-- so it stays true if the base table's policy is ever tightened.
--
-- Reversible: `drop view public.settled_match_seasons, public.settled_match_prices`.

begin;

-- ── the rows ───────────────────────────────────────────────────────────────
create or replace view public.settled_match_prices
with (security_invoker = on) as
select
  mr.id,
  mr.div,
  mr.country,
  mr.season,
  mr.match_date,
  mr.home_team,
  mr.away_team,
  -- 'H' | 'D' | 'A'. Full-time result; the only three values in the column.
  mr.ftr,
  (mr.odds ->> 'AvgCH')::numeric as close_home,
  (mr.odds ->> 'AvgCD')::numeric as close_draw,
  (mr.odds ->> 'AvgCA')::numeric as close_away
from public.match_results mr
where mr.ftr is not null
  and mr.odds ? 'AvgCH'
  and mr.odds ? 'AvgCD'
  and mr.odds ? 'AvgCA';

comment on view public.settled_match_prices is
  'Settled matches with their mean closing 1X2 price, lifted out of match_results.odds '
  'as plain columns. A projection only — no de-vig, no aggregation, no score. '
  'security_invoker = on (see migration 059).';

-- ── what the corpus covers ─────────────────────────────────────────────────
--
-- A season picker needs the DISTINCT seasons that carry a close, and PostgREST
-- has no DISTINCT — the alternative is pulling 17,078 `season` strings to the
-- browser to find seven of them. Thirty-five rows of counts instead. The counts
-- are also the surface's own coverage statement: a division that stopped being
-- priced mid-season shows up here as a short count rather than as a table that
-- quietly got smaller.
create or replace view public.settled_match_seasons
with (security_invoker = on) as
select
  season,
  div,
  country,
  count(*)::integer      as matches,
  min(match_date)        as first_match,
  max(match_date)        as last_match
from public.settled_match_prices
group by season, div, country;

comment on view public.settled_match_seasons is
  'One row per (season, division) that carries closing prices, with its match count '
  'and date span. Feeds the edge league table''s season picker so no season list is typed.';

grant select on public.settled_match_prices  to anon, authenticated;
grant select on public.settled_match_seasons to anon, authenticated;

commit;
