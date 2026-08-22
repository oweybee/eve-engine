-- 092 — one bookmaker identity, MEMBER-owned tables.
--
-- The second half of 091, held back deliberately. 091 normalised the engine's
-- tables the moment it was written; `bets` and `user_bookmakers` render in a
-- member's OWN ledger and picker, so they waited for a browser that turns a key
-- back into a name to be live. eve-frontend 44ecf60 did the engine surfaces and
-- 3170afe did the portal's — BetLedger's four sites and, more importantly,
-- Breakdowns, which GROUPED by the stored string and would have split one
-- member's record across 'Bet365' and 'bet365' as two bookmakers.
--
-- 13 ROWS. Small enough to state in full, which is what makes it reversible:
--
--   user_bookmakers — 2 rows, ONE member (714ada4e-…), both is_preferred=true,
--                     is_limited=false:  'Bet365' -> bet365
--                                        'Paddy Power' -> paddypower
--   bets — 11 rows, one per member:
--     'Bet365'      -> bet365       4037f3cc 4f4d4d47 57597d4c 5869df75
--                                   606ba463 b20734f3 b3580b6a
--     'Betano'      -> betano       a63fe6c4
--     'Paddy Power' -> paddypower   332cdff9 59540462
--     'SBO'         -> sbo          85dda5fb
--
-- TO REVERSE: set those ids back to the labels above. Nothing else changes,
-- and no row is created or destroyed.
--
-- THE MERGE IS DEFENSIVE, NOT NEEDED TODAY. `user_bookmakers` is keyed
-- (user_id, bookmaker), so a member holding BOTH 'Bet365' and 'bet365' would
-- collide on update. Measured now, nobody does. It is written anyway because
-- the frontend began writing keys at 44ecf60, so a member who taps a chip
-- between that deploy and this migration creates exactly that pair — and the
-- window is real, not hypothetical. A collision keeps the row that is
-- PREFERRED, and keeps is_limited if either row carried it: is_limited records
-- that a bookmaker has restricted someone's account, which is the most
-- sensitive fact in the dataset and must never be lost to a tidy-up.

begin;

create temporary table _bk (legacy text primary key, key text not null) on commit drop;
insert into _bk (legacy, key) values
  ('Bet365','bet365'), ('Paddy Power','paddypower'), ('SBO','sbo'), ('Betano','betano'),
  ('Betfair SB','betfair_sb_uk'), ('Betfair Exch','betfair_ex_uk'),
  ('William Hill','williamhill'), ('Sky Bet','skybet'), ('Coral','coral'),
  ('Ladbrokes','ladbrokes_uk'), ('Betfred','betfred_uk'), ('BoyleSports','boylesports'),
  ('Betway','betway'), ('BetVictor','betvictor'), ('Unibet','unibet_uk'),
  ('Virgin Bet','virginbet'), ('LeoVegas','leovegas'), ('LiveScore Bet','livescorebet'),
  ('Smarkets','smarkets'), ('Matchbook','matchbook'), ('Pinnacle','pinnacle'),
  ('MarathonBet','marathonbet'), ('1xBet','1xbet'), ('Dafabet','dafabet'),
  ('Superbet','superbet'), ('Casumo','casumo'), ('Grosvenor','grosvenor'),
  ('Coolbet','coolbet'), ('Betsson','betsson');

-- 1. Fold any legacy row into an existing canonical one for the same member.
--    is_preferred is OR-ed and is_limited is OR-ed: a restriction recorded on
--    either spelling survives the merge.
update user_bookmakers t set
  is_preferred = coalesce(t.is_preferred, false) or coalesce(l.is_preferred, false),
  is_limited   = coalesce(t.is_limited,   false) or coalesce(l.is_limited,   false)
from user_bookmakers l
join _bk b on l.bookmaker = b.legacy
where t.user_id = l.user_id and t.bookmaker = b.key;

delete from user_bookmakers l
using _bk b, user_bookmakers t
where l.bookmaker = b.legacy and t.user_id = l.user_id and t.bookmaker = b.key;

-- 2. Rename the rest.
update user_bookmakers u set bookmaker = b.key from _bk b where u.bookmaker = b.legacy;
update bets           t set bookmaker = b.key from _bk b where t.bookmaker = b.legacy;

do $$
declare leftover int;
begin
  select count(*) into leftover from user_bookmakers where bookmaker ~ '[A-Z ]';
  if leftover > 0 then
    raise exception '092: % user_bookmakers row(s) still hold a label', leftover;
  end if;

  select count(*) into leftover from bets where bookmaker ~ '[A-Z ]';
  if leftover > 0 then
    raise exception '092: % bets row(s) still hold a label', leftover;
  end if;

  -- No member may end up with the same book twice.
  select count(*) into leftover from (
    select user_id, bookmaker from user_bookmakers group by 1,2 having count(*) > 1
  ) d;
  if leftover > 0 then
    raise exception '092: % duplicate (user, bookmaker) pair(s)', leftover;
  end if;
end $$;

commit;
