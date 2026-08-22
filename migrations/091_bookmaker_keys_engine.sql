-- 091 — one bookmaker identity, engine-owned tables.
--
-- The same book was stored two ways in one column. Measured 22 Aug 2026:
--   value_signals              497 rows hold a display label
--   computed_values.best_home  901 · best_draw 995 · best_away 1,021
--   recommendations            462
--   bet_of_day_candidates       18
-- so `bet365` and `Bet365` are two groups in every aggregate, and any .eq()
-- on the column matches about half the rows it should. It broke two of this
-- session's own measurements inside ten minutes.
--
-- The cause was `formatBookName` — a presentation function called while
-- BUILDING the row. The writers store keys as of this deploy; this is the
-- history.
--
-- MEMBER TABLES ARE NOT TOUCHED HERE. `bets` (11 rows) and `user_bookmakers`
-- (2 rows) render in a member's own ledger and picker, so they wait for the
-- browser that knows how to label a key to be live. That is migration 092.
--
-- THE MAP BELOW IS A FOURTH COPY and that is acceptable ONLY because it is a
-- one-shot: after this runs nothing reads it, which is what makes it different
-- from the three live copies that drifted. It is a CLOSED set — every distinct
-- non-key value measured in production, not a general slugifier — so a value
-- nobody anticipated is left alone rather than mangled.
--
-- REVERSIBILITY: the labels are not recoverable from the keys by this file,
-- and they do not need to be — `bookmakerLabel(key)` reconstructs every one of
-- them deterministically at render. Nothing is lost but a spelling.

begin;

create temporary table _bk (legacy text primary key, key text not null) on commit drop;
insert into _bk (legacy, key) values
  ('Bet365','bet365'), ('Betfair SB','betfair_sb_uk'), ('Betfair Exch','betfair_ex_uk'),
  ('William Hill','williamhill'), ('Paddy Power','paddypower'), ('Sky Bet','skybet'),
  ('Coral','coral'), ('Ladbrokes','ladbrokes_uk'), ('Betfred','betfred_uk'),
  ('BoyleSports','boylesports'), ('Betway','betway'), ('BetVictor','betvictor'),
  ('Unibet','unibet_uk'), ('Virgin Bet','virginbet'), ('LeoVegas','leovegas'),
  ('LiveScore Bet','livescorebet'), ('Smarkets','smarkets'), ('Matchbook','matchbook'),
  ('Pinnacle','pinnacle'), ('Betsson','betsson'), ('Betano','betano'),
  ('MarathonBet','marathonbet'), ('Superbet','superbet'), ('Dafabet','dafabet'),
  ('1xBet','1xbet'), ('SBO','sbo'), ('Casumo','casumo'), ('Grosvenor','grosvenor'),
  ('Coolbet','coolbet');

update value_signals v set bookmaker = b.key from _bk b where v.bookmaker = b.legacy;
update recommendations r set bookmaker = b.key from _bk b where r.bookmaker = b.legacy;
update bet_of_day_candidates d set bookmaker = b.key from _bk b where d.bookmaker = b.legacy;

update computed_values c set best_home_book = b.key from _bk b where c.best_home_book = b.legacy;
update computed_values c set best_draw_book = b.key from _bk b where c.best_draw_book = b.legacy;
update computed_values c set best_away_book = b.key from _bk b where c.best_away_book = b.legacy;
update computed_values c set over_book      = b.key from _bk b where c.over_book      = b.legacy;
update computed_values c set under_book     = b.key from _bk b where c.under_book     = b.legacy;
update computed_values c set btts_yes_book  = b.key from _bk b where c.btts_yes_book  = b.legacy;
update computed_values c set btts_no_book   = b.key from _bk b where c.btts_no_book   = b.legacy;

-- ASSERT, rather than eyeball. Anything still carrying an upper-case letter or
-- a space in these columns is a label the closed map did not know about, and
-- this must fail loudly rather than leave a half-normalised column behind.
do $$
declare leftover int;
begin
  select count(*) into leftover from value_signals where bookmaker ~ '[A-Z ]';
  if leftover > 0 then
    raise exception '091: % value_signals row(s) still hold an unmapped label', leftover;
  end if;

  select count(*) into leftover from recommendations where bookmaker ~ '[A-Z ]';
  if leftover > 0 then
    raise exception '091: % recommendations row(s) still hold an unmapped label', leftover;
  end if;

  select count(*) into leftover from bet_of_day_candidates where bookmaker ~ '[A-Z ]';
  if leftover > 0 then
    raise exception '091: % bet_of_day_candidates row(s) unmapped', leftover;
  end if;

  select count(*) into leftover from computed_values
   where best_home_book ~ '[A-Z ]' or best_draw_book ~ '[A-Z ]' or best_away_book ~ '[A-Z ]'
      or over_book ~ '[A-Z ]' or under_book ~ '[A-Z ]'
      or btts_yes_book ~ '[A-Z ]' or btts_no_book ~ '[A-Z ]';
  if leftover > 0 then
    raise exception '091: % computed_values row(s) still hold an unmapped label', leftover;
  end if;
end $$;

commit;
