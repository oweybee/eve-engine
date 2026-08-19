-- 075_calibration_is_per_model.sql
--
-- ONE ROW SET PER MODEL, AND THE THRESHOLD BELONGS TO THE MODEL.
--
-- `disagreement_calibration` had `gap_bucket` as its whole primary key. That was
-- fine while one model was ever measured and became a trap the moment a second
-- was: ELO's five rows could only have OVERWRITTEN Dixon-Coles's, silently, and
-- the frontend — which selected the table with no model filter — would have
-- served whichever survived to a page captioned with the other one's name.
--
-- WHY A SECOND MODEL EXISTS. The per-match disagreement sentence needs a live
-- forecast and there is none: /api/match-card returns `modelProbs = null`
-- because of 612 computed_values rows written in the seven days to 19 Aug, 43
-- carry a 1X2 model probability — 7%. Elo does exist, is fresh, and covers 968
-- teams, so it is the candidate. It needed its own record, because a record is
-- a property of a model and not of a site.
--
-- HOW ELO WAS MEASURED. `team_elo` holds only CURRENT ratings, so scoring past
-- matches with it is look-ahead bias — the result being predicted is already in
-- the rating. The ladder was replayed instead: 16,480 research fixtures walked
-- in date order applying lib/elo.js (K=30, home advantage 80, default 1500),
-- snapshotting the PRE-match pair. The SQL replay was verified against
-- lib/elo.js over a chained sequence — max deviation 4e-7, which is the
-- rounding on the values compared, not drift.
--
-- Elo gives a two-way expectation, so 1X2 needs a draw split. It was fitted by
-- maximum likelihood on realised results over 7,655 mature fixtures (both teams
-- 30+ games), seasons 2019/20-2022/23, with NO MARKET INPUT — see
-- lib/eloProbs.js. Held-out seasons 2023/24-2025/26 reproduce it.
--
-- AND THE FINDING THAT FORCED THE SECOND COLUMN. Elo's gradient is not
-- Dixon-Coles's:
--
--                 market right   model right   Brier model / market
--     <3pp            45.8%         54.2%        0.1927 / 0.1924
--     3-6pp           41.0%         59.0%        0.1994 / 0.1976
--     6-10pp          47.5%         52.5%        0.2152 / 0.2076
--     10-15pp         53.2%         46.8%        0.2360 / 0.2204
--     15pp+           59.8%         40.2%        0.2696 / 0.2204
--
-- Read the last two columns. The market is ahead on Brier in EVERY bucket and
-- the gap widens monotonically — the same qualitative finding Dixon-Coles gave.
-- But the "who was closer" count says Elo WINS up to 10pp. Both are computed
-- correctly; they measure different things, and under 10pp they point opposite
-- ways. Publishing "we were right 59% of the time" out of the 3-6pp bucket would
-- tell a reader the opposite of what a proper scoring rule says.
--
-- So `min_publishable_gap` is a column, not a constant: 0.06 for DIXON_COLES,
-- which is genuinely TIED under 6pp, and 0.10 for ELO, which is BEHIND. A single
-- site-wide SCORECARD_MIN_GAP would have been correct for whichever model it was
-- written for and wrong for the other.

alter table disagreement_calibration add column if not exists model text;
update disagreement_calibration set model = 'DIXON_COLES' where model is null;
alter table disagreement_calibration alter column model set not null;

alter table disagreement_calibration add column if not exists min_publishable_gap numeric;
update disagreement_calibration set min_publishable_gap = 0.06
  where model = 'DIXON_COLES' and min_publishable_gap is null;
alter table disagreement_calibration alter column min_publishable_gap set not null;

alter table disagreement_calibration drop constraint if exists disagreement_calibration_pkey;
alter table disagreement_calibration add primary key (model, gap_bucket);

comment on table disagreement_calibration is
  'How often the market finished closer to the result than a forecast did, bucketed by how far apart they were. ONE ROW SET PER MODEL — the primary key was gap_bucket alone, which meant a second model''s rows would silently OVERWRITE the first''s rather than sit beside them. Every reader must filter by model.';

comment on column disagreement_calibration.min_publishable_gap is
  'Below this gap the scorecard for this model may not be quoted. It is a PROPERTY OF THE MODEL, not a site-wide constant: DIXON_COLES is tied with the market under 6pp, while ELO wins the closer-count under 10pp while being WORSE on Brier throughout, so quoting its "model right 58%" would state the opposite of what a proper scoring rule says.';

insert into disagreement_calibration
  (model, gap_bucket, gap_min, gap_max, n, market_right_pct, model_right_pct,
   brier_model, brier_market, min_publishable_gap, computed_at) values
  ('ELO','<3pp',    0,    0.03, 11943, 45.8, 54.2, 0.1927, 0.1924, 0.10, now()),
  ('ELO','3-6pp',   0.03, 0.06, 10218, 41.0, 59.0, 0.1994, 0.1976, 0.10, now()),
  ('ELO','6-10pp',  0.06, 0.10,  7414, 47.5, 52.5, 0.2152, 0.2076, 0.10, now()),
  ('ELO','10-15pp', 0.10, 0.15,  4719, 53.2, 46.8, 0.2360, 0.2204, 0.10, now()),
  ('ELO','15pp+',   0.15, null,  4490, 59.8, 40.2, 0.2696, 0.2204, 0.10, now())
on conflict (model, gap_bucket) do update
  set gap_min = excluded.gap_min, gap_max = excluded.gap_max, n = excluded.n,
      market_right_pct = excluded.market_right_pct, model_right_pct = excluded.model_right_pct,
      brier_model = excluded.brier_model, brier_market = excluded.brier_market,
      min_publishable_gap = excluded.min_publishable_gap, computed_at = now();

-- The draw model, as data. lib/eloProbs.js carries the same numbers as a
-- PRE-FETCH FALLBACK and says so; this table is the source of truth.
insert into goal_model_params (model, version, param, value, ci_lo, ci_hi, corpus, n_fixtures, method, notes) values
  ('ELO_1X2','v1','draw_at_parity', 0.26, null, null,
   'research_dc_preds joined to research_match_ratings for team ids: 7,655 mature fixtures (both teams 30+ games), seasons 2019/20-2022/23, results only — no market input at any point',
   7655,
   'maximum likelihood of the realised 1X2 outcome under P(draw) = d0 * exp(-(d/s)^2), d = (elo_home + home_adv) - elo_away',
   'Grid optimum was d0 0.265 / s 380, but the top five points sit within 0.56 loglik over 7,655 fixtures — noise. 0.26 is within 0.27 of the peak and both figures are interpretable (26% draws at parity; 400 is Elo''s own scale constant). Held-out seasons 2023/24-2025/26 reproduce the fit, so two parameters over 7,655 fixtures are not overfitting.'),
  ('ELO_1X2','v1','draw_spread', 400, null, null,
   'same fit', 7655, 'see draw_at_parity',
   'The decay scale in Elo points. Deliberately equal to Elo''s own 400, which the likelihood surface is indifferent to across 380-400.'),
  ('ELO_1X2','v1','home_adv', 80, null, null,
   'not fitted — inherited from lib/elo.js', 0, 'production parity',
   'K=30, home advantage 80, default 1500 are lib/elo.js constants mirroring ensemble/train_supermodel_v2.py. NOT re-fitted here on purpose: the calibration must describe the ladder that actually runs, and team_elo is built with these.')
on conflict (model, version, param) do update
  set value = excluded.value, corpus = excluded.corpus, n_fixtures = excluded.n_fixtures,
      method = excluded.method, notes = excluded.notes, fitted_at = now();

-- Applied and verified in production 19 Aug 2026. Both row sets present and
-- disjoint; the frontend filters by model and reads the bar off the rows.
