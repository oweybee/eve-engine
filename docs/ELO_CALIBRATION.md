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

## 6. Coverage — measured 19 Aug 2026, and it is what blocks the feature

The calibration says an Elo sentence is honest at 10pp or more. The question that
decides whether it is a *feature* is how often a live fixture gets there.

**The seven-day funnel:**

| stage | fixtures | |
|---|---|---|
| upcoming in 7 days | **342** | |
| both teams have an Elo rating | 313 | 91.5% — name matching is fine |
| a market price from 3+ books exists | **74** | **22%** |
| both Elo and market | 68 | |
| …and both teams past 10 games | 25 | |
| **…and the gap reaches 10pp** | **5** | |
| **…and both teams past 30 games** | **1** | |

**Five a week at the loose bar. One a week at the honest one.** That is not a
per-match feature, and the panel stays dark.

**Two independent constraints, and neither is the calibration.**

1. **Market coverage, 22%.** 268 of 342 upcoming fixtures carry no price from
   three books. The tiering polls near kickoff by design, so a fixture four days
   out simply has nothing to compare against.

2. **Rating maturity, and it is bimodal by league.** Not a bug — the ladder walks
   the full history (80,622 team-games = exactly 2 × 40,311 completed matches).
   The history is just shaped wrong for what we price:

   | league | upcoming (7d) | completed history |
   |---|---|---|
   | La Liga | 12 | 8,156 |
   | Premier League | 10 | 7,600 |
   | Serie A (Italy) | 10 | 7,600 |
   | MLS | **30** | 284 |
   | Europa Conference League | **24** | 210 |
   | Championship | 12 | **12** |
   | League One / League Two | 12 each | **12 each** |
   | Serie B (Italy) | 10 | **0** |

   538 of 968 teams have fewer than 10 games in the ladder, and their ratings sit
   at 1500 ± 24 — the default wearing a number. The leagues we have depth for are
   a small share of what we price; the leagues we price heavily have none.

**And the failure mode is worse than thin coverage.** The largest live gap
measured was **28.16pp**, on ratings with a standard deviation of ~56. A big
disagreement from a thin rating is IGNORANCE, not insight — and it is precisely
the row a "biggest disagreement" panel would surface first. Any per-match
treatment must gate on games played, not only on the gap.

**The fix is a backfill, not a model change.** The big five prove the pipeline
can do it at 7,600 rows apiece; the other tracked competitions need the same
treatment. Until then Elo is a forecast for about a fifth of the board.

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
