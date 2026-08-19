# Engine Consolidation Plan
## Five architectures → one market-anchored Dixon–Coles

**Date:** 18 August 2026
**Status:** proposal, not yet started
**Supersedes:** the ad-hoc architecture set accumulated Jun–Aug 2026

---

## 1. The decision

Collapse the goals-market signal pipeline onto **one engine**: a Dixon–Coles bivariate-Poisson model whose expected goals (λ_home, λ_away) are *inverted from the market's own liquid lines* rather than fitted from history. That single λ pair then prices 1X2, over/under at any line, BTTS, correct score and Asian handicap coherently.

Two of today's five architectures — `MARKET_ANCHORED` (h2h) and `DIXON_COLES` (totals/BTTS) — are already the two halves of this engine running as separate codepaths. The consolidation joins them. The other three are switched off and deleted.

**Honest scope limit:** this gives you one engine for *goals-derived* markets. Corners and cards are not a function of the goal λs and cannot be folded in — they stay genuinely separate models (`CORNERS_POISSON`, `CARDS_REFEREE`, both currently in the paper harness, both untested against prices). The target is "one goals engine", not "one model for everything". Anyone who tells you otherwise is selling you a diagram.

---

## 2. Why — the evidence

### 2.1 The five are generations, not an ensemble

| architecture | market | window | n | avg odds | no-vig CLV | verdict |
|---|---|---|---|---|---|---|
| `MARKET_CONSENSUS` | h2h | 27 Jun – **6 Aug** | 274 | 8.00 | −3.98% (z −3.20) | retired |
| `API_PREDICTIVE` | h2h | 27 Jun – now | 271 | 3.33 | −3.26% (z −8.60) | **kill** |
| `LAMBDA_MC` | h2h | **6 Aug** – now | 172 | 4.36 | −3.61% (z −9.41) | **kill** |
| `MARKET_ANCHORED` | h2h | **6 Aug** – now | 108 | 2.55 | **+3.51% (z +7.47)** | **keep — becomes the anchor** |
| `DIXON_COLES` | totals + btts | 29 Jun – now | 250 | ~2.15 | +1.4% / +2.2% ⚠️ **confounded — see Rev 2** | keep the *code*; the CLV evidence is withdrawn |
| `CORNERS_MODEL` / `CARDS_MODEL` | corners / bookings | Jun–Jul | 6 | — | none | dead code, delete |

`MARKET_CONSENSUS` stopped on 6 August, the same day `LAMBDA_MC` and `MARKET_ANCHORED` started. That was a swap, not a fan-out. What looks like a five-model ensemble is three sequential attempts at h2h plus one model doing a different job.

### 2.2 They do not corroborate each other

Over the last four days: **159 of 165 distinct selections (96.4%) were produced by exactly one architecture.** Six had two. There is no agreement signal to harvest — you are paying the noise cost of an ensemble and collecting none of the variance reduction. Four generators sharing a page is not diversification.

### 2.3 A pure-MLE Dixon–Coles loses to Pinnacle

Already established in the paper harness (`paper_models.DC_MLE`): *"Platt slope 0.099 → 0.437; betting −7% to break-even out of sample. Behind Pinnacle on Brier (0.6357 vs 0.6140)."*

This is the load-bearing reason the engine must be **market-anchored** rather than history-fitted, and it is consistent with the earlier finding that the Brier-optimal weight on raw model probabilities was zero. Do not rebuild a model that tries to out-predict Pinnacle from goals history. Build one that assumes Pinnacle is right about the *primary* market and hunts for the *secondary* markets that don't reconcile with it.

### 2.4 The slate supports the inversion

Last 10 days, 469 fixtures with priced odds:

- 468 have h2h prices
- 468 have totals prices
- **467 have both — 99.6% anchorable**
- 455 have BTTS

The inversion is feasible on essentially the entire card. This was the blocker in the original second-model note (thin history coverage: Allsvenskan clubs with zero prior matches) and market anchoring routes around it entirely.

---

## 3. Target architecture

### 3.1 The core idea — the residual *is* the signal

Give the fitter three devigged constraints per fixture:

- 1X2: `p_H, p_D, p_A` (most liquid, highest weight)
- Totals at the main line L: `p_over`
- BTTS: `p_yes` *(optional third constraint, lowest weight)*

Solve for `(λ_h, λ_a, ρ)` under Dixon–Coles with the low-score τ correction. That's 3–4 targets for 3 free parameters — **deliberately overdetermined**.

The overdetermination is not a nuisance, it's the product. A fixture whose 1X2 line and totals line cannot both be reconciled by *any* legal goal distribution is, by definition, internally mispriced. You don't have to claim you predict football better than Pinnacle. You claim something far more defensible and directly on-thesis:

> *The book's own markets disagree with each other by more than any goal distribution allows. The liquid one is right. Fade the derivative.*

That reframes the entire product from "our model beats the market" (which your own CLV data says is false for three of five architectures) to "we detect internal inconsistency in the book's own price vector" (which is what a pricing-inefficiency site should be doing, and is exactly what the illiquid-secondary-market thesis in the project brief describes).

### 3.2 Pipeline

```
      devigged h2h (Shin)  ─┐
      devigged totals @ L  ─┼──►  DC inversion  ──►  (λ_h, λ_a, ρ)  +  residual r
      devigged btts        ─┘         │                     │
                                      │                     └──► fit quality gate
      team attack/defence ────────────┘                          (reject if r > r_max:
      priors, shrunk to market                                    lines irreconcilable
      where history is thin                                       → data error, not edge)
                                      │
                                      ▼
             price EVERY market from one λ pair:
             1X2 · O/U any line · BTTS · correct score · AH
                                      │
                                      ▼
             compare each to its own devigged price
             emit signal only where the *derivative* market
             disagrees with the *anchor* market
```

Priors: blend historical attack/defence ratings in as a Bayesian prior on the λs where `fixture_predictions` coverage exists, shrinking hard toward the market solution where it doesn't. `research_dc_params` (1,184 rows) and `research_dc_preds` (16,480 rows) already exist as the research track for this.

### 3.3 Naming and versioning

Write the new engine under a **new** `model_architecture` value — `MXDC_V1` — rather than reusing `MARKET_ANCHORED`. Reasons: the existing CLV history stays interpretable, the gate evaluates the new engine on its own clean sample, and rollback is a config flip rather than a data untangling.

---

## 4. Phases

### Phase 0 — Stop the bleeding *(same day, no new code)*

Switch off `API_PREDICTIVE` and `LAMBDA_MC` at the writer, not just at the scorer. Right now the guards strip their claims but the architectures still run and still write rows.

Evidence: −3.26% no-vig CLV on n=230 (z −8.60) and −3.61% on n=167 (z −9.41). These are not underperforming, they are systematically the wrong side of the close, at sample sizes where that is settled.

- **Do not** insert a `LAMBDA_MC` calibration row. Its CLV is the argument for never inserting one.
- `CORNERS_MODEL` / `CARDS_MODEL` (6 rows total, last written 17 July) — delete the codepaths.

**Acceptance:** `select distinct model_architecture from value_signals where detected_at > <cutover>` returns only `MARKET_ANCHORED` and `DIXON_COLES`.

### Phase 1 — Build `MXDC_V1` behind the paper harness *(~1–2 weeks)*

The harness already exists and has never been used — `paper_trades` has **0 rows**, and `paper_trade_gate(p_min_n, p_min_clv, p_min_clv_zscore)` and `settle_paper_trade(...)` are already defined. Use them. `MXDC_V1` writes to `paper_trades`, not `value_signals`. The live board is untouched for the whole of Phases 1–2.

Build order:

1. **Inversion solver.** Input: devigged price vector. Output: `(λ_h, λ_a, ρ)` + residual. Unit-test against synthetic fixtures where you generate prices *from* a known λ pair and check you recover it. This is the piece to get right; everything downstream is arithmetic.
2. **Fit-quality gate.** Define `r_max`. A fixture that can't be reconciled is either a genuine inconsistency or a data error — and after the totals/BTTS `market_prob` incident, assume data error until you've proven otherwise. Log rejects rather than dropping them silently.
3. **Forward pricer.** One λ pair → all goals markets. Reuse the existing DC pricing code.
4. **Signal emission.** Anchor market never emits (you're assuming it's right). Only derivative markets emit.
5. **Paper writer.** Every emission → `paper_trades`, settled by `settle_paper_trade` against the `closing_lines` table (4,607 rows, already built and verified pre-kickoff).

### Phase 2 — Validate against the gate *(~3–4 weeks of live slate)*

Run `MXDC_V1` in paper against the real card. Do not look at yield — look at CLV. At ~47 priced fixtures/day the sample accrues in roughly three weeks; budget four.

**Gate to pass:** `paper_trade_gate(300, 0.0, 2.0)` — n ≥ 300 settled paper trades, no-vig CLV ≥ 0, CLV z ≥ +2.0.

And the same gate **per market family** (1X2 / totals / BTTS), because a headline pass driven entirely by one market is the same failure mode as the +92.7% longshot bucket that flattered the July yield figure.

### Phase 3 — Cut over *(1 day)*

`MXDC_V1` starts writing `value_signals`. `MARKET_ANCHORED` and `DIXON_COLES` stop writing but keep their historical rows and labels. Run both in parallel for one week to confirm the new engine's live rows match its paper rows.

### Phase 4 — Delete *(1 day)*

Remove the retired codepaths, their config, their calibration rows, and the multi-architecture branching in the scorer and the frontend. The board becomes single-source, which also removes the "four generators, no corroboration" problem structurally rather than by policy.

---

## 5. Acceptance tests

| # | Test | Threshold | Phase |
|---|---|---|---|
| A1 | Only two architectures writing | exactly `MARKET_ANCHORED`, `DIXON_COLES` | 0 |
| A2 | Solver recovers known λ from synthetic prices | max abs error < 0.01 goals | 1 |
| A3 | Price coherence holds on every emitted market | `avg(market_prob × detected_odds)` ∈ [0.94, 0.99], zero rows > 1.00, **per market** | 1 |
| A4 | Forward/inverse round-trip | reprice the anchor from fitted λ, recover input probs within 0.005 | 1 |
| A5 | Paper CLV gate, overall | `paper_trade_gate(300, 0.0, 2.0)` passes | 2 |
| A6 | Paper CLV gate, per market family | passes independently for 1X2, totals, BTTS | 2 |
| A7 | Live rows match paper rows | ≥ 95% selection agreement over 1 parallel week | 3 |
| A8 | Single source | `count(distinct model_architecture)` on new rows = 1 | 4 |

A3 is the gate from the market_prob incident, carried forward — it must run per market, not in aggregate, because aggregate is exactly how the totals/BTTS breakage hid.

---

## 6. What gets deleted

- `API_PREDICTIVE` — engine, config, calibration row
- `LAMBDA_MC` — engine, config; **no calibration row is ever added**
- `MARKET_CONSENSUS` — already retired 6 Aug, remove remaining code
- `CORNERS_MODEL`, `CARDS_MODEL` — 6 signals ever, remove
- Multi-architecture branching in the scorer, the board query, and the frontend badge logic
- Per-architecture trust weights (there is only one architecture left to trust)

Historical `value_signals` rows keep their original labels. Nothing is rewritten.

---

## 7. Risks and what would falsify this

**`MARKET_ANCHORED`'s +3.51% is 105 CLV observations against a 300-fixture gate.** It is the best evidence you have and it is directionally clear (z +7.47), but it is not yet proof. The whole plan is a bet that this holds. If `MXDC_V1` fails A5 in paper, the correct response is to stop — not to lower the gate. You have already been through one cycle of "lower the threshold until the band fires"; the answer was that the band was unreachable for a reason.

**The inversion may be too well-determined.** If 1X2 and totals almost always reconcile cleanly, the residual is small everywhere and you get very few signals. That's an acceptable outcome — it means the books are internally coherent and the honest product is lower-volume — but it would materially change the subscription proposition. Phase 1 should measure the residual distribution *before* Phase 2 starts, so you find this out in week two rather than week six.

**Volume drops.** One engine on derivative markets only will emit far fewer signals than four engines emitting freely. If the tier structure assumes a signal count, that assumption needs rechecking against the actual Phase 2 volume, not against today's.

**Corners and cards remain unsolved.** Both paper models show monotone deciles on historical rates but are explicitly **"UNTESTED against prices"**. They are a separate future workstream, and the same paper→gate→cutover discipline should apply to them.

---

## 8. Timeline

| Phase | Elapsed | Gating factor |
|---|---|---|
| 0 — stop the bleeding | same day | none |
| 1 — build behind paper | 1–2 weeks | solver correctness |
| 2 — validate | 3–4 weeks | **live slate accrual — cannot be compressed** |
| 3 — cut over | 1 day + 1 parallel week | A7 |
| 4 — delete | 1 day | — |
| **Total** | **~6–8 weeks** | Phase 2 |

Phase 2 is a wall-clock constraint, not an effort constraint. 300 settled paper trades with closing lines take as long as they take. Everything else can move faster with more effort; that cannot.

---

## 9. Open questions

1. **Anchor choice** — anchor to Pinnacle specifically, or to a devigged multi-book consensus? Pinnacle is the sharper close (659 of 667 backfilled closing lines are already Pinnacle-anchored) but narrows fixture coverage. Consensus covers more but is a softer target.
2. ~~**BTTS as third constraint or third output?**~~ **Resolved in Rev 2** — hold BTTS out *and* fix ρ globally. Holding it out alone makes the system exactly determined and kills the fit residual.
3. **Does `MXDC_V1` emit on 1X2 at all?** If the anchor is h2h, the pure form says no. That removes the market most users expect to see. Worth deciding deliberately rather than by omission.
4. **Correct score and Asian handicap** — free to price from the same λ pair, but each new market surface is new frontend and new settlement logic. In or out of V1?


---

# Revision 2 — 18 August 2026 (post Phase 0)

Phase 0 shipped as written. Three amendments follow from the execution report and from an independent re-check of the CLV evidence.

## R2.1 — The `DIXON_COLES` CLV evidence is withdrawn

§2.1 promoted `DIXON_COLES` to "the goals model" on +1.4% / +2.2% no-vig CLV. That figure does not survive scrutiny. All those selections were chosen by `bestTwoWay`, which took the max price across books *and across 24h of snapshots* — so it systematically selected stale long prices, and a stale long price beats the close close to by construction.

Decomposing no-vig CLV into the price premium captured at detection (detected price vs the contemporaneous median across books at ±2h) and the remainder:

| architecture | market | n | avg books | price premium at detection | no-vig CLV | remainder |
|---|---|---|---|---|---|---|
| `DIXON_COLES` | btts | 56 | 9.3 | **+11.15%** | +2.17% | **−8.98%** |
| `DIXON_COLES` | totals | 145 | 9.8 | **+8.27%** | +1.42% | **−6.85%** |
| `MARKET_ANCHORED` | h2h | 105 | 12.2 | **+7.32%** | +3.51% | **−3.80%** |

The remainder contains both the vig removal (mechanical, roughly −2 to −4% on a two-way book and −4 to −5% per outcome on a three-way) and any genuine movement of the fair line. Netting the mechanical part out:

- `DIXON_COLES` totals and BTTS: the underlying fair line moved **against** the position by roughly 3–7pp. The entire positive CLV is price selection, and what's underneath it is negative.
- `MARKET_ANCHORED` h2h: implied genuine line movement of roughly **+1%**, not +3.51%.

**Consequences.**

1. `DIXON_COLES` keeps its place in the architecture as *code* — the goals pricer is still the right component — but it enters Phase 1 with **no** supporting evidence. Its CLV must be re-earned on rows detected after the `bestTwoWay` fix ships. Nothing downstream may cite +1.4%/+2.2%.
2. `MARKET_ANCHORED` is still the only architecture whose line moves the right way, but its true edge is about a third of the headline. The anchor half of the thesis is supported; it is supported more weakly than Rev 1 claimed.

## R2.2 — New Phase 1 requirement: price liveness

CLV measured against the close **cannot distinguish** "we found a genuinely better price" from "we recorded a price that was never really takeable". Both produce identical positive CLV. An 11% premium over the median of nine books is not plausible line shopping; it is a stale or mismatched quote.

This is now a build requirement, not an analysis note:

- **P1-L1.** Every emitted signal re-quotes its price immediately before write. A price that has moved or vanished is not emitted.
- **P1-L2.** Log the premium over the contemporaneous cross-book median on every emission. A distribution centred materially above ~2% means the selector is still hunting stale quotes.
- **P1-L3.** Report the CLV decomposition above — premium vs remainder — alongside every gate evaluation. **The gate is judged on the remainder, not the headline.**

Without this, `paper_trade_gate` measures stale-quote capture and passes on it.

## R2.3 — BTTS: the constraint count, corrected

The execution report argues for holding BTTS out on the grounds that "three constraints on three parameters is exactly determined and the residual vanishes". The mechanism is right and the conclusion is inverted — adding a constraint can only ever increase overdetermination.

Free parameters: λ_h, λ_a, ρ = **3**. Independent constraints: 1X2 devigged = **2** (three probabilities summing to one), totals at one line = **1**, BTTS = **1**.

- **BTTS held out:** 3 constraints, 3 parameters → **exactly determined. Residual identically zero.** This is the case the report was trying to avoid, and it is the one holding BTTS out produces.
- **BTTS included:** 4 constraints, 3 parameters → overdetermined by 1, residual exists — but BTTS is consumed as an input and is no longer available as a signal market.

**Resolution: hold BTTS out *and* fix ρ globally.** Estimate ρ offline from history as the slow-moving structural parameter it is — fitting it per fixture against three numbers is overfitting regardless. Then 2 free parameters against 3 constraints: overdetermined by one, residual preserved, BTTS retained as a signal market. Both goals met.

Rev 1 also blurred two distinct quantities, which is what made the argument slippery. They are:

- **(a) Fit residual** — the irreconcilability between the anchor markets. Exists only when overdetermined. This is a *diagnostic*: internal inconsistency, or a data error.
- **(b) Out-of-sample divergence** — the model price of a market *not* used in the fit versus its actual price. This is the **signal**, and it exists whether or not the fit is overdetermined.

Signals come from (b). (a) is the quality gate on the fit. §7's "the inversion may be too well-determined" risk applies to (a) only, and R2.3's fixed-ρ resolution addresses it.

## R2.4 — A1 deferred

`select distinct model_architecture from value_signals where detected_at > <cutover>` still returns the old set until the Phase 0 branch is deployed; the running engine is on `main`. Re-check one hour after merge. The `dailyTelemetry` warning on a retired architecture writing a row is the faster tripwire.

## R2.5 — Revised evidence position

| claim | Rev 1 | Rev 2 |
|---|---|---|
| `MARKET_ANCHORED` h2h edge | +3.51% CLV, z +7.47 | ~+1% after removing price selection; direction holds, magnitude does not |
| `DIXON_COLES` goals edge | +1.4% / +2.2% CLV | **withdrawn** — selection artefact over a line that moved against us |
| Architectures with supporting evidence | 2 | **1, weakly** |

This does not change the plan's direction — one market-anchored engine is still right, and it is right on structural grounds (no ensemble effect, 99.6% anchorable slate, coherent multi-market pricing from one λ pair) that never depended on the CLV numbers. It does change the confidence. Phase 2's gate was already the real decision point; it is now the *only* evidence that will exist.


---

# Revision 3 — 18 August 2026 (post Phase 0 verification)

Rev 2's decomposition was verified independently and reproduced (11.15 / 8.22 / 7.17 against 11.15 / 8.27 / 7.32), then sharpened by a better test. Two of Rev 2's conclusions move.

## R3.1 — Takeability replaces premium as the test

**The ~2% premium threshold in R2.2 was asserted and is wrong.** Honest line shopping — best vs median across the bettable panel *within a single snapshot*, so no staleness can enter — is worth **+4.01% h2h, +3.58% BTTS, +3.44% totals**, p95 ~8%. Best-of-nine is *supposed* to beat the median by ~3.5%. Premium magnitude therefore cannot be the test, and Rev 2 over-corrected by treating all price selection as artefact.

**The clean test is takeability:** was the price at or below the best a *bettable* book was showing at the time? A premium over the median can be honest; a price above the contemporaneous maximum cannot be.

| architecture | market | settled | takeable | CLV all | **CLV takeable** | z |
|---|---|---|---|---|---|---|
| `MARKET_ANCHORED` | h2h | 103 | **85.4%** | +3.37% | **+3.17%** | **+6.27** |
| `MARKET_CONSENSUS` | h2h | 172 | 42.5% | −3.98% | +1.39% | +0.88 |
| `DIXON_COLES` | btts | 57 | 40.7% | +2.18% | +1.06% | +0.67 |
| `DIXON_COLES` | totals | 144 | **17.4%** | +1.42% | **−0.43%** | −0.27 |
| `LAMBDA_MC` | h2h | 166 | 53.5% | −3.58% | −2.52% | −4.14 |
| `API_PREDICTIVE` | h2h | 230 | 45.8% | −3.26% | −2.97% | −5.15 |

Shipped as migration 066 (view + health-check section), so this is a standing metric rather than a derivation.

**Consequences, both directions:**

- **R2.5's "~+1%" for `MARKET_ANCHORED` is withdrawn as too harsh.** 85.4% of its prices were available and the restriction barely moves it (+3.37% → +3.17%, z 6.27). It survives the test rather than depending on it.
- **`DIXON_COLES` totals is downgraded further.** 17.4% takeable, and on the 23 surviving rows it is −0.43% at z −0.27 — *unproven*, not merely unmeasured.
- The restriction is not uniformly flattering (`MARKET_CONSENSUS` moves the other way, because its unavailable rows were its worst), which is what makes it credible rather than a filter fitted to a conclusion.

## R3.2 — Gate metric: takeable for diagnosis, unfiltered for publication

Adopted, with one amendment.

| use | metric |
|---|---|
| **Phase 2 gate / internal** | takeable-only CLV, z ≥ 2 |
| **Published performance** | **all** published signals; unplaceable ones counted, never excluded |
| **New gate criterion** | **takeability rate ≥ 90%** |

Excluding unplaceable signals from a public track record is exactly the survivorship bias that produced the retired +14.79% yield figure. A signal published that nobody could place is a signal that failed and belongs in the denominator.

The takeability rate is a **product** metric, not an analysis filter. `DIXON_COLES` totals at 17.4% means five in six published signals were unplaceable — a customer-facing defect that no CLV number on the surviving sixth redeems. `MARKET_ANCHORED` at 85.4% makes 90% a stretch, not a fantasy.

R2.2's "remainder" is retired as the gate metric: it mixes genuine line movement with the mechanical raw→de-vigged conversion and is biased negative by construction.

## R3.3 — P1-L1 is a reallocation, not a spend increase

Ingest cadence broken down by time to kickoff, last 10 days, snapshots per fixture:

| market | T-0 to 2h | T-2 to 6h | T-6 to 24h | T-24h+ | post-KO |
|---|---|---|---|---|---|
| h2h | 1.0 | 1.2 | 2.6 | 2.2 | **3.2** |
| totals | 1.0 | 1.2 | 2.5 | 2.2 | **3.3** |
| btts | 1.0 | 1.2 | 2.3 | 2.1 | 1.9 |

**Finding 1 — cadence is identical across markets.** The 2.3-min vs 135-min quote-age gap between `MARKET_ANCHORED` and `DIXON_COLES` was never a feed problem. Same data, different reach: `bestTwoWay` looked back 24h, `computeConsensus` took the latest. The `bestTwoWay` fix already closes it at zero cost.

> **Falsifiable prediction:** totals/BTTS median quote age should fall from ~135 min to near h2h's ~2 min on the first post-merge run. If it doesn't, the fix didn't do what we think.

**Finding 2 — the pipeline polls harder after kickoff than in the last two hours before it.** Excluding `apifootball_live` (2,519 rows, legitimately 100% post-KO), every pre-match book runs 20–23% post-kickoff: marathonbet 1,376 rows, betfair 1,333, betvictor 1,314, bet365 1,271, pinnacle 921, and so on — roughly **21% of the pre-match odds budget spent on fixtures that already started**, where the quote is suspended or in-play and worthless to a pre-match product.

Reallocating half of that into T-0 to 2h takes the window from 1.0 snapshot per fixture to ~3, which is what P1-L1 needs. **Same spend.** P1-L1 is reinstated as buildable.

*To confirm before reallocating:* some post-KO polling may be vestigial from the old closing-capture path that used to run late. If so it is dead weight now that `closing_lines` enforces pre-kickoff.

## R3.4 — Volume cliff: ship thin (decided)

**Decision: ship the thin board with an honest empty state. Do not publicise the rebuild.**

Once Phase 0 deploys the forward board is ~3 signals. The gap runs until MXDC_V1 publishes — 4–6 weeks. Deliberately accepted rather than filled by republishing negative-CLV architectures.

**Public framing: customer-facing, not internal.** No rebuild announcement, no methodology banner, no "we're improving our models" copy. The surfaces say what is true, briefly, in product language:

- **Empty board:** *"No signals right now. We publish when the price is worth it."*
- **Thin board:** no copy at all — it shows what qualifies.
- **`/performance`:** the existing gate already reads *"not enough settled fixtures to publish a yield"* with an em-dash. That is already customer-facing and non-explanatory. Leave it exactly as is.

**Constraints this decision carries:**

1. Nothing may imply a continuing verified track record during the gap.
2. No social/broadcast post may cite a record. With ~3 signals the volume is near zero anyway.
3. "Don't publicise internals" is not licence to imply business as usual — the empty state must be true, just brief.

**Accepted cost:** a near-empty board for 4–6 weeks against a subscription proposition, with churn risk taken knowingly.

## R3.5 — Evidence position, Rev 3

| claim | Rev 1 | Rev 2 | **Rev 3** |
|---|---|---|---|
| `MARKET_ANCHORED` h2h | +3.51%, z +7.47 | ~+1%, weakened | **+3.17% takeable-only, z +6.27, 85.4% takeable — restored** |
| `DIXON_COLES` totals | +1.4% | withdrawn | **−0.43%, z −0.27, 17.4% takeable — unproven** |
| `DIXON_COLES` btts | +2.2% | withdrawn | +1.06%, z +0.67, 40.7% takeable — unproven |
| Architectures with evidence | 2 | 1, weakly | **1, solidly** |

Net: fewer supported architectures than Rev 1, but the one that remains is supported better than Rev 2 concluded. The plan's direction is unchanged and never rested on these numbers.


---

# Revision 4 — 18 August 2026 (root cause found)

R3.3's *hypothesis* about the mechanism was wrong; its *finding* stands. The post-kickoff polling is not vestigial closing-capture — it is a stale day-plan (`planDay` builds the list at 05:00, `ingestOdds.js:464` then filters only on `nextPollAt`, never on whether the fixture has started). Underneath that sat the real cause: **the fetch loop iterates `plan.fixture_ids`, not `dueIds`** — so tiered polling has been advancing schedules without ever reducing fetches. Roughly a 30× overspend against plan.

That supersedes R3.3's reallocation proposal. Three consequences follow, and the first is a correction.

## R4.1 — P1-L1 is now *affordable*, not *delivered*

R3.3 concluded "P1-L1 needs the tiering to work, which it now does." That is half right. The fetch fix corrects **spend**; it does not change **cadence**, because cadence is set by tier assignment and today all 66 fixtures sit on the 180-minute tier.

A 180-minute tier yields ~0.67–1.0 polls inside a two-hour window — which is precisely the 1.0 snapshot per fixture observed at T-0→2h. Fix the fetch loop and that number does not move. It moves when the closing tier is tightened.

**Concrete target:** P1-L1 wants ~3 snapshots inside T-0→2h. That requires a closing tier of **~40 minutes** for fixtures inside two hours of kickoff. Until that ships, "re-quote immediately before write" still has nothing fresher to re-quote against.

So the status is: the cost barrier is removed, the capability is not yet built.

## R4.2 — Ship the two changes separately

Do **not** tighten the tiers in the same deploy as the fetch fix.

`odds_api_daily_caps` is a static forward plan written 5 Aug, allocating **~70.6 credits per scheduled match per day** (e.g. 148 matches → 10,453). It is an allocation table, not a consumption log — so nobody currently knows what the engine actually spends, only what it was budgeted. Observed coverage is ~6.9 pre-kickoff snapshots per fixture, which suggests real headroom inside that envelope, but that is an inference, not a measurement.

Sequence:

1. Deploy the fetch fix alone.
2. Observe **one full day** of actual credit consumption against the ~70.6/match envelope.
3. Size the closing tier from measured headroom.

Raising `DAILY_REQUEST_BUDGET` before step 2 spends against a number nobody has measured. This project has already paid once for changing several variables at once and not being able to attribute the result.

## R4.3 — The R3.1 takeability rates are a floor, not a property

This is the consequence worth carrying forward. If the 30× overspend forced `pollBudget` to widen every fixture to the coarsest tier, then **every quote in the corpus was stale by construction** — which is a large part of why 83% of `DIXON_COLES` totals prices sat above the contemporaneous maximum.

So the R3.1 table measures architectures *through a broken feed*:

- 17.4% takeable for `DIXON_COLES` totals is not that architecture's ceiling. Much of it is feed staleness, not selector behaviour.
- Equally, 85.4% for `MARKET_ANCHORED` was achieved *despite* the broken feed, which strengthens rather than weakens it.
- **`MXDC_V1` must be baselined on post-fix data.** It does not inherit these rates, in either direction.

What does *not* change: `DIXON_COLES` totals returned −0.43% at z −0.27 on the rows that *were* takeable. A fresher feed gives it more rows to be judged on; it does not make those rows better. The architecture is still unproven — it is now merely unproven for a reason that can be fixed.

The 90% takeability gate in R3.2 stands, and becomes more reachable rather than less.

## R4.4 — Falsifiable prediction, restated

R3.3's prediction is withdrawn as stated. h2h's ~2-minute median quote age was measured *under* the broken fetch, where everything was polled every run — so after the fix h2h will poll to its tier and its own median will **rise**.

Corrected test, to run one engine cycle after merge:

1. totals/BTTS median quote age **converges on h2h's**, whatever level that settles at. (Tests the `bestTwoWay` reach fix.)
2. h2h's own median rises toward its tier interval. (Confirms the fetch fix is actually reducing polls.)
3. Post-kickoff rows for pre-match books fall to ~0%. (Tests the runtime kickoff filter.)
4. Actual credits consumed per match lands materially below 70.6. (Sizes the headroom for R4.2 step 3.)

If (2) does not happen, the fetch fix did not take effect.


---

# Revision 5 — 18 August 2026 (odds is a change log)

`ingestOdds` writes a row only when `oddsHaveMoved(last, row)`. `odds` is a **price-change log, not a poll log**. Two Rev 4 conclusions rest on reading it as the latter, and both fall.

- **R4.1's mechanism is withdrawn.** "A 180-minute tier yields ~1 poll in a two-hour window, matching the observed 1.0" was a coincidence of numbers. The 1.0 is 1.01 *recorded price movements* per fixture-book, logged while the broken fetch was polling every planned fixture every run. Polling in that window was maximal; tier intervals gated nothing. R4.1's *conclusion* — P1-L1 is affordable, not delivered — survives, but on the arithmetic (3 polls in 2h needs a ~40-min interval), not on that inference.
- **R4.3 is withdrawn entirely and inverted.** The 30× overspend meant *more* polling, not less. The takeability corpus was collected under maximal polling, so it is not a floor depressed by stale tiers. `DIXON_COLES` totals at 17.4% is `bestTwoWay`'s 24-hour lookback — already fixed. And `MARKET_ANCHORED`'s 85.4% was achieved *because* the feed over-polled: `computeConsensus` takes the latest quote per book, and under maximal polling "latest" was genuinely fresh. **85.4% is the favourable case, not the depressed one.**

## R5.1 — The fetch fix alone is a freshness regression

Correct, and it is the sharpest point in this exchange. The bug was buying maximal polling by accident. Due-only polling drops a 180-minute-tier fixture to roughly one look in its final three hours, in the window where prices move ~5× faster per hour than a day out. That reintroduces exactly the phantom-price condition `price_was_takeable()` measures — during the measurement week.

The ≥40-minute floor inside T-2h is the right shape: it expresses R4.1's arithmetic without pre-empting `pollBudget`'s ownership of tiers, and ~300 requests on a 101-fixture Saturday against the ~2,570 the bug was already spending means net spend still falls sharply.

## R5.2 — New: takeability *improves* with lead time

Takeability by detection lead, both surviving architectures (best contemporaneous price across all books, ±15 min — looser than the bettable-panel view, so levels differ; the gradient is the point):

| architecture | ≤2h | 2–6h | 6–24h | >24h |
|---|---|---|---|---|
| `MARKET_ANCHORED` | 78.9% (n=19) | 87.5% (n=24) | 78.1% (n=32) | **96.7%** (n=30) |
| `DIXON_COLES` | 38.2% (n=55) | 41.7% (n=60) | 53.3% (n=60) | **62.5%** (n=16) |

The gradient runs the opposite way to intuition, and your own movement table explains it: prices move 0.51×/hour inside T-2h against 0.11×/hour a day out. Under uniform (maximal) polling, freshness was constant across lead times, so what this isolates is pure **volatility** — near kickoff a recorded price is beaten sooner, so it fails takeability more often.

**Two consequences.**

1. **The floor is well placed.** The closing window is the *hardest* window for takeability, not the easiest. Putting the tightest interval there is correct, and my instinct to widen the floor out to 6–12h — on the theory that long-lead signals would degrade most — was wrong. Dropped.
2. **But 40 minutes cannot beat maximal polling.** Today's ≤2h numbers were measured under maximal polling and still only reached 78.9% / 38.2%. Post-fix that window runs at 40-minute freshness against unchanged volatility, and the 2–24h band — roughly 60% of `MARKET_ANCHORED`'s volume, median lead 9.2h — goes from maximal to tier-governed. **The regression is real in every window; the floor mitigates it in the one that matters most.**

## R5.3 — Do not set the takeability threshold yet

R3.2 fixed the gate at ≥90%. That number was calibrated against 85.4% observed **through the bug**, under polling no post-fix configuration will reproduce. Setting it now calibrates against an artifact — the same error as the original σ constants and the PRIME threshold.

**Amendment:** ship `paper_trade_gate`'s takeability criterion with the threshold *parameterised and unset* (or set permissively, and marked provisional in the migration comment). Measure the takeability distribution for **one full week post-fix**, across lead-time buckets, then set the threshold from the observed post-fix distribution.

The criterion's *place* in the gate — asked first, before CLV, with the sample unfiltered — is unchanged and right. Only its value waits.

Detection-lead context for that measurement (last 21 days):

| architecture | median lead | p90 | ≤2h | ≤6h |
|---|---|---|---|---|
| `MARKET_ANCHORED` | 9.2h | 38.8h | 17.6% | 39.8% |
| `DIXON_COLES` totals | 4.4h | 19.7h | 29.6% | 64.8% |
| `DIXON_COLES` btts | 5.3h | 30.4h | 31.6% | 54.4% |

## R5.4 — Open question for Phase 1: takeability is measured at detection, not at delivery

`price_was_takeable()` asks whether the price was available *when we detected it*. With a 9.2-hour median lead on the one architecture that works, there is a lot of room between detection and a subscriber acting. A price that was genuinely best-of-panel at T-9h and gone twenty minutes later passes takeability and still fails the user.

Not a blocker and not a reason to delay anything — the CLV numbers partly absorb it, since an illusory long-lead price should show up as poor CLV. But it is the right question to settle when `MXDC_V1`'s emission policy is designed: **what is the signal's advertised shelf life, and is takeability measured against that window rather than against the detection instant?**

## R5.5 — Fetch-fix verification, corrected

R4.4's load-bearing check ("h2h's median quote age should rise") is withdrawn — it reads a change log and its timestamps track volatility, not polling.

Replaced with the direct observation: the run-log line **`[ingest] fetching N of M planned fixture(s)`**. Pre-fix N ≡ M. Post-fix N should be a small fraction of M outside the closing window, plus the floor's additions inside it. The remaining Rev 4 checks stand: post-kickoff rows for pre-match books fall to ~0%, and credits/match lands materially below the 70.6 envelope.


---

# Revision 6 — 18 August 2026 (paper-trade harness audit)

`paper_trades` has never held a row, and it is the vessel for the only evidence Phase 2 will produce. Audited before Phase 1 starts. The dedup finding confirms; two further issues would have distorted the gate rather than blocked it, which makes them worse.

## R6.1 — The dedup index is worse than "missing `match_id`"

```sql
CREATE UNIQUE INDEX paper_trades_dedup_idx ON paper_trades
  (COALESCE(external_ref, ''), model, market, COALESCE(market_line, -1), selection);
```

`match_id` is absent, as reported — but the `COALESCE(external_ref, '')` is the sharp edge. With `external_ref` null, every fixture collapses to the same key. The table would then hold **one row per (model, market, line, selection) for all time** — on the order of 10–15 rows total for `MXDC_V1`, against a 300-trade gate. Populating `match_id` does not help; it isn't in the index.

Whether that surfaces as an error or as silence depends on the writer: with `ON CONFLICT DO NOTHING` it reads as low emission volume for weeks. **`MXDC_V1` must populate `external_ref` per fixture**, and Phase 1 should assert it — a not-null constraint, or a test that inserts two fixtures and asserts two rows.

## R6.2 — Unmeasurable takeability silently leaves the denominator

```sql
n_checkable := count(*) filter (where takeable is not null)
takeable_rate := n_takeable / nullif(n_checkable, 0)
```

Rows where `price_was_takeable()` returns null — no contemporaneous quotes to check against — drop out of the denominator entirely. **The prices too phantom to verify are invisible to the metric built to catch them.**

The existing `n_checkable = 0 → HOLD` guard only fires when *every* row is unmeasurable. If 40% are unmeasurable and the remaining 60% are 95% takeable, the gate reports 95% and passes on 60% of the evidence.

This is the survivorship pattern that produced the retired +14.79% yield, one level down. Two fixes, and I'd take both:

1. **Count unmeasurable as not-takeable.** If you cannot demonstrate the price existed, it didn't. That is the same standard R3.2 applied to published performance.
2. **Report measurable coverage** (`n_checkable / total`) as its own column, and HOLD below ~90%. A takeability rate computed on half the sample should not be able to pass quietly.

*(The null semantics of `price_was_takeable` are inferred from the `is not null` filters rather than read from its source — worth confirming.)*

## R6.3 — The gate's CLV z-score is not fixture-clustered

```sql
clv_sd := stddev(no_vig_clv)
n_clv  := count(no_vig_clv)
zscore := clv / (clv_sd / sqrt(n_clv))
```

`n_clv` counts **rows**, not fixtures. Paper trades will cluster by fixture exactly as live signals do — one λ pair produces several selections on the same match, whose outcomes are correlated.

This is the error already found and fixed for published stats, reappearing in the gate that decides cutover. On the current corpus: **879 CLV-bearing rows across 342 fixtures — 2.57 per fixture, implying z inflated by ~1.60×.** A reported z of 2.0 is a fixture-clustered z of roughly 1.25. `MXDC_V1` pricing multiple markets from one fit will cluster at least as hard, plausibly harder.

`p_min_clv_zscore = 2.0` is therefore not the bar it appears to be. Fix by clustering the standard error — aggregate CLV to one value per fixture (or per fixture × market family) before computing sd and n, matching what `compute_performance_summary` now does for published figures. Raising the threshold instead is guesswork; clustering is the correct estimator.

**This is the single most consequential item in this revision.** It is the threshold the entire consolidation is gated on, and it currently reads ~1.6× optimistic.

## R6.4 — Minor

- `CHECK (model_prob > 0 AND model_prob < 1)` is strictly exclusive. A DC pricing a deep tail (a high totals line, an extreme correct score) can round to exactly 0 or 1 and throw on insert. Clamp to `[ε, 1−ε]` before write.
- `avg(no_vig_clv)` is taken over all rows, not just settled — correct, since CLV needs a close and not a result, and it keeps the sample unfiltered. Worth stating explicitly so nobody "fixes" it into a settled-only filter later.
- `n` counts `result in ('win','loss')`, so voids are excluded from the 300 and from yield. Consistent — but if unplaceable signals are to be settled as `void`, confirm that is the intent, since R3.2 requires them counted in published performance.
- No FK from `paper_trades.match_id` to `matches`, so a bad id will not error. Low priority given `external_ref` is now the join key that matters.

## R6.5 — Status

R5.3 is actioned correctly, and the unset-threshold verdict string (`PASS (takeability X% — not yet thresholded)`) is the right instinct — a criterion nobody has set must not read as one something has met.

Outstanding before Phase 1: the merge, the A1 check, the `--backfill` run, the four post-fix verifications, and R6.1–R6.3.


---

# Revision 7 — 18 August 2026 (sample-size policy)

## R7.1 — R6.3's magnitude is withdrawn; the conclusion stands

Measuring per architecture beats the √m estimate, and it breaks two assumptions in R6.3:

- **√m is not an upper bound.** `MARKET_CONSENSUS` inflated **2.52×** against √2.42 = 1.56. Averaging within a fixture changes the variance structure, not merely the count.
- **Clustering can raise z.** `MARKET_ANCHORED` 7.62 → 9.00, `DIXON_COLES` btts 2.64 → 3.49.

So "a reported 2.0 is really 1.25" does not generalise, and the architecture the plan depends on is the least affected. **Withdrawn.** The conclusion it supported — compute the clustered estimator rather than adjust the threshold — is reinforced rather than weakened, since a global adjustment would have been wrong in both directions at once.

**One caution on reading those numbers.** `MARKET_ANCHORED` emits ~1.18 selections per fixture, so clustering is very nearly a no-op there and 7.62 → 9.00 is sd-estimation noise at n=89, not a strengthening. Nobody should cite 9.00 as the model having improved. The honest statement is that clustering leaves `MARKET_ANCHORED` materially unchanged — which is the good news, because it means its edge was never a clustering artefact.

## R7.2 — `p_min_n` should count fixtures, and should scale with variance

The open policy call: `p_min_n` still counts rows, so 300 trades at ~2.5 selections per fixture is ~120 fixtures.

Fixture-clustered CLV standard deviations, and the fixtures needed to detect a **+1.0%** clustered CLV at 80% power, 5% two-sided:

| architecture | market | fixtures | clustered CLV | **clustered sd** | n for +1.0% | n for +2.0% |
|---|---|---|---|---|---|---|
| `MARKET_ANCHORED` | h2h | 89 | +3.48% | **3.64%** | 105 | 27 |
| `DIXON_COLES` | totals | 92 | +1.14% | **3.77%** | 112 | 28 |
| `DIXON_COLES` | btts | 48 | +1.98% | **3.94%** | 122 | 31 |
| `LAMBDA_MC` | h2h | 67 | −3.42% | 4.51% | 160 | 40 |
| `API_PREDICTIVE` | h2h | 102 | −2.70% | 6.17% | 299 | 75 |
| `MARKET_CONSENSUS` | h2h | 71 | −1.66% | **11.05%** | **960** | 240 |

CLV variance tracks the odds profile: market-anchored short-to-mid odds sit at 3.6–3.9%, the longshot-heavy `MARKET_CONSENSUS` at 11.05%. A flat sample-size bar is therefore the wrong instrument — it is far too strict for the first group and far too lax for the second. **A high-variance longshot strategy passing on a small sample is exactly what the +92.7% bucket did to the original yield figure.**

**Recommendation — a self-calibrating bar:**

```
required_fixtures = max(150, ceil((2.802 * clustered_clv_sd / 0.010)^2))
```

- Powers the gate to detect a **+1.0% clustered CLV** — the smallest edge worth acting on after costs.
- On the sd profile `MXDC_V1` should actually have (3.6–3.9%), that resolves to the **150 floor**, since the computed requirement is 105–122.
- If `MXDC_V1` turns out noisier, the bar rises automatically. At an 11% sd it would demand 960 fixtures — correctly refusing to certify a longshot book on a short sample.
- 150 fixtures against today's ~120-fixture equivalent is a modest tightening, roughly 25% more wall-clock, not a new phase.

**Caveat:** estimating required-n from the same sample's sd is mildly circular — a luckily-low sd lowers its own bar. The 150 floor absorbs most of that; if you want it airtight, use the upper bound of a 90% CI on sd rather than the point estimate.

This replaces `p_min_n = 300` rows. It is reversible and costs nothing to revisit once `MXDC_V1` has produced a real sd.

## R7.3 — Accepted as shipped

- `external_ref` NOT NULL, verified by insert. A convention is what produced the finding.
- Unverifiable counted as not-takeable, with coverage as its own column so "couldn't check" and "checked and failed" stay distinguishable.
- Zero coverage holds unconditionally rather than depending on an unset parameter — right call, and the same class as `n_clv = 0`.
- `model_prob`'s exclusive CHECK kept, clamp pushed to the writer. Widening a correct constraint to accommodate a rounding writer would be fixing the wrong half.
