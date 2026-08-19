# MaxEdge Engine Consolidation Plan
## v3 — 19 August 2026

Supersedes v1 and Revisions 2–7, which are preserved in `CONSOLIDATION_REVISION_ARCHIVE.md`. Several v1 figures were withdrawn under scrutiny; where a number appears here it is the surviving one. Appendix B records what changed and why, because the corrections are reusable.

> ## ⚠ v3 (i) — MXDC_V1 ABANDONED
>
> The architecture in §4 was calibrated and tested before being built, and **failed**. ρ = −0.061 fitted on 38,023 fixtures of realised goals (no market input). With the model correctly calibrated, the 1X2↔totals residual carries **no information**: regressing realised over-2.5 against it gives slope **0.093 ± 0.123** where real signal gives 1.0. Not a power failure — the same pipeline detects Pinnacle-minus-book-average, a residual four times smaller, at slope **1.50, t 3.12**. Realised ROI does not move as claimed EV doubles. `paper_models.MXDC_V1` = `failed`. Full write-up in `docs/MXDC_V1_CALIBRATION.md`.
>
> **A book does not disagree with itself by enough to pay for its own margin.** The §4 residual thesis is falsified. **Phases 1–4 below are void.**

> ## ⚠ v3 (ii) — AND THE PROPOSED REPLACEMENT EVIDENCE DOES NOT HOLD EITHER
>
> A draft of this banner offered the counterfactual CLV split — `MARKET_ANCHORED`'s chosen outcome at **+3.24%** against **−3.16%** for the two it did not pick, a 6.4pp spread — as "the only isolated, controlled evidence of model skill in this project." **It is not evidence of skill. It is the selection rule restated.**
>
> `MARKET_ANCHORED` selects the outcome whose best bettable price most exceeds **Pinnacle's Shin-de-vigged fair line**. `no_vig_clv` measures that same price against **Pinnacle's Shin-de-vigged closing line**. Same book, same de-vig, two timestamps — so
>
>     no_vig_clv  =  ln(1 + detected_edge)  +  ln(p_anchor_close / p_anchor_detect)
>                    └── the selection rule ──┘   └──── where skill would live ────┘
>
> The identity was verified exactly against `closing_lines` (max error 5e-5). Measured on the 89 fixtures that have both, fixture-clustered:
>
> | | value |
> |---|---|
> | no-vig CLV | **+3.475%** |
> | edge at detection, vs the same anchor | **+3.844%** |
> | **anchor line movement toward the selection** | **−0.369%  (z −0.91)** |
>
> **The whole +3.5% is the detection-time threshold. The sharp line does not move toward the selection — it drifts very slightly away, statistically zero.** The counterfactual leg is the same tautology mirrored: the two outcomes it did *not* pick are, by construction, the ones whose price fell *below* the anchor's fair line, so their CLV is mechanically negative. The 6.4pp spread is the width of the selection rule.
>
> This is Appendix B lesson #1 — *a raw CLV figure is not evidence of skill; decompose it* — recurring one level up. Note the decomposition above is **not** the retired "CLV remainder" of §7: both sides here are de-vigged against the same book, so the raw→de-vig conversion cancels and the term is not biased by construction.
>
> **`MARKET_ANCHORED` is uniquely exposed to this** because it is the only architecture whose selection yardstick and whose CLV yardstick are the same de-vigged anchor line. `API_PREDICTIVE` and `LAMBDA_MC` select against a model probability, so their takeable CLV of −3.02% (z −5.19) and −2.52% (z −4.14) is a real verdict. Read that way, on the only non-tautological term available, `MARKET_ANCHORED` scores **zero** where the killed architectures score **negative**. Zero is better than negative. It is not skill, and it must not be certified as skill.
>
> Realised P&L says the same thing: **+13.58% clustered yield over 90 settled fixtures at z 1.06** — the figure `/performance` already withholds as `insufficient`.
>
> **Revised direction:** the honest position is that this project has **no demonstrated edge in any architecture**, and the gate in §6 is the instrument that will say so or not. Do not treat `MARKET_ANCHORED` as validated pending accrual; treat it as **on the same footing as anything else that has not passed a gate**. §7 (measurement rules) and §8 (odds feed) stand in full.
>
> **Gate accrual is real, and faster than three weeks.** 88 takeable fixtures in 13 days (6.8/day) — the 150-fixture bar lands in roughly **9 more days**, not three weeks. But the 85.4% takeability behind it was measured under the pre-fix maximal-polling regime (§3 qualification 1) and will fall; re-derive the timeline after one clean week.

> ## ✅ v3 (iii) — PHASE 0 IS MERGED AND VERIFIED
>
> The v2 status line below said "not merged" and is superseded. Merged to `main` as `4c408e9` at **08:58 UTC on 19 Aug 2026**.
>
> - **A1 PASSES.** Last `API_PREDICTIVE` write 08:10:22, last `LAMBDA_MC` write 08:10:24 — both **before** the merge, on the pre-merge SHA. Three engine ticks have since completed on `4c408e9` (09:05, 09:49, 10:06), all success, and neither architecture has written a row.
> - **§8 check 1 PASSES.** The run log now reads `[ingest] 0/84 fixture(s) due by schedule` / `nothing to poll — advancing schedule only`, where pre-fix it was N ≡ M on every run. The ~30× overspend is closed.
> - **§8 checks 2–4 are not yet answerable** and need a full day of post-merge slate, as §8 requires. `[oddsApi] pace=behind throttle=1.4 progress=74% → 1342 credits/league-day` is the first real consumption reading.
> - Unrelated and pre-existing: the `Team statistics & referee tendencies` step times out at 2 minutes on every tick, and `[values] data-quality gate rejected 1 candidate(s)` fires on every loop iteration. Neither blocks Phase 0.

**Status:** Phase 0 **merged to `main` (`4c408e9`, 19 Aug)** and verified live. Migrations 060–072 applied. Phase 1 **abandoned** — see v3 (i). `paper_trades` at 0 rows.

This file is the current statement; `docs/CONSOLIDATION_REVISION_ARCHIVE.md` holds v1 and Revisions 2–7 verbatim. Read this one.

---

## 1. The decision

Collapse the goals-market signal pipeline onto **one engine**: a Dixon–Coles bivariate-Poisson model whose expected goals (λ_home, λ_away) are *inverted from the market's own liquid lines* rather than fitted from history. That single λ pair prices 1X2, over/under at any line, BTTS, correct score and Asian handicap coherently. It ships as a new architecture, `MXDC_V1`.

`MARKET_ANCHORED` (h2h) and `DIXON_COLES` (totals/BTTS) are already the two halves of this engine running as separate codepaths. The consolidation joins them. The rest are deleted.

**Scope limit:** this is one engine for *goals-derived* markets. Corners and cards are not a function of the goal λs and stay separate models — both still "UNTESTED against prices" in the paper harness.

---

## 2. Why — the structural case

The plan rests on these, not on the CLV numbers in §3.

**They are generations, not an ensemble.** `MARKET_CONSENSUS` stopped on 6 August, the day `LAMBDA_MC` and `MARKET_ANCHORED` started. That was a swap. Five architectures are three sequential attempts at h2h plus one model doing a different job.

**They do not corroborate.** Over four days, **159 of 165 distinct selections (96.4%) came from exactly one architecture**. Six had two. There is no agreement signal to harvest — the noise cost of an ensemble with none of the variance reduction.

**The slate supports the inversion.** Last 10 days: **467 of 469 priced fixtures (99.6%) have both h2h and totals**. This routes around the thin-history problem that blocked the original design — Allsvenskan clubs with zero prior matches still have prices.

**A history-fitted DC loses to Pinnacle.** Already recorded in `paper_models.DC_MLE`: *"Platt slope 0.099 → 0.437; betting −7% to break-even out of sample. Behind Pinnacle on Brier (0.6357 vs 0.6140)."* Do not rebuild a model that tries to out-predict the sharp close from goals history.

---

## 3. Evidence position

**One architecture is supported, and only as far as its own measurement
conditions allow.** Both columns below are takeable-only and fixture-clustered —
the population §6 gates on and §7 mandates. Mixing populations across columns is
how the previous draft paired a positive CLV with a negative z.

| architecture | market | settled | takeable | takeable fixtures | CLV (takeable, clustered) | z | verdict |
|---|---|---|---|---|---|---|---|
| `MARKET_ANCHORED` | h2h | 103 | **85.4%** | 75 | **+3.05%** | **+7.05** | supported |
| `DIXON_COLES` | btts | 57 | 40.7% | 20 | +0.40% | +0.36 | unproven |
| `DIXON_COLES` | totals | 144 | **17.4%** | 23 | **−0.43%** | −0.27 | **unproven** |
| `LAMBDA_MC` | h2h | 166 | 53.5% | 45 | −3.12% | −4.50 | killed |
| `API_PREDICTIVE` | h2h | 230 | 45.8% | 54 | −3.18% | −4.29 | killed |
| `MARKET_CONSENSUS` | h2h | 172 | 42.5% | 30 | +1.65% | +0.76 | retired 6 Aug |

Four qualifications, all load-bearing:

1. **These rates were measured under maximal polling.** The `plan.fixture_ids` fetch bug polled every planned fixture every run, so `MARKET_ANCHORED`'s 85.4% is the **favourable** case, not a depressed floor. Post-fix, every window regresses.
2. **`DIXON_COLES` totals is unproven, not merely unmeasured.** Its 17.4% takeability is `bestTwoWay`'s 24-hour lookback — already fixed — but on the rows that *were* takeable it returned −0.43% at z −0.27. A fresher feed gives it more rows to be judged on; it does not make those rows better.
3. **Clustering leaves `MARKET_ANCHORED` materially unchanged**, which is the useful finding: at 1.18 selections per fixture, clustering is nearly a no-op there, so its edge was never a clustering artefact. (Do not cite the 7.62 → 9.00 move as a strengthening — that is sd-estimation noise at n=89.)
4. **This table was re-derived on 18 Aug and four rows moved.** The draft it
   replaces paired a takeable-only CLV column with an all-rows z column, and
   `MARKET_ANCHORED`'s z was the all-rows *naive* figure rather than a clustered
   one. `MARKET_CONSENSUS` was the tell: +1.39% CLV against z −1.27 is
   arithmetically impossible, since a positive mean cannot carry a negative z.
   Every verdict survived the correction, and one is now consistent with its own
   number — `DIXON_COLES` btts read **+3.49** beside the word *unproven*, which
   is a figure someone would eventually have cited to reopen the question. Its
   takeable-clustered z is **+0.36**.

`MXDC_V1` inherits none of these numbers and must be baselined on post-fix data.

---

## 4. Target architecture

### 4.1 The core idea

Give the fitter devigged constraints per fixture — 1X2 (2 independent), totals at the main line (1) — and solve for λ_h, λ_a. **Hold BTTS out and fix ρ globally**, offline, as the slow structural parameter it is. That leaves **2 free parameters against 3 constraints: overdetermined by one.**

This resolution matters and was got wrong twice. Holding BTTS out *alone* leaves 3 constraints against 3 parameters (λ_h, λ_a, ρ) — exactly determined, residual identically zero. Adding BTTS back makes it overdetermined but consumes BTTS as an input. Fixing ρ gets both: a residual *and* BTTS retained as a signal market. Fitting ρ per fixture against three numbers was overfitting anyway.

### 4.2 Two quantities, never conflated

- **(a) Fit residual** — irreconcilability between the anchor markets. Exists only when overdetermined. A **diagnostic**: internal inconsistency, or a data error.
- **(b) Out-of-sample divergence** — model price of a market *not* used in the fit versus its actual price. This is the **signal**, and it exists regardless of (a).

### 4.3 What this lets you claim

Not "our model beats the market" — which the CLV data says is false for three of five architectures. Instead:

> *The book's own markets disagree with each other by more than any goal distribution allows. The liquid one is right. Fade the derivative.*

Defensible, and directly on-thesis for a pricing-inefficiency product.

### 4.4 Pipeline

```
devigged h2h (Shin)  ─┐
devigged totals @ L  ─┴─►  DC inversion (ρ fixed) ──►  (λ_h, λ_a) + residual
                                    │                        │
team attack/defence ────────────────┘                        └──► fit-quality gate
priors, shrunk to market                                          (reject if irreconcilable —
where history is thin                                              assume data error first)
                                    │
                                    ▼
        price every market from one λ pair: 1X2 · O/U any line · BTTS · CS · AH
                                    │
                                    ▼
        emit only where a DERIVATIVE market disagrees with the anchor
```

---

## 5. Phases

### Phase 0 — Stop the bleeding — **CODE COMPLETE, NOT MERGED**

`API_PREDICTIVE` and `LAMBDA_MC` off at the **writer**: workflow steps deleted, `LAMBDA_BOARD_ENABLED` pinned false, scripts refuse to run without explicit opt-in. `MARKET_CONSENSUS`, `CORNERS_MODEL`, `CARDS_MODEL` and `lib/secondaryMarkets` removed. `dailyTelemetry` warns if a retired architecture writes a row. **No `LAMBDA_MC` calibration row was inserted, and none ever should be.**

### Phase 1 — Build `MXDC_V1` behind the paper harness — **not started**

`MXDC_V1` writes to `paper_trades`, never `value_signals`. The live board is untouched through Phases 1–2.

1. **Inversion solver.** Unit-test by generating prices *from* a known λ pair and recovering it.
2. **Fit-quality gate.** Define the residual ceiling. Log rejects rather than dropping them silently — after the `market_prob` incident, assume data error until proven otherwise.
3. **Forward pricer.** One λ pair → all goals markets.
4. **Emission.** The anchor market never emits. Derivatives only.
5. **Price liveness (P1-L1).** Re-quote immediately before write; do not emit a price that has moved or vanished. Log the premium over the contemporaneous cross-book median on every emission.
6. **Writer hygiene.** Populate `external_ref` per fixture (now `NOT NULL`). Clamp `model_prob` to `[ε, 1−ε]` — a DC pricing a deep tail can round to 0 or 1 and trip the CHECK.

### Phase 2 — Validate — **~3–4 weeks of live slate**

Run in paper against the real card. Judge CLV, not yield. See §6 for the gate.

### Phase 3 — Cut over — 1 day + 1 parallel week

`MXDC_V1` starts writing `value_signals`; `MARKET_ANCHORED` and `DIXON_COLES` stop writing but keep their history and labels.

### Phase 4 — Delete — 1 day

Retired codepaths, config, calibration rows, and the multi-architecture branching in scorer and frontend.

**Total ~6–8 weeks.** Phase 2 is wall-clock accrual and is not compressible.

---

## 6. Acceptance tests

| # | Test | Threshold | Phase |
|---|---|---|---|
| A1 | Only surviving architectures writing | exactly `MARKET_ANCHORED`, `DIXON_COLES` | 0 (post-merge) |
| A2 | Solver recovers known λ from synthetic prices | max abs error < 0.01 goals | 1 |
| A3 | Price coherence, **per market** | `avg(market_prob × detected_odds)` ∈ [0.94, 0.99], zero rows > 1.00 | 1 |
| A4 | Forward/inverse round-trip | reprice the anchor from fitted λ, recover input probs within 0.005 | 1 |
| A5 | **Paper CLV gate, overall** | **`paper_trade_gate()` passes on its derived bar** | 2 |
| A6 | Paper CLV gate, per market family | passes independently for 1X2, totals, BTTS | 2 |
| A7 | Live rows match paper rows | ≥ 95% selection agreement over 1 parallel week | 3 |
| A8 | Single source | `count(distinct model_architecture)` on new rows = 1 | 4 |

**A5 takes no arguments.** The first parameter is now a **fixture floor**, not a row count — passing the old `(300, 0.0, 2.0)` would demand 300 *fixtures*. Call it bare and let the derived bar apply.

The gate asks three questions in order:

1. **Sample size**, self-calibrating to the model's own variance:
   `required_fixtures = max(150, ceil((2.802 × sd_hi90 / 0.010)²))`
   powered to detect a **+1.0% clustered CLV**, using the upper bound of a 90% CI on sd rather than the point estimate. On the sd profile `MXDC_V1` should have (3.6–3.9%) this resolves to the **150 floor**; at an 11% longshot-style sd it demands ~1,245 fixtures. That is the +92.7% failure mode closed structurally — a wide-variance book cannot be certified on a short sample.
2. **Takeability rate** — **threshold currently unset**, pending one full week of post-fix measurement. Do not set it from pre-fix numbers.
3. **Fixture-clustered CLV** and its z.

Sample-size and significance are **separate questions and both are needed**: the power rule sets the sample at which the test *could* detect +1.0%; the z threshold *is* the test.

---

## 7. Measurement rules (standing)

These are gate-design invariants, not one-off findings.

**CLV.** Takeable-only for the gate and internal diagnosis. **Published performance never filters** — unplaceable signals stay in the denominator. Excluding them is the survivorship bias that produced the retired +14.79% yield.

**Takeability.** A price at or below the best a *bettable* book was showing. Premium magnitude is not the test — honest best-of-nine line shopping is worth **+4.01% h2h / +3.58% BTTS / +3.44% totals**, so a premium can be legitimate; a price above the contemporaneous *maximum* cannot. Unverifiable counts as **not takeable**. Coverage is its own column; zero coverage HOLDs unconditionally.

**Clustering.** Always by fixture, always computed — never a blanket factor. √m is not an upper bound (`MARKET_CONSENSUS` inflated 2.52× against √2.42 = 1.56) and clustering can *raise* z where a model emits ~1 selection per fixture.

**Retired:** the "CLV remainder" (CLV minus premium) — it mixes real line movement with the mechanical raw→de-vig conversion and is biased negative by construction.

---

## 8. Odds feed — state and sequencing

**`odds` is a price-CHANGE log, not a poll log** (`if (!oddsHaveMoved(last, row)) continue`). Never infer polling frequency or quote age from it.

**Root cause of the stale feed:** `ingestOdds` Phase 1 fetched `plan.fixture_ids` — the whole day's plan — every run, while `dueIds` only advanced schedules. Tiering never reduced fetches: ~30× overspend. **This meant *more* polling, not less**, so fixing it alone is a **freshness regression**. Mitigated by a floor: poll at least every 40 minutes inside T-2h whatever the tier (~300 requests on a 101-fixture Saturday against the ~2,570 the bug spent). A stale day-plan also polled fixtures that had already kicked off; fixed with a runtime kickoff filter.

**Sequencing — do not co-deploy.** `odds_api_daily_caps` is a static forward allocation (~70.6 credits per scheduled match per day), not a consumption log, so real spend is unmeasured. (1) deploy the fetch fix and floor; (2) observe one full day of actual consumption; (3) size tiers from measured headroom. Do not raise `DAILY_REQUEST_BUDGET` before step 2.

**Post-merge verification** — read the run log, not the odds table:

1. `[ingest] fetching N of M planned fixture(s)` — pre-fix N ≡ M; post-fix N a small fraction of M outside the closing window. **If this does not change, the fix did not take effect.**
2. totals/BTTS median quote age converges on h2h's, whatever level that settles at.
3. Post-kickoff rows for pre-match books fall to ~0%.
4. Credits per match lands materially below 70.6.

---

## 9. Board during the gap — decided

**Ship thin — but the board was never as thin as this said, and `MXDC_V1` is never publishing.** The "~3 signals" was a **pending-rows snapshot** taken at a quiet moment and should not have been generalised into a 4–6 week gap: `MARKET_ANCHORED` alone runs at **109 rows over 93 fixtures in 14 days — 7.8 signals/day** (verified 19 Aug), and the 3 was simply how many happened to be un-kicked-off at the instant it was read. With `MXDC_V1` abandoned there is no gap to bridge; the board carries what the surviving architectures emit. Still not filled by republishing negative-CLV architectures.

**A pending count is a snapshot of an inventory, not a rate.** Measure emission over a window and divide.

**Public framing: customer-facing, internals unpublicised.** No rebuild announcement, no methodology banner.

- Empty board: *"No signals right now."* / `N PRICED · 0 BACKED` / *"We publish when the price is worth it."*
- Thin board: no added copy.
- `/performance`: unchanged — em-dash plus *"not enough settled fixtures to publish a yield"*.

**Constraints:** nothing may imply a continuing verified track record; no broadcast post may cite a record; the empty state must be true, just brief. **Accepted cost:** a near-empty board for 4–6 weeks against a subscription proposition, churn risk taken knowingly.

---

## 10. Risks

**The plan rests on one weakly-supported architecture.** `MARKET_ANCHORED` is 103 settled rows measured under favourable feed conditions. If `MXDC_V1` fails A5 in paper, **stop — do not lower the gate.** This project has already run one cycle of lowering a threshold until the band fired; the answer was that the band was unreachable for a reason.

**The inversion may be too well-determined.** If 1X2 and totals almost always reconcile, the residual is small everywhere and volume is low. Measure the residual distribution in Phase 1, before Phase 2 starts — find this out in week two, not week six.

**Volume.** One engine on derivative markets only will emit far fewer signals than four emitting freely. Recheck tier assumptions against actual Phase 2 volume.

**Corners and cards remain unsolved** and need the same paper→gate→cutover discipline.

---

## 11. Open decisions

1. **Anchor** — Pinnacle specifically (sharper close; 659 of 667 backfilled closing lines are already Pinnacle-anchored) or a devigged multi-book consensus (broader coverage, softer target)?
2. **Does `MXDC_V1` emit on 1X2 at all?** If h2h is the anchor, the pure form says no — which removes the market most users expect to see. Decide deliberately, not by omission.
3. **Correct score and Asian handicap in V1?** Free to price from the same λ pair, but each is new frontend and new settlement.
4. **Signal shelf life.** `price_was_takeable()` measures availability at *detection*. With a 9.2-hour median detection lead on `MARKET_ANCHORED`, a price that was best-of-panel at T-9h and gone twenty minutes later passes the check and still fails the user. The function already takes a window parameter, so this is a policy choice: what shelf life does a signal advertise, and is takeability measured against that window?

---

## Appendix A — Detection lead times

Last 21 days, for sizing the shelf-life decision and the freshness floor.

| architecture | market | median lead | p90 | ≤2h | ≤6h |
|---|---|---|---|---|---|
| `MARKET_ANCHORED` | h2h | 9.2h | 38.8h | 17.6% | 39.8% |
| `DIXON_COLES` | totals | 4.4h | 19.7h | 29.6% | 64.8% |
| `DIXON_COLES` | btts | 5.3h | 30.4h | 31.6% | 54.4% |

Takeability *improves* with lead time (`MARKET_ANCHORED` 78.9% → 96.7%; `DIXON_COLES` 38.2% → 62.5%) because prices move 0.51×/hour inside T-2h against 0.11×/hour a day out. **The closing window is the hardest window for takeability**, which is why the freshness floor belongs there.

---

## Appendix B — What changed, and the lesson

Seven revisions produced six corrections worth keeping as standing discipline. Full detail in `MaxEdge_Consolidation_Revision_Archive.md`.

| # | What was wrong | Lesson |
|---|---|---|
| 1 | `DIXON_COLES` promoted on +1.4%/+2.2% CLV that was pure stale-price selection | **A raw CLV figure is not evidence of skill.** Decompose it. |
| 2 | A ~2% premium threshold asserted where honest line shopping is worth ~3.5% | **Measure the baseline before setting a bar against it.** |
| 3 | The 90% takeability gate set from 85.4% observed through a known-broken feed | **Never calibrate a threshold from a number measured through a broken system** — the σ constants and the PRIME threshold were the same error. |
| 4 | Tier behaviour inferred from the `odds` table | **`odds` is a change log.** Its timestamps track volatility, not polling. Verify from the run log. |
| 5 | Unmeasurable takeability silently left the denominator; the gate's z counted rows | **Excluding the unmeasurable flatters the measure** — the same shape as the +14.79% yield, one level down. |
| 6 | A √m clustering adjustment applied globally | **Compute the estimator; don't adjust the threshold.** The factor is not √m and can go either way. |
| 7 | The forward board sized from a count of `pending` rows | **A pending count is inventory, not throughput.** It reads low at any quiet moment. Measure emission over a window. |
| 8 | `MARKET_ANCHORED`'s +3.2% CLV read as skill | **Check whether the selection rule and the metric share a yardstick.** Selecting on price-vs-de-vigged-anchor and scoring on price-vs-de-vigged-anchor-at-close makes CLV the threshold restated. Decompose into detection edge plus line movement; only the movement can be skill. |
| 9 | A counterfactual control built from outcomes the model declined | **A control the selection rule already sorted is not a control.** The unpicked legs are unpicked *because* their price was below fair, so their CLV is negative by construction and the spread measures the rule's width. |

A tenth, from the harness: **a pass with no bar set must say so.** `PASS (takeability X% — not yet thresholded)` rather than a bare `PASS`, or a criterion nobody has set reads as one something has met.
