-- 110 — the dedupe trigger silently discarded EVERY in-play signal
--
-- APPLIED AND VERIFIED IN PRODUCTION, 26 Aug 2026. Verified by what happened
-- next rather than by the probes alone: within four minutes of the function
-- being replaced, the scheduled in-play run wrote the FIRST THREE ROWS this
-- product has ever held with phase = 'inplay' — Lyon v Fenerbahçe (away 1.181,
-- +9.3%, 59', 0-2), Viking v Dinamo Zagreb (home 1.090, +3.9%, 57', 3-1) and
-- Celje v Slovan Bratislava (draw 2.050, +10.0%, 59', 1-1). All three carry a
-- null mxs, which is the score trigger still doing its job.
--
-- THE FIFTH GATE, AND THE ONE THAT WOULD HAVE STOPPED EVERYTHING ANYWAY.
-- Four were already found and opened: the RESTRICTIVE RLS policy, the score
-- trigger, lib/publication in the browser, and fetchRecentSignals' publication
-- filter (the one that made the Telegram branch unreachable). This is the
-- fifth, it sits underneath all of them, and it is the reason
-- `value_signals` has never held a single row with `phase = 'inplay'`.
--
-- `merge_duplicate_value_signal()` is a BEFORE INSERT trigger and it opens:
--
--     IF NEW.kickoff_at IS NOT NULL AND NEW.detected_at > NEW.kickoff_at THEN
--       RETURN NULL;
--     END IF;
--
-- `detected_at > kickoff_at` IS THE DEFINITION OF IN-PLAY. So every in-play
-- signal the engine has ever produced was discarded here, by construction.
--
-- AND IT IS SILENT, WHICH IS WHY IT SURVIVED FIVE INVESTIGATIONS. Returning
-- NULL from a BEFORE INSERT trigger is not an error: Postgres drops the row,
-- PostgREST answers 201, and `insertModelSignals` sees `error === null` and
-- reports success. On 26 Aug 2026 the loop logged
--
--     [inplay] win-prob: 9/9 live match(es) have a baseline; 1 candidate(s)
--     [inplay] win-prob signals: 1
--
-- while the table gained nothing. A guard that reports success is the shape
-- this repo has paid for repeatedly ("BEING KILLED IS NOT STOPPING", the
-- CHECK constraint of 108, the census that shipped dead) and this is its
-- purest form: no exception, no log line, no trace of any kind.
--
-- MEASURED BEFORE THE FIX: of 1,266 rows in `value_signals`, the number with
-- `detected_at > kickoff_at` is **ZERO**. Not a small number — none, ever.
-- That is the trigger's fingerprint, and it is the assertion at the foot of
-- this file inverted.
--
-- WHAT THE GUARD IS FOR, AND WHY IT STAYS. The PRE-MATCH engine must not write
-- a signal for a match that has already started: a post-kickoff price is not
-- the pre-match market and its CLV would be measured against a line that has
-- already closed. computeValues.js refuses those at the source and this is the
-- backstop under it. So the guard is kept in full for `phase = 'prematch'`
-- and for legacy rows, and exempts ONLY the phase whose entire definition is
-- that it fires after kickoff.
--
-- IT IS NOT A LOOSENING. An in-play row is measured by its own
-- `performance_summary` row (`singleton_key = 'inplay'`), carries NULL for
-- both CLV columns by `settle_match_signals()`'s own rule, and is still
-- governed by every one of the four gates above. Nothing that was withheld
-- becomes publishable here; what changes is that the engine stops throwing
-- its own work away before any of them are consulted.
--
-- The dedupe half is deliberately untouched: an in-play signal that repeats
-- at the same price still merges into the existing row and bumps
-- `detection_count`, which is what stops a 60-second loop writing the same
-- claim sixty times.
--
-- REVERT:
--   Restore the original body by removing the `COALESCE(NEW.phase,...)` clause
--   from the first IF, i.e. return it to
--     IF NEW.kickoff_at IS NOT NULL AND NEW.detected_at > NEW.kickoff_at THEN
--   Doing so re-closes in-play entirely and silently.

begin;

create or replace function merge_duplicate_value_signal()
returns trigger
language plpgsql
as $$
DECLARE
  v_last_id   uuid;
  v_last_odds numeric;
BEGIN
  -- POST-KICKOFF ROWS ARE REFUSED FOR PRE-MATCH ONLY.
  -- `detected_at > kickoff_at` is the definition of in-play, so applying this
  -- to every phase discarded every in-play signal ever produced — silently,
  -- because RETURN NULL in a BEFORE INSERT trigger is not an error. See the
  -- file header for the measurement.
  IF COALESCE(NEW.phase, 'prematch') <> 'inplay'
     AND NEW.kickoff_at IS NOT NULL
     AND NEW.detected_at > NEW.kickoff_at THEN
    RETURN NULL;
  END IF;

  SELECT id, detected_odds
    INTO v_last_id, v_last_odds
  FROM value_signals
  WHERE match_id = NEW.match_id
    AND outcome  = NEW.outcome
    AND COALESCE(market, 'h2h') = COALESCE(NEW.market, 'h2h')
    AND COALESCE(model_architecture, 'MARKET_CONSENSUS')
      = COALESCE(NEW.model_architecture, 'MARKET_CONSENSUS')
  ORDER BY detected_at DESC
  LIMIT 1;

  IF FOUND THEN
    IF v_last_odds IS NOT DISTINCT FROM NEW.detected_odds
       OR (v_last_odds IS NOT NULL AND NEW.detected_odds IS NOT NULL
           AND abs(v_last_odds - NEW.detected_odds) < 0.001) THEN
      UPDATE value_signals
      SET detection_count = detection_count + 1,
          last_seen_at    = now(),
          closing_odds    = COALESCE(NEW.closing_odds, closing_odds),
          clv             = COALESCE(NEW.clv, clv),
          result          = CASE WHEN NEW.result IS DISTINCT FROM 'pending'
                                 THEN NEW.result ELSE result END,
          kickoff_at      = COALESCE(NEW.kickoff_at, kickoff_at)
      WHERE id = v_last_id;
      RETURN NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ── Probes. Each inserts inside a savepoint that always raises, so this file
-- ── writes nothing whatever it proves.
do $probe$
declare
  v_match uuid;
  v_ko    timestamptz;
  v_in    int := 0;
  v_pre   int := 0;
begin
  select id, kickoff_at into v_match, v_ko
    from matches where kickoff_at < now() order by kickoff_at desc limit 1;
  if v_match is null then raise exception 'probe: no settled match to test against'; end if;

  -- 1. An IN-PLAY row detected after kickoff must now be KEPT. The match is
  --    the most recently kicked-off one, so `v_ko + 40 minutes` is genuinely
  --    after kickoff and the guard under test is the one being exercised.
  begin
    insert into value_signals (match_id, market, outcome, detected_odds, detected_edge,
      bookmaker, kickoff_at, detected_at, model_architecture, signal_category, phase)
    values (v_match, 'h2h', 'home', 1.55, 0.043, 'apifootball_live',
            v_ko, v_ko + interval '40 minutes', 'INPLAY_DIXON_COLES', 'prime', 'inplay');
    -- Scoped to the row this probe just inserted, NOT to the architecture:
    -- once the fix is live there are real in-play rows on live fixtures, and a
    -- broader count makes the probe report the world rather than itself. The
    -- first version counted by architecture and read 2 against an expected 1 on
    -- the very first live run.
    select count(*) into v_in from value_signals
      where match_id = v_match and model_architecture = 'INPLAY_DIXON_COLES'
        and outcome = 'home' and detected_odds = 1.55;
    raise exception 'rollback probe 1';
  exception when others then
    if sqlerrm <> 'rollback probe 1' then raise exception 'probe 1 errored: %', sqlerrm; end if;
  end;
  if v_in <> 1 then
    raise exception 'probe 1: an in-play row detected after kickoff was still discarded (found %)', v_in;
  end if;

  -- 2. A PRE-MATCH row detected after kickoff must STILL be discarded.
  begin
    insert into value_signals (match_id, market, outcome, detected_odds, detected_edge,
      bookmaker, kickoff_at, detected_at, model_architecture, signal_category, phase)
    values (v_match, 'h2h', 'draw', 4.10, 0.031, 'bet365',
            v_ko, v_ko + interval '40 minutes', 'DIXON_COLES', 'prime', 'prematch');
    select count(*) into v_pre from value_signals
      where match_id = v_match and outcome = 'draw' and model_architecture = 'DIXON_COLES'
        and detected_at > kickoff_at;
    raise exception 'rollback probe 2';
  exception when others then
    if sqlerrm <> 'rollback probe 2' then raise exception 'probe 2 errored: %', sqlerrm; end if;
  end;
  if v_pre <> 0 then
    raise exception 'probe 2: the pre-match post-kickoff guard was LOOSENED (found %)', v_pre;
  end if;

  raise notice 'probes passed: in-play kept, pre-match still refused';
end $probe$;

-- The guard survived in the function body — asserted on the source rather than
-- on intent, so a future edit that drops the phase clause fails here.
do $$
begin
  if position('inplay' in pg_get_functiondef('merge_duplicate_value_signal'::regproc)) = 0 then
    raise exception 'the phase exemption is missing from the trigger body';
  end if;
  if position('detected_at > NEW.kickoff_at' in pg_get_functiondef('merge_duplicate_value_signal'::regproc)) = 0 then
    raise exception 'the post-kickoff guard was removed entirely — it must remain for pre-match';
  end if;
end $$;

commit;
