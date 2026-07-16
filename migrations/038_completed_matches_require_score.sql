-- 038_completed_matches_require_score.sql
--
-- Bug: "Recent Form" silently dropped games. A match marked status='completed'
-- with NULL goals_home/goals_away carries no result, so fetchTeamForm (which
-- filters out null-goal rows — you can't render a result you don't have) skips
-- it entirely. It is NOT a draw problem: draws (0-0, 1-1) store a real
-- scoreline and render fine. The problem is fixtures stuck 'completed' with no
-- score at all — e.g. England v Ghana (2026-06-23) — which then vanish from
-- form, team stats and ELO.
--
-- Root cause: some earlier path flipped matches to 'completed' before a score
-- was written, and settleFinishedMatches only ever looked at scheduled/live
-- rows, so a scoreless 'completed' row was invisible to settlement forever.
--
-- Two parts, matching the code fix in fetchResults.js:
--   1. Re-open every scoreless 'completed' row so the (now self-healing)
--      settlement pass re-fetches its real result. Past rows are excluded from
--      pre-match pricing (computeValues drops kickoff <= now), so this does not
--      pollute Market Pulse; the settlement pass (fetchResults.js) picks them up
--      and writes the true scoreline — draws included.
--   2. Enforce the invariant going forward: a 'completed' match MUST have both
--      goals. Nothing — no ingest job, admin action, backfill or future code —
--      can ever create a scoreless completed match again.

begin;

-- 1. Re-open scoreless 'completed' rows for settlement.
update public.matches
   set status = 'scheduled',
       result = null
 where status = 'completed'
   and (goals_home is null or goals_away is null);

-- 2. Invariant: completed ⇒ full scoreline present (draws are a real score).
alter table public.matches
  drop constraint if exists matches_completed_requires_score;

alter table public.matches
  add constraint matches_completed_requires_score
  check (status <> 'completed' or (goals_home is not null and goals_away is not null));

commit;
