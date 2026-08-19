-- 082_elo_forecasts.sql — the ELO 1X2 forecast, written by the engine.
--
-- /api/match-card has served `model: { available: false }` since it was built,
-- and its header explains why at length: production DIXON_COLES inverts the
-- market's own de-vigged price, so its 1X2 output IS the market number and
-- printing it as a forecast would be the fabrication the architecture exists to
-- prevent. That reasoning is unchanged and this table does not touch it.
--
-- What changed is that a genuine forecast now exists. The ELO ladder is built
-- from results alone (migration 076 corpus, computeElo.js), the draw model was
-- fitted to realised 1X2 outcomes with no market input (migration 075,
-- lib/eloProbs.js), and migration 077 put the leagues on one scale so two clubs
-- from different pools can be compared at all. Nothing in any of it has ever
-- seen a price.
--
-- THE ENGINE WRITES THE VERDICT, THE BROWSER READS IT. This is the shape E4
-- settled on 6 Aug: every score is computed once, where the model is, and
-- stored — rather than each surface deriving its own from a formula it keeps in
-- step by hand. The alternative here was to compute the vector inside the Next
-- route, which would put a third copy of the draw model in the product (SQL,
-- eve-engine, browser) with nothing keeping them equal.
--
-- A WITHHELD ROW IS STILL A ROW, AND IT SAYS WHY. `status` is 'forecast' or
-- 'withheld'; a withheld row carries `withheld_code` and a `withheld_reason`
-- naming the club that could not be placed. Same shape as
-- `value_signals.score_withheld_reason`, `/api/inplay`'s source block and
-- `fixture_placement` itself — "we have no forecast for this" and "nobody asked
-- about this fixture" are different facts, and three features in this product
-- shipped silently dead when they were confused.
--
-- THE CHECK CONSTRAINT IS THE POINT. A probability vector may exist only on a
-- 'forecast' row, all three legs must be present together, and they must sum to
-- one. A partially-written vector is the failure mode that reaches a reader as
-- a confident number: `Number(null)` is 0, and a 0% home probability against a
-- real price is a maximal disagreement rather than a missing one.

begin;

-- ── the placement view publishes the keys it already computes ──────────────
-- Appended at the END. `create or replace view` refuses a rename or a reorder,
-- and the writer needs the canonical keys to look up a rating and an offset —
-- resolving them a second time in JS is how two spellings of the same club
-- appear on one page.
create or replace view fixture_placement with (security_invoker = on) as
with domestic as (
  select id from leagues
  where country not in ('World', 'International', 'Europe', 'Africa', 'South America')
    and name <> 'League Cup'
),
fx as (
  select m.id as match_id, m.kickoff_at, m.league_id,
         (m.league_id in (select id from domestic)) as competition_is_domestic_league,
         kh.canonical_key as home_key, ka.canonical_key as away_key,
         kh.name as home_name, ka.name as away_name
  from matches m
  join team_key_map kh on kh.team_id = m.home_team_id
  join team_key_map ka on ka.team_id = m.away_team_id
  where m.status <> 'completed' and m.kickoff_at > now()
)
select fx.match_id, fx.kickoff_at, fx.league_id,
       fx.home_name, fx.away_name,
       fx.competition_is_domestic_league,
       case
         when fx.competition_is_domestic_league then 'placed'
         when hs.is_usable and as2.is_usable    then 'placed'
         else 'unplaced'
       end as status,
       case
         when fx.competition_is_domestic_league then 'competition'
         when hs.is_usable and as2.is_usable
           then case when hs.source = 'league' and as2.source = 'league'
                     then 'league' else 'opponents' end
         else null
       end as basis,
       case
         when fx.competition_is_domestic_league or (hs.is_usable and as2.is_usable) then null
         else nullif(concat_ws('; ',
           case when hs.canonical_key is null
                then fx.home_name || ' has no place on the ELO scale — no domestic league in the corpus and no rated opponent'
                when not hs.is_usable
                then fx.home_name || ' is placed only by ' || hs.n_rated_opponents || ' rated opponent(s), under the ' || hs.min_rated_opponents || ' required'
           end,
           case when as2.canonical_key is null
                then fx.away_name || ' has no place on the ELO scale — no domestic league in the corpus and no rated opponent'
                when not as2.is_usable
                then fx.away_name || ' is placed only by ' || as2.n_rated_opponents || ' rated opponent(s), under the ' || as2.min_rated_opponents || ' required'
           end), '')
       end as unplaced_reason,
       fx.home_key,
       fx.away_key
from fx
left join team_scale hs  on hs.canonical_key  = fx.home_key
left join team_scale as2 on as2.canonical_key = fx.away_key;

-- ── the forecast ───────────────────────────────────────────────────────────
create table if not exists public.elo_forecasts (
  match_id        uuid primary key references public.matches(id) on delete cascade,
  model           text        not null default 'ELO',
  version         text        not null default 'v1',
  status          text        not null,

  p_home          double precision,
  p_draw          double precision,
  p_away          double precision,

  -- The ADJUSTED ratings actually used, and the offsets that adjusted them.
  -- Stored so a reader can reconstruct the vector from the row rather than
  -- taking it on trust, and so a re-fit of the offsets is visible as a change
  -- in the inputs rather than only in the output.
  elo_home        double precision,
  elo_away        double precision,
  theta_home      double precision,
  theta_away      double precision,
  cross_league    boolean,
  basis           text,

  withheld_code   text,
  withheld_reason text,

  computed_at     timestamptz not null default now(),

  constraint elo_forecasts_status_check
    check (status in ('forecast', 'withheld')),

  -- A vector exists only on a forecast row, and only whole.
  constraint elo_forecasts_vector_iff_forecast
    check (
      (status = 'forecast') =
      (p_home is not null and p_draw is not null and p_away is not null)
    ),

  -- And it is a probability vector. Written as a tolerance rather than
  -- equality because these are doubles; 1e-9 is far tighter than any rounding a
  -- caller does and far looser than float noise.
  constraint elo_forecasts_vector_sums_to_one
    check (
      status <> 'forecast'
      or (abs((p_home + p_draw + p_away) - 1) < 1e-9
          and p_home > 0 and p_draw >= 0 and p_away > 0)
    ),

  -- A withheld row must say why. Silence is what this table exists to end.
  constraint elo_forecasts_withheld_says_why
    check (status <> 'withheld' or withheld_code is not null)
);

comment on table public.elo_forecasts is
  'One ELO 1X2 forecast per upcoming fixture, or a named refusal. Written by '
  'computeEloForecasts.js; read by /api/match-card. Fitted to results, never '
  'to a price. See migration 082.';

create index if not exists elo_forecasts_computed_at_idx
  on public.elo_forecasts (computed_at desc);

-- ── readable exactly when its fixture is ───────────────────────────────────
-- NOT `using (true)`. A forecast is a model claim about a specific fixture, and
-- `matches` is gated by migration 047 — so a blanket policy would serve a
-- forecast for a fixture the caller is not allowed to see, which is precisely
-- what `board_signals` did until migration 059 turned it into a
-- security_invoker view. Deriving the condition from `matches` rather than
-- restating 047's rule means this cannot drift out of step with it.
alter table public.elo_forecasts enable row level security;

drop policy if exists elo_forecasts_follows_its_fixture on public.elo_forecasts;
create policy elo_forecasts_follows_its_fixture
  on public.elo_forecasts for select
  to anon, authenticated
  using (exists (select 1 from public.matches m where m.id = match_id));

comment on policy elo_forecasts_follows_its_fixture on public.elo_forecasts is
  'Readable iff the caller can read the fixture. Inherits migration 047''s tier '
  'gate by reference rather than restating it.';

-- Read only. The writer is the service role, which bypasses RLS.
grant select on public.elo_forecasts to anon, authenticated;
revoke insert, update, delete, truncate on public.elo_forecasts from anon, authenticated;

-- ── assert, rather than assume ─────────────────────────────────────────────
do $$
declare
  probe_match uuid;
begin
  -- The whole reason the view was rewritten. If the keys are missing the writer
  -- silently resolves its own and two spellings of a club reach one page.
  if not exists (
    select 1 from information_schema.columns
     where table_name = 'fixture_placement' and column_name = 'home_key'
  ) then
    raise exception '082: fixture_placement did not gain home_key';
  end if;

  -- Probe the constraints rather than reasoning about them, AGAINST A REAL
  -- FIXTURE. A probe on a made-up match_id would trip the foreign key, and
  -- catching that alongside check_violation gives a test that passes whether or
  -- not the constraint it names exists — the shape CLAUDE.md calls "a test that
  -- never ran". Each probe undoes itself: the three refusals never commit a row, and
  -- the acceptance deletes the one it wrote.
  select id into probe_match from public.matches limit 1;
  if probe_match is null then
    raise exception '082: no fixture to probe the constraints against';
  end if;

  begin
    insert into public.elo_forecasts (match_id, status, p_home, p_draw)
    values (probe_match, 'forecast', 0.5, 0.3);
    raise exception '082: a half-written vector was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.elo_forecasts (match_id, status, p_home, p_draw, p_away)
    values (probe_match, 'forecast', 0.5, 0.3, 0.9);
    raise exception '082: a vector summing to 1.7 was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.elo_forecasts (match_id, status) values (probe_match, 'withheld');
    raise exception '082: a withheld row with no reason was accepted';
  exception when check_violation then null;
  end;

  -- And the shape the writer actually produces is ACCEPTED — otherwise the
  -- three refusals above prove only that everything is rejected.
  begin
    insert into public.elo_forecasts
      (match_id, status, p_home, p_draw, p_away, elo_home, elo_away, basis)
    values (probe_match, 'forecast', 0.45, 0.27, 0.28, 1600, 1550, 'competition');
    delete from public.elo_forecasts where match_id = probe_match;
  exception when others then
    raise exception '082: a well-formed forecast was REJECTED (%)', sqlerrm;
  end;

  raise notice '082: elo_forecasts is ready';
end $$;

commit;
