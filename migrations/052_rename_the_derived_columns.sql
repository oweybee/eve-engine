-- 052_rename_the_derived_columns.sql
--
-- APPLIED to production 2026-08-06, together with the three Python seeders that
-- read these columns by name — that coupling is why it waited. Verified after:
--   matches with stats_source='datahub_csv' and xg_home not null : 0
--   matches with stats_source='statsbomb'  and xg_home not null : 1,318 (kept)
--   fixture_predictions old column names remaining               : 0
--   matches_no_derived_xg CHECK present                          : yes
--   inplay_baseline.source                                       : market_derived_not_model
--
-- The seeders were handled two different ways, on purpose. seed_team_stats.py
-- aliases the new columns back to the old names IN THE SELECT
-- (xg_created:sot_x035_derived), so every downstream line is untouched.
-- seed_world_cup.py uses select(*), so its rename map keys off the new names.
-- seed_datahub.py — the script that CREATED these values — writes the new names
-- directly, and its header no longer calls them an xG proxy.
--
-- ORIGINAL NOTE FOLLOWS.
-- STAGED, NOT APPLIED. Independent of 048–051; apply in any order relative to
-- them. This one is destructive in a way they are not — it NULLs 35,947 values
-- — so read the whole header before running it, and run it in a branch first.
--
-- §2.2 of the 2026-08-05 implementation brief: rename the lies.
--
-- THE BUG THIS CLOSES IS A NAMING BUG, AND IT IS THE ROOT CAUSE OF EVERYTHING
-- ELSE IN THIS DIRECTORY. A column named after what it was meant to hold, filled
-- with whatever was available when the real source was missing. It happened six
-- times: three in the model architectures (API_PREDICTIVE, MARKET_CONSENSUS,
-- inplay_baseline) and three in the xG columns. The three here are the ones a
-- migration can fix, because they are columns rather than code:
--
--   fixture_predictions.xg_created  = shots on target × 0.35.
--     2,444 of 2,444 joined rows match EXACTLY. Correlation 1.0000. The column
--     holds 24 distinct values, because shots on target is an integer.
--   fixture_predictions.xg_conceded = the same, against.
--   matches.xg_home / xg_away where stats_source='datahub_csv' = the same again.
--     35,947 of 35,947 rows.
--
-- And the one that is real, which is why the fix is surgical rather than a
-- column drop:
--
--   matches.xg_home / xg_away where stats_source='statsbomb' = REAL expected
--     goals. 1,318 rows, 1,071 distinct values. Keep every one of them.
--
-- Anything trained or priced on the fake columns learned that xG is shots on
-- target divided by three, which is a fact about arithmetic and not about
-- football. Renaming rather than dropping keeps the data — shots on target × 0.35
-- is a perfectly good feature under its own name — while making it impossible to
-- reach for it thinking it is something it is not.
--
-- BEFORE YOU APPLY: this renames columns that three Python seeders read and
-- write BY NAME. They are deliberately NOT updated in the commit that stages
-- this file, because until the migration runs they are correct as they stand —
-- changing them first would break every seeding run against the live schema.
-- Change them in the SAME commit that applies the migration. The full list,
-- verified 2026-08-05 (only `fixture_predictions` is affected; the
-- `team_stats_cache` columns of the same name are a different table and must be
-- left alone):
--
--   ensemble/seed_datahub.py:321-322   writes 'xg_created' / 'xg_conceded'
--                                      — this is the seeder that CREATED the
--                                        ×0.35 values in the first place; see
--                                        its own line 15, which documents the
--                                        proxy honestly in a comment while the
--                                        column name hid it
--   ensemble/seed_team_stats.py:53,64  selects fixture_predictions by name
--   ensemble/seed_world_cup.py:60      selects fixture_predictions by name
--
-- Re-grep before applying, since these line numbers will drift:
--   grep -rn "xg_created\|xg_conceded" --include=*.py ensemble/
--
-- The `inplay_baseline.source` relabel in §2.2 is included and is the cheapest
-- honest change in the whole brief: the value 'consensus' becomes
-- 'market_derived_not_model', because that is what it is — the market's own
-- price recombined through a Poisson, with a fixed offset per outcome (home
-- −0.49pp, draw +0.24pp, away +0.23pp, SD 0.42–0.82pp, sign predictable 68–76%
-- of the time). It is the correct DESIGN for an in-play anchor. It was never an
-- opinion, and the column said it was.

begin;

-- ---------------------------------------------------------------------------
-- 1. fixture_predictions — name the proxies as proxies
-- ---------------------------------------------------------------------------

alter table public.fixture_predictions
  rename column xg_created to sot_x035_derived;
alter table public.fixture_predictions
  rename column xg_conceded to sot_against_x035_derived;

comment on column public.fixture_predictions.sot_x035_derived is
  'Shots on target x 0.35. NOT expected goals — verified exact on 2,444 of 2,444 '
  'joined rows, correlation 1.0000, 24 distinct values. Named for what it is so '
  'nothing reaches for it thinking otherwise. Carries no information beyond the '
  'shots-on-target column it is derived from.';
comment on column public.fixture_predictions.sot_against_x035_derived is
  'Shots on target conceded x 0.35. Same derivation, same warning.';

-- ---------------------------------------------------------------------------
-- 2. matches — keep the real xG, remove the manufactured xG
--
--    NOT a rename: the column holds BOTH real StatsBomb values and the ×0.35
--    proxy, distinguished only by stats_source. Renaming would mislabel the
--    1,318 real rows; dropping would lose them. So the fake values go and the
--    real ones stay, and a CHECK makes the state permanent.
-- ---------------------------------------------------------------------------

update public.matches
set xg_home = null, xg_away = null,
    xg_conceded_home = null, xg_conceded_away = null
where stats_source = 'datahub_csv'
  and (xg_home is not null or xg_away is not null
       or xg_conceded_home is not null or xg_conceded_away is not null);

comment on column public.matches.xg_home is
  'REAL expected goals only. Rows sourced from the football-data CSVs carried '
  'shots-on-target x 0.35 here (35,947 of 35,947 exact matches); those were '
  'NULLed by migration 052 and the CHECK below stops them coming back. The '
  'surviving values are StatsBomb.';

-- The constraint, not a trigger: a CHECK cannot be bypassed by a bulk insert
-- that forgets to fire it, and the seeding script (ensemble/seed_datahub.py) is
-- exactly such a bulk insert.
alter table public.matches
  drop constraint if exists matches_no_derived_xg;
alter table public.matches
  add constraint matches_no_derived_xg check (
    stats_source is distinct from 'datahub_csv'
    or (xg_home is null and xg_away is null
        and xg_conceded_home is null and xg_conceded_away is null)
  );

-- ---------------------------------------------------------------------------
-- 3. inplay_baseline — say what the source is
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'inplay_baseline' and column_name = 'source'
  ) then
    update public.inplay_baseline
    set source = 'market_derived_not_model'
    where source = 'consensus';

    execute $c$comment on column public.inplay_baseline.source is
      'market_derived_not_model means the lambdas were inverted out of the consensus '
      'price rather than forecast. That is the correct design for an in-play anchor '
      'and it is not an opinion: measured against the fair market price the gap is a '
      'fixed offset per outcome (home -0.49pp, draw +0.24pp, away +0.23pp), SD '
      '0.42-0.82pp, sign predictable 68-76% of the time.'$c$;
  end if;
end $$;

commit;

-- ============================================================================
-- Verification (§7.6 of the brief)
-- ============================================================================
--
-- Must return 0:
--   select count(*) from matches
--    where stats_source = 'datahub_csv' and xg_home is not null;
--
-- Must return 1,318 (the StatsBomb rows, untouched):
--   select count(*) from matches
--    where stats_source = 'statsbomb' and xg_home is not null;
--
-- The CHECK must refuse this:
--   update matches set xg_home = 1.2 where stats_source = 'datahub_csv' limit 1;
--
-- The proxies must be findable under their honest names, and not under the old:
--   select sot_x035_derived from fixture_predictions limit 1;   -- works
--   select xg_created       from fixture_predictions limit 1;   -- must error
--
-- Nothing should still be labelled a consensus opinion:
--   select source, count(*) from inplay_baseline group by 1;
-- ============================================================================
