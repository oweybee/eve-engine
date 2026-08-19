# Elo as a second forecast, and its own record

**19 Aug 2026.** The per-match disagreement sentence needs a live forecast. There
isn't one — of 612 `computed_values` rows written in the seven days to 19 Aug,
**43 carry a 1X2 model probability (7%)**, and the BTTS figure with better
coverage is built by `shrinkToMarket()`, so it is partly the market's own number.

Elo does exist, is fresh, and covers 968 teams. This is what it can and cannot do.

---

## 1. The trap that had to be avoided first

`team_elo` stores only the **current** rating. Scoring a match from March with
today's rating is look-ahead bias — that result is already inside the number, and
the calibration would come out flatteringly good for a reason that has nothing to
do with forecasting.

So the ladder was **replayed**: 16,480 research fixtures walked in date order,
applying `lib/elo.js` (K=30, home advantage 80, default 1500), snapshotting the
**pre-match** pair for each fixture. Verified against `lib/elo.js` over a chained
sequence: **max deviation 4e-7**, which is the rounding on the compared values.

## 2. The draw model

Elo yields a two-way expectation `E`; 1X2 needs three numbers.

    d  = (eloHome + homeAdv) - eloAway
    E  = 1 / (1 + 10^(-d/400))
    pD = drawAtParity · exp(-(d / drawSpread)²)
    pH = E - pD/2
    pA = 1 - E - pD/2

Built so **`pH + pD/2 === E` exactly** — the draw model decides how much sits in
the middle, never where the centre of mass is. `engine.eloprobs.test.js` pins it
across a 700-point grid at 1e-12.

**Fitted to outcomes, never to a price.** Maximum likelihood on realised 1X2
results, 7,655 mature fixtures (both teams 30+ games), seasons 2019/20–2022/23.
No market input anywhere in the fit.

- Grid optimum **d0 0.265 / s 380**; shipped **0.26 / 400**. The top five grid
  points sit within **0.56 loglik over 7,655 fixtures** — noise — and the shipped
  pair is within 0.27 of the peak while being interpretable (26% draws at parity;
  400 is Elo's own scale).
- **Held out** seasons 2023/24–2025/26 reproduce it: Brier 0.2118 in-fit against
  0.2118 held out. Two parameters over 7,655 fixtures are not overfitting.

Parameters live in `goal_model_params`; `lib/eloProbs.js` carries them only as a
labelled pre-fetch fallback.

## 3. Elo against the market

12,928 fixtures / 38,784 selections with a Shin-de-vigged Pinnacle close.

| | Elo | market |
|---|---|---|
| Brier (held out) | 0.21179 | **0.20283** |
| log-loss (held out) | 0.61438 | **0.59248** |

**Elo is a clearly weaker forecaster than the market** — and weaker than
Dixon-Coles was, which fought it to a near-draw (0.2013 vs 0.2010). Expected: Elo
sees only results, no goal detail.

## 4. The gradient, and the column it forced

| gap | n | market right | model right | Brier model | Brier market |
|---|---|---|---|---|---|
| <3pp | 11,943 | 45.8% | **54.2%** | 0.1927 | **0.1924** |
| 3-6pp | 10,218 | 41.0% | **59.0%** | 0.1994 | **0.1976** |
| 6-10pp | 7,414 | 47.5% | **52.5%** | 0.2152 | **0.2076** |
| 10-15pp | 4,719 | **53.2%** | 46.8% | 0.2360 | **0.2204** |
| 15pp+ | 4,490 | **59.8%** | 40.2% | 0.2696 | **0.2204** |

Read the last two columns: **the market is ahead on Brier in every bucket**, and
the penalty grows monotonically — +0.0003, +0.0018, +0.0076, +0.0156, **+0.0492**.
Same qualitative finding as Dixon-Coles.

Now read the middle two: **the closer-count says Elo wins up to 10pp.**

Both are computed correctly. They measure different things, and below 10pp they
**point opposite ways** — the closer-count rewards a forecast for being nearer
more often even when it is wrong by more when it is wrong. Quoting "we were right
59% of the time" from the 3-6pp bucket would tell a reader the opposite of what a
proper scoring rule says.

Hence `min_publishable_gap` is a **column, not a constant**: **0.06** for
Dixon-Coles, which is genuinely tied under 6pp; **0.10** for Elo, which is behind.
A site-wide `SCORECARD_MIN_GAP` would be right for whichever model it was written
for and wrong for the other.

Held-out seasons reproduce the whole table (45.9 / 42.0 / 48.7 / 53.1 / 58.0).

## 5. What this does and does not license

- **It does license** an Elo-backed per-match sentence **at gaps of 10pp or more**,
  where the two metrics agree and the market's Brier lead is unambiguous.
- **It does not license** presenting Elo as competitive with the market. It is
  behind everywhere, and the honest sentence is always the market's.
- **It does not license** a bet. This is accuracy, not profit — the two came apart
  decisively in `docs/ANCHOR_INDEPENDENCE.md` §4.
- **Coverage is now measured, and it is the binding constraint.** See §6.

## 6. Coverage — the backfill ran, and it moved the binding constraint

This section was written on the pre-backfill database and said the fix was a
backfill rather than a model change. The backfill ran the same day
(`backfill-fixtures.yml` run 32287324462, seasons 2022-2026, all forty tracked
leagues, 18:26-18:30 UTC 19 Aug, success). It is worth keeping both readings,
because the *shape* of the shortfall changed and only one of the two constraints
was ever fixable this way.

**What the backfill did.** Completed matches **40,311 -> 92,491**. The thin
leagues filled to the same depth as the big five, all the way back to 2022:

| league | completed before | after |
|---|---|---|
| Championship (England) | 12 | **2,240** |
| League One | 12 | **2,240** |
| League Two | 12 | **2,240** |
| National League | 24 | **2,250** |
| Serie B (Italy) | **0** | **1,559** |
| Segunda Division (Spain) | 11 | **1,883** |
| Major League Soccer | 284 | **2,356** |
| Super Lig (Turkey) | 9 | **1,378** |

Every one of the 92,491 completed rows carries a `result` in
(`home`,`draw`,`away`) and both team foreign keys, so all of them are ELO-eligible
-- `computeElo` walks exactly this set.

**What it will do to the ladder.** The rebuild is self-gated at
`ELO_REFRESH_HOURS=6` and had last run at 15:19 UTC, so the figures below are the
ladder *implied by the completed set*, computed with `computeElo`'s own
normalisation (lowercase, strip non-alphanumeric) rather than read off `team_elo`:

| | ladder now | after rebuild |
|---|---|---|
| teams rated | 968 | **1,314** |
| teams past 10 games | 430 | **1,089** |
| teams past 30 games | **226** | **948** |

On the window that matters -- the next 48 hours, which is as far ahead as prices
exist at all -- 72 fixtures, 67 priced by 3+ books, and **both teams past 30
games on 53 of them: 79.1%, against 1 (1.5%) before.** Rating maturity stops
being the binding constraint.

**Why it is still not 100%, and the answer is three named causes.** All 19
remaining gaps in that 48-hour window, enumerated:

1. **No price yet -- 5 fixtures.** This is a HORIZON, not a defect, and the
   earlier "22% market coverage" figure in this section was an artefact of
   averaging one across seven days. Measured by days out:

   | days out | fixtures | priced (3+ books) |
   |---|---|---|
   | today | 12 | **100%** |
   | +1 | 46 | 93.5% |
   | +2 | 25 | 76.0% |
   | +3 and beyond | 272 | **0%** |

   The cliff at +3 is `DAYS_AHEAD: '3'` in `engine.yml` -- planDay builds a
   today+2 plan, so nothing further out is polled. It is a credit-budget
   decision (`lib/oddsApiBudget.js` paces against league-days), not missing data.
   The five inside the window are small-country ties and two South American /
   Austrian fixtures that books put up closer to kickoff.

2. **ELO immature -- 13 fixtures, and 12 are European ties.** In every one it is
   the *smaller* side that is thin: FK Jablonec 4 games, Hapoel Tel Aviv 4,
   Hradec Kralove 4, Kauno Zalgiris 16, Saburtalo 18, Ararat-Armenia 20, Sabah FA
   20. These clubs play in leagues we do not track -- Faroe Islands, Georgia,
   Lithuania, Armenia, Albania, Israel, Azerbaijan -- so the only completed
   matches we will ever hold for them are the European ties themselves. **No
   amount of backfilling the tracked set fixes this**: it is the boundary of the
   forty-league list meeting a competition that reaches outside it. The other
   two are newly promoted clubs in tracked leagues (Wieczysta Krakow 3 games,
   Erzurumspor 1), which time fixes on its own.

3. **No ELO at all -- 1 fixture.** Vicenza Virtus, promoted, no completed match
   under that exact name string.

**So the ceiling is structural and it is roughly 80% of priced fixtures.** The
honest handling of the other 20% is the one this repo already uses everywhere
else: withhold. A big disagreement computed from a 4-game rating is IGNORANCE,
not insight, and it is exactly the row a "biggest disagreement" panel would rank
first -- so any per-match treatment gates on games played, not only on the gap.
The largest live gap measured before the backfill was 28.16pp on ratings with a
standard deviation of ~56.

**The pre-backfill funnel, kept as the record it was:**

| stage | fixtures | |
|---|---|---|
| upcoming in 7 days | **342** | |
| both teams have an Elo rating | 313 | 91.5% |
| a market price from 3+ books exists | **74** | 22% -- the averaging artefact |
| both Elo and market | 68 | |
| ...and both teams past 10 games | 25 | |
| ...and the gap reaches 10pp | **5** | |
| ...and both teams past 30 games | **1** | |

## 7. Reproducing it

```sql
-- 1. Pre-match ratings. lib/elo.js: K=30, homeAdv=80, default 1500.
--    A DO block walking research_dc_preds joined to research_match_ratings
--    (for home_tid/away_tid) ORDER BY match_date, id, carrying a rating array
--    and inserting the pre-match pair before each update. See migration 075.
-- 2. Draw fit: grid over d0 × s maximising sum(ln P(observed)) on
--    seasons 2019/20-2022/23, home_games_pre >= 30 and away_games_pre >= 30.
-- 3. Market side: Shin de-vig of (PSCH, PSCD, PSCA) by 60-step bisection,
--    verified against lib/devig.js to 1.5e-10.
-- 4. Buckets: |p_elo - p_mkt| cut at 3/6/10/15pp; "right" = strictly closer.
```

The working tables (`elo_prematch`, `elo_eval`) were dropped after the run. Only
the parameters and the calibration rows were kept, and both are in the database.
