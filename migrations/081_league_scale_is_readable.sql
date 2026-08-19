-- 081_league_scale_is_readable.sql — the cross-league scale, published.
--
-- Migration 077 fitted a per-league offset and 079 gave every upcoming fixture
-- a placement verdict, and NOTHING OUTSIDE THIS DATABASE CAN SEE EITHER. RLS is
-- enabled on `league_strength` and no policy was ever written for it, so the
-- anon role holds SELECT and reads zero rows — the fit is a private fact.
--
-- It should not be. The offsets are fitted model PARAMETERS in exactly the
-- sense `model_calibration.sigma_p` and `disagreement_calibration` are, and
-- both of those are anon-readable already. More to the point, /how-it-works is
-- about to explain that an ELO rating from one league is not comparable to one
-- from another and that we correct it — and this repo's standing rule is that a
-- methodology page states its figures from the table rather than typing them,
-- because a re-fit makes a typed number false with nobody to notice. The fit
-- workflow is scheduled; these numbers WILL move.
--
-- READ-ONLY, AND NOT A LOOSENING. `anon` already held SELECT on the table (the
-- grant is table-level and predates the RLS); what was missing was a policy to
-- admit the rows. Writes are untouched and remain impossible from the client —
-- migration 07x's revocation stands, and this adds no INSERT/UPDATE/DELETE
-- policy of any kind. There is nothing member-specific in the table: it is 38
-- rows of league-level model parameters, the same class of public fact as a
-- published sigma.
--
-- THE VIEW EXISTS BECAUSE THE NAME DOES NOT LIVE IN THE TABLE. `league_strength`
-- is keyed by `league_id`; a reader needs "Bundesliga (Germany)". `leagues` is
-- already publicly readable ("public read leagues", USING true), so the join
-- adds no exposure. security_invoker = on, without exception — a plain view runs
-- with its superuser owner's rights and that is precisely the hole four views
-- had until migration 059.
--
-- THE COVERAGE FUNCTION IS SECURITY DEFINER, DELIBERATELY, AND RETURNS COUNTS
-- ONLY. `fixture_placement` sits on `matches`, which migration 047 gates on
-- `current_tier() <> 'free'` — so an invoker-rights aggregate would count the
-- five-row free preview and report it as the whole book. That is the standing
-- "SECURITY DEFINER aggregate so a metered surface can state a true total" this
-- project has wanted since the tier gate landed, in its narrowest possible
-- form: four integers, no fixture id, no club name, no kickoff. A caller learns
-- how many fixtures the scale can place and how many it refuses, which is the
-- claim the methodology page is making, and learns nothing about WHICH.
-- search_path is pinned so the definer rights cannot be aimed at another schema.

begin;

-- ── the offsets are readable ───────────────────────────────────────────────
drop policy if exists league_strength_public_read on public.league_strength;
create policy league_strength_public_read
  on public.league_strength for select
  to anon, authenticated
  using (true);

comment on table public.league_strength is
  'Per-league ELO offsets, fitted to outcomes over cross-league fixtures. '
  'Publicly readable since migration 081 — fitted model parameters, the same '
  'class of fact as model_calibration.sigma_p. Never client-writable.';

-- ── the scale, with the names a reader needs ───────────────────────────────
drop view if exists public.league_scale;
create view public.league_scale with (security_invoker = on) as
select l.id            as league_id,
       l.name,
       l.country,
       ls.status,
       ls.theta_elo,
       ls.se_elo,
       ls.ci_lo,
       ls.ci_hi,
       ls.n_obs,
       ls.identified_by,
       ls.model,
       ls.version,
       ls.fitted_at
from public.league_strength ls
join public.leagues l on l.id = ls.league_id;

comment on view public.league_scale is
  'league_strength joined to its league name. security_invoker so the policy '
  'above is what admits the rows, never this view''s owner. See migration 081.';

grant select on public.league_scale to anon, authenticated;

-- ── how far the scale reaches, as counts ───────────────────────────────────
create or replace function public.league_scale_coverage()
returns table (
  placed_by_competition bigint,
  placed_by_league      bigint,
  placed_by_opponents   bigint,
  unplaced              bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*) filter (where status = 'placed' and basis = 'competition'),
         count(*) filter (where status = 'placed' and basis = 'league'),
         count(*) filter (where status = 'placed' and basis = 'opponents'),
         count(*) filter (where status = 'unplaced')
  from public.fixture_placement;
$$;

comment on function public.league_scale_coverage() is
  'Counts only — how many upcoming fixtures the ELO scale places, by what, and '
  'how many it refuses. SECURITY DEFINER because fixture_placement sits on '
  'matches, which the tier gate caps: an invoker-rights count would report the '
  'free preview as the whole book. Returns no fixture identity of any kind.';

revoke execute on function public.league_scale_coverage() from public;
grant execute on function public.league_scale_coverage() to anon, authenticated;

-- ── assert, rather than assume ─────────────────────────────────────────────
do $$
declare
  n_scale int;
  n_fitted int;
begin
  select count(*) into n_scale from public.league_scale;
  select count(*) into n_fitted from public.league_scale
   where status in ('reference', 'fitted') and theta_elo is not null;

  if n_scale = 0 then
    raise exception '081: league_scale is empty — the join dropped every row';
  end if;
  if n_fitted = 0 then
    raise exception '081: no league carries an offset — the fit has not run';
  end if;

  -- The reference league holds the origin by construction (077). If it ever
  -- stops being exactly zero the offsets have been rewritten by something that
  -- did not re-pin them, and every cross-league forecast is shifted.
  if exists (select 1 from public.league_scale
              where status = 'reference' and theta_elo is distinct from 0) then
    raise exception '081: the reference league is not pinned at zero';
  end if;

  raise notice '081: league_scale has % rows, % of them on the scale',
    n_scale, n_fitted;
end $$;

commit;
