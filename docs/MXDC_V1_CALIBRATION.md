# MXDC_V1 — calibration, and why the residual is not a signal

**19 Aug 2026.** Phase 1 pre-work. Calibrate Dixon-Coles ρ and the total-goals
dispersion against realised results, then establish whether the 1X2↔totals
residual carries real structure.

**It does not.** ρ and the dispersion both calibrate cleanly, the residual is
large (sd 3.30pp) and has abundant volume, and it contains no information about
the outcome. The recommendation is to stop before the emission pipeline.

---

## 0. The rule this was fitted under

> Never fit ρ or dispersion to minimise disagreement with the market. That makes
> the model reproduce the price by construction and destroys the signal.
> Calibrate to outcomes; measure against the market.

ρ was fitted on `matches` — realised goals only, no price anywhere in the
estimator. The dispersion tilt was fitted to the realised TOTAL, not to a price.
Prices appear only on the measurement side, and only after both parameters were
fixed.

Parameters are in `goal_model_params` (migration 072), not in a source file. The
σ constants are the cautionary tale: a number hand-copied out of a table
disagrees with it the moment either moves, and neither copy throws.

---

## 1. ρ = −0.061

### The corpus

`mxdc_calib_fixtures`: 38,023 fixtures, 9 leagues, 21 seasons (2005–2026), with
λ from a leave-one-out shrunk attack/defence estimate (K = 15), league-season
means, teams with ≥4 home and ≥4 away appearances, league-seasons with ≥150
fixtures. Leave-one-out matters: the fixture being scored is subtracted out of
its own teams' aggregates, so λ is genuinely out of sample.

λ is unbiased in the mean — avg λ_home 1.5290 vs avg goals_home 1.5307, avg
λ_away 1.1769 vs 1.1776.

### The estimator is closed-form, because τ is exactly normalised

The Dixon-Coles correction perturbs four cells:

    τ(0,0) = 1 − λμρ    τ(0,1) = 1 + λρ    τ(1,0) = 1 + μρ    τ(1,1) = 1 − ρ

Multiply each by its independent-Poisson probability and the perturbations sum
to zero for **any** ρ:

    ρ·e^(−λ−μ)·(−λμ + λμ + μλ − λμ) = 0

So the matrix already sums to 1, the normalising constant is 1, and the full
log-likelihood separates into a ρ-free Poisson part plus `Σ log τ` over the
fixtures that landed in one of the four low-score cells. `scoreMatrix()` in
`lib/dixonColes.js` renormalises anyway; that is harmless, and it is absorbing
the max-goals truncation, not the τ correction.

### The fit

Grid over ρ ∈ [−0.20, +0.04] at 0.005, feasibility-checked (τ(0,0) goes
negative at high λ for large |ρ| — 0 infeasible fixtures anywhere in
[−0.20, +0.16]).

| ρ | rel. loglik |
|---|---|
| 0.000 | 0.00 |
| −0.040 | +37.04 |
| −0.055 | +41.72 |
| **−0.060** | **+42.16** |
| −0.065 | +42.04 |
| −0.080 | +38.29 |
| −0.130 *(library default)* | −11.55 |
| −0.140 | −28.60 |

Parabolic refinement: **ρ̂ = −0.061**, curvature SE **0.0067**, 95% CI
**[−0.074, −0.048]**.

- vs ρ = 0: Δ 42.2 loglik, LR χ² 84 on 1 df. The correction is real.
- vs ρ = −0.13 (Dixon-Coles 1997, English league 1992–95): Δ 53.7 loglik. The
  1997 figure is decisively rejected on modern data.

### One global ρ, not per league and not per era

| split | ρ̂ range | Δ loglik vs one global ρ | df | p |
|---|---|---|---|---|
| 9 leagues | −0.105 (Bundesliga) … −0.03 (La Liga) | 9.75 | 8 | 0.28 |
| 3 eras | −0.075 / −0.050 / −0.055 | 1.43 | 2 | 0.49 |
| 6 expected-total buckets | no monotone pattern | 4.82 | 5 | 0.44 |

None significant. A single global ρ is the right call, and per-league ρ would be
an over-fit. The modern era's own estimate (2019–2026) is −0.055, on top of the
pooled value.

### What ρ does NOT fix

The four low-score cells, `matches` corpus, observed vs expected:

| score | obs | exp at ρ=0 | z | exp at ρ=−0.061 | z |
|---|---|---|---|---|---|
| 0-0 | 2852 | 2770.4 | +1.55 | 3030.2 | **−3.24** |
| 0-1 | 2697 | 3110.0 | −7.41 | 2850.2 | −2.87 |
| 1-0 | 3825 | 3924.8 | −1.59 | 3665.1 | **+2.64** |
| 1-1 | 4568 | 4258.4 | +4.74 | 4518.2 | +0.74 |
| | | χ² | **82.3** | χ² | **26.2** |

ρ takes χ² from 82 to 26, which is why it wins on likelihood. But the τ shape is
rigid: it fixes 0-1 and 1-1 by making 0-0 and 1-0 worse. **The Dixon-Coles
low-score correction is directionally right and is not the whole story** —
χ² 26 on 3 df survives. Net effect on P(under 2.5) is only −0.32pp, so this does
not drive anything below.

---

## 2. Dispersion: total goals are UNDER-dispersed, not over

The brief expected an over-dispersion correction. Measured conditionally, the
sign is the other way.

### Why the familiar answer is the unconditional one

Across `matches`: empirical Var(T) 2.7914 against model-implied 2.9116 (= mean λ_T
2.7059 + Var(λ_T) 0.2058). A single Poisson fitted to all matches *is*
over-dispersed, and all of it is λ heterogeneity. Conditional on λ, the model is
about 4% too WIDE.

That measurement is confounded on this corpus: λ estimation error and true
dispersion enter Var(T) identically, and one free parameter absorbs the other, so
the variance alone is exactly identified and tells you nothing. Profiling the λ
shrinkage by likelihood puts the optimum at s = 0.958 — the LOO estimates are
almost exactly right — and the shape residual barely moves.

### The clean measurement

Fit the tilt against realised totals, conditional on λ inverted from
Shin-de-vigged **Pinnacle closing 1X2** — a λ that carries no estimation noise of
ours, and the λ the production model would actually use:

    P'(T = k) ∝ P(T = k) · exp(−θ·(k − λ_T)²)

**θ̂ = +0.0065 ± 0.0021 (t 3.2)**, worth 4.9 loglik over 14,925 fixtures. A
mean-recentring second parameter is completely unidentified (flat over
c ∈ [0.98, 1.06]), so θ alone.

Conditional Var(T): **2.640 → 2.546, −3.6%.** The `matches` corpus says −3.5%
independently, from a different λ source. Two corpora agree.

### And it does not matter at 2.5

| | uncorrected | θ = 0.006 | market | actual |
|---|---|---|---|---|
| mean P(over 2.5) | 0.4840 | 0.4827 | 0.4913 | **0.4892** |
| log-loss | 0.68289 | 0.68301 | 0.68097 | |

Mean absolute change in P(over 2.5): **0.16pp**. The tilt is symmetric about
λ_T ≈ 2.63 and the 2.5 line sits at the centre of the distribution, where a
variance correction has almost no leverage. It would matter at 0.5, 1.5, 4.5,
5.5 — not at the line the product quotes.

**θ is stored because it is true, not because it is useful here.**

---

## 3. The residual carries no information

### The measurement

14,925 fixtures, 5 English divisions (E0, E1, E2, E3, EC), 2019–2026. λ inverted
from Shin-de-vigged Pinnacle closing 1X2 via a 190,096-point (λ_h, λ_a) lookup
grid at 0.01 resolution; model P(over 2.5) read off the same grid; compared with
Pinnacle's OWN Shin-de-vigged closing over/under 2.5.

    residual  =  P_model(over 2.5)  −  P_market(over 2.5)

    mean −0.74pp · mean |r| 2.63pp · sd 3.30pp

### The test

If the residual is signal, then where the model says "more overs than the market
does", more overs should actually happen. Regress

    (realised over-2.5)  −  P_market(over 2.5)     on     residual

Real signal gives slope 1. Pure noise gives 0.

| | slope | SE | t | 95% CI |
|---|---|---|---|---|
| raw residual | **0.093** | 0.123 | 0.76 | [−0.148, **+0.333**] |
| after removing systematic components | 0.088 | 0.150 | 0.59 | [−0.206, +0.382] |

**Slope 1 is excluded by a factor of three.** Even at the CI's upper bound, a
3pp residual buys 1pp of true edge — inside a 3.4% market margin, that is not a
bet.

### It is not a power failure — positive control

The same pipeline, same fixtures, same estimator, applied to a residual that is
KNOWN to be signal: Pinnacle's de-vigged price minus the book-average de-vigged
price.

| | n | sd of residual | slope | SE | t |
|---|---|---|---|---|---|
| Pinnacle − book average | 14,923 | **0.84pp** | **1.501** | 0.481 | **3.12** |
| MXDC_V1 1X2→totals | 14,925 | **3.30pp** | 0.093 | 0.123 | 0.76 |

The control detects a residual **four times smaller** at t 3.12. If the DC
residual carried the same information per unit, it would read t ≈ 12. It reads
0.76.

### And the model is behind the price it would bet into

| | model | market |
|---|---|---|
| log-loss | 0.68289 | **0.68097** |
| Brier | 0.24489 | **0.24398** |
| corr with outcome | 0.1445 | **0.1538** |

Both beat the base rate (log-loss 0.6929), so the model is not uninformative —
it is dominated. Everything it knows about totals, the totals price already
knows.

---

## 4. Structure: the bias is real and removable; the signal is not there

No subgroup rescues it. Seventeen subgroups, **not one reaches |t| = 1.5**:

| subgroup | n | mean residual | slope | t |
|---|---|---|---|---|
| E0 / E1 / E2 / E3 / EC | 2,479–3,577 | −1.6 … +0.8pp | −0.13 … +0.21 | ≤ 0.68 |
| favourite < 40% (even) | 3,297 | **−2.18pp** | 0.107 | 0.34 |
| favourite 40–50% | 5,957 | −1.17pp | 0.021 | 0.10 |
| favourite 50–60% | 3,394 | −0.12pp | −0.023 | −0.08 |
| favourite 60–72% | 1,683 | +1.11pp | 0.319 | 0.84 |
| favourite > 72% (heavy) | 594 | **+2.91pp** | 0.455 | 0.84 |
| market O2.5 < 42% | 2,484 | −1.21pp | −0.426 | −1.09 |
| market O2.5 > 58% | 1,790 | +0.38pp | 0.215 | 0.78 |
| seasons 2019/20 … 2025/26 | 968–2,542 | −1.41 … +0.23pp | −0.32 … +0.43 | ≤ 1.33 |

Season slopes flip sign five times across seven seasons. That is noise.

**There IS a large systematic component, and it is a model defect, not signal.**
The mean residual runs monotonically from −2.18pp in even matches to +2.91pp in
heavy mismatches: inverting 1X2 to (λ_h, λ_a) resolves a high draw probability by
lowering λ_T and a low one by raising it, so the implied total is a rigid
function of supremacy. Removing it — cell means over favourite-strength ×
totals-line × league — takes the residual sd from 3.30pp to 2.81pp and leaves
the slope at 0.088. **De-biasing removes 15% of the dispersion and 0% of the
nothing.**

This is exactly the shape the brief warned about (`league_tag` is already
inverted: "proven" −42% yield, "avoid" +55%). Per-league or per-strength tuning
here would be fitting a bias and calling it an edge.

**Time to kickoff could not be tested.** `research_dc_preds` carries closing
prices only. It needs the live `odds` history, and that history is a price-CHANGE
log — quote age cannot be inferred from its timestamps.

---

## 5. Surviving volume: abundant, and worthless

Volume was never the constraint. The claim is.

Best price across a **bettable two-book closing panel** (Pinnacle + Bet365; the
Betfair Exchange price is excluded because it is quoted pre-commission), average
overround 1.0343, arbitrage vectors dropped. 14,857 fixtures over 2,351 calendar
days (1,313 of them with a fixture), 2 Aug 2019 to 8 Jan 2026.

| EV threshold | bets | % of fixtures | per active day | claimed EV | **realised ROI** | z | 95% CI upper |
|---|---|---|---|---|---|---|---|
| ≥ 0% | 8,783 | 59.1% | 6.69 | +4.20% | **−2.61%** | −2.57 | −0.62% |
| ≥ +1% | 7,219 | 48.6% | 5.50 | +5.00% | **−2.08%** | −1.84 | +0.13% |
| ≥ +2% | 5,812 | 39.1% | 4.43 | +5.86% | **−0.66%** | −0.52 | +1.82% |
| ≥ +3% | 4,561 | 30.7% | 3.47 | +6.79% | **−0.99%** | −0.69 | +1.83% |
| ≥ +5% | 2,778 | 18.7% | 2.12 | +8.64% | **+0.50%** | 0.27 | +4.18% |

Claimed EV doubles across the table. Realised ROI does not move. **At EV ≥ 0 the
screen is significantly negative** (z −2.57) — it is not merely uninformative,
it selects into the vig.

Controls on the same panel:

| strategy | n | ROI | z |
|---|---|---|---|
| always OVER at best price | 14,857 | −3.99% | −4.86 |
| always UNDER at best price | 14,857 | −2.91% | −3.65 |
| MXDC_V1 EV ≥ +2% | 5,812 | −0.66% | −0.52 |
| **MXDC_V1 EV ≥ +2% where the market anchor sees NO edge** | 5,702 | **−0.80%** | −0.63 |

The last row is the model's own contribution, isolated. It is negative.

**The wider panel flatters it and still does not save it.** Repeating the same
screen against football-data's `MaxC` — the max across the full panel including
the exchange, average overround 1.0141 with 18% of vectors outright sub-1 —
lifts MXDC_V1 EV ≥ +2% to +0.77% (z 0.76) on 9,357 bets. That is exchange price
before commission, and the model-only subset is still −1.13%. On the same wide
panel the existing MARKET_ANCHORED shape — Pinnacle's Shin fair line against the
panel best price — returns **+4.61% on 2,871 bets at z 2.40**. Less volume, real
edge, and it is already built.

---

## 6. Verification of the machinery

A null result is what a bug produces, so every stage was checked against the
production code before the null was believed.

| stage | check | result |
|---|---|---|
| DC score matrix | SQL grid vs `lib/dixonColes.js` `scoreMatrix`/`marketsFromMatrix` at 5 (λ_h, λ_a) points, ρ = −0.061, maxGoals 12 | max abs diff **4.8e-9** (rounding-limited) |
| max-goals truncation | 10 vs 12 on P(over 2.5) | ≤ **3.7e-5** |
| Shin de-vig | SQL 60-step bisection vs `lib/devig.js` `shinDevig` on 6 real price vectors, 2- and 3-outcome | Δz ≤ **1.4e-10**, Δp ≤ **5.5e-11** |
| Shin de-vig | Σp over every de-vigged market | **1.000000000** min and max |
| 1X2 inversion | grid nearest-neighbour fit error | mean **0.09pp**, max 0.46pp; 1 of 14,939 at a grid edge |
| total-goals pmf | Σ_k P(T=k), k ≤ 14 | 1.000000 mean, 0.999951 min |
| detector sensitivity | positive control (§3) | **t 3.12 on a residual 4× smaller** |

One bug was caught and fixed mid-run: an early aggregation grouped by
`(gh, ga, λ_h, λ_a)` instead of by fixture id, collapsing 953 duplicate tuples
and double-counting their pmf, which produced P(over 2.5) > 1 in the top bucket.
Every number above is post-fix.

---

## 7. Rulings

1. **ρ = −0.061, one global value.** In `goal_model_params`, not in a constant.
2. **`lib/dixonColes.js` still declares `DEFAULT_RHO = -0.13` and that was left
   alone.** It is live in `lib/secondaryMarkets.js` and `lib/lambdaBoard.js`;
   changing a live pricing default is its own change with its own verification,
   not a side effect of a research task. `engine.dixoncoles.test.js` still
   asserts −0.13 deliberately. **Whoever changes it should know the measured
   value rejects it at Δ 53.7 loglik.**
3. **θ = +0.006, conditional UNDER-dispersion.** Stored, and not worth applying
   at the 2.5 line. Apply it if an outer line is ever priced.
4. **Do not build the MXDC_V1 emission pipeline.** `paper_models.MXDC_V1` is
   `failed`. Not "insufficient" — measured, controlled, and negative.
5. **The residual is a model defect with a known shape.** Monotone in favourite
   strength, ±3pp end to end. Anyone who revisits DC-from-1X2 should fix the
   supremacy→total mapping first; that bias is what the residual mostly is.
6. **What this does not say.** It does not say a Dixon-Coles model cannot beat a
   totals line. It says that **inverting a book's own 1X2 to price its own
   totals cannot**, because a book does not disagree with itself by enough to
   pay for the margin. A model with information the price does not have — the
   corners and cards work, where `paper_models` already records monotone deciles
   against outcomes and no test against prices yet — is a different question and
   is untouched by this.

---

## 8. Reproducing it

Working tables (`mxdc_calib_fixtures`, `mxdc_grid`, `mxdc_fact`, `mxdc_dvin`,
`mxdc_shin`, `mxdc_fit`, `mxdc_resid`) were dropped after the run. They are
derivable from `matches` and `research_dc_preds`, which are untouched. Only the
parameters were kept, and they are in `goal_model_params`.
