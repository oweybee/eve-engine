# In-play win-probability engine (international + universal) — design

Status: **proposal / for review**. No code yet.

## Goal

Deliver in-play value signals for matches the half-time supermodel can't serve —
internationals (World Cup, Copa América, Euro, AFCON) above all — by holding an
**independent live win probability** against the live price:

    edge = p_model(outcome | current score, minute) × live_odds − 1

This is the "Brazil went 1-0 down but is still value" signal, generalised to any
competition.

## Why not a trained international half-time model

The DB has **37,720 completed matches** (incl. all the internationals we want)
but **no half-time scores anywhere** — `fixture_predictions` and `matches` store
full-time goals + xG only. The supermodel's entire edge is its HT-state features,
so there are **no labels to train an international half-time model on**. Backfilling
HT from API-Football is possible but costly, patchy on older/minor fixtures, and
still leaves ML-validation risk.

So instead of *learning* in-play patterns we *compute* the live probability from a
pre-match goal model — the industry-standard approach, and one we can validate.

## Architecture

Two pieces, both competition-agnostic:

### 1. Pre-match goal expectations (λ_home, λ_away)
At/near kickoff, capture the expected goals for each side. Source options
(in preference order):
- **Invert the pre-match consensus 1X2.** We already de-vig the market to fair
  1X2 in `computeValues.js`; `lib/dixonColes.js` already maps goal expectations →
  scoreline matrix and is "anchored to the consensus 1X2". Solve the inverse:
  find (λ_home, λ_away) whose Dixon-Coles 1X2 matches the de-vigged market. This
  needs no team-strength data and works for any fixture with a market.
- **Fallback: Dixon-Coles attack/defence** fitted from the 37k full-time results
  (a standard Poisson MLE with team attack/defence + home effect), used when a
  clean pre-match market isn't available.

Persist the captured baseline once per match: `inplay_baseline(match_id,
lambda_home, lambda_away, source, captured_at)`.

### 2. Live remainder probability
Given current score (x, y) at minute m:
- Remaining-time fraction `f = clamp((90 − m), 0, 90) / 90` (stoppage handled by
  flooring at a small ε near 90').
- Remaining goals: `H_rem ~ Poisson(λ_home · f)`, `A_rem ~ Poisson(λ_away · f)`,
  independent (Dixon-Coles low-score correction optional in v2).
- Final score = (x + H_rem, y + A_rem). Sum the joint Poisson mass over the grid
  (0..K each, K≈10) to get `P(home win)`, `P(draw)`, `P(away win)`.
- Compare each to the best live price → edge; emit when `edge ≥ INPLAY_EV_THRESHOLD`
  and `≤ INPLAY_MAX_EDGE`.

Optional in-play adjustments (v2, only if data available):
- **Red cards**: scale the sent-off side's λ down (needs live cards — not ingested
  today; documented gap).
- **Game-state damping**: leading teams score/concede at modified rates; a small
  empirically-calibrated multiplier. Off in v1 (keep it principled and inspectable).

## New / changed components

| Component | Type | Purpose |
| --- | --- | --- |
| `lib/inplayWinProb.js` | new, pure | λ→scoreline, live remainder, P(outcome). Unit-tested. |
| `lib/dixonColes.js` | reuse/extend | add the consensus→λ inversion helper |
| `inplay_baseline` table | new migration | stores pre-match (λ_home, λ_away) per match |
| baseline capture | new step | at kickoff (last pre-match compute), write the baseline |
| `computeInplayValues.js` | extend | new stage: win-prob signals (`model_architecture='INPLAY_DIXON_COLES'`) |
| `run-inplay.yml` | reuse | already ingests live score/minute/odds |
| migration | new | register `INPLAY_DIXON_COLES` in the model_architecture check |

No frontend changes — in-play signals already surface on `/in-play` and the
in-play performance row.

## Validation / backtest plan (before it posts anywhere)

1. **Pre-match calibration** — backtest the λ baseline's implied 1X2 against the
   37k full-time results: Brier score, log-loss, reliability curve, vs the market
   as benchmark. Gate: must be ≈ market-calibrated (it's anchored to it).
2. **Live-maths verification** — unit tests that the remainder probabilities are
   exact for known cases (m=90 → current score decides; m=0 → equals pre-match;
   2-0 with 5' left → home ≈ certainty). Monte-Carlo cross-check.
3. **Forward-test, no posting** — run the stage writing `phase='inplay'` signals
   with `INPLAY_MODEL_ENABLED` on but `TELEGRAM_INPLAY_CHAT_ID` unset, for N weeks.
   Read the in-play `performance_summary` row (realised yield / strike rate) and a
   calibration check (model prob vs realised outcome) before enabling posting.
4. **Sanity vs market repricing** — confirm the model roughly tracks how the live
   market reprices after goals; persistent large divergence ⇒ investigate, don't
   publish.

## Activation gates (safety)

- Pre-match baseline captured (else skip — no anchor, no signal).
- A live price present for the outcome.
- `INPLAY_MAX_EDGE` cap (reject calibration artefacts).
- Minute window guard (skip the chaotic last ~2–3' / deep stoppage).
- Behind `INPLAY_MODEL_ENABLED`; posting additionally gated on the forward-test
  passing and `TELEGRAM_INPLAY_CHAT_ID` being set.

## Honest limitations

- Constant-λ Poisson ignores momentum, red cards (not ingested), fatigue, tactical
  game-state. v1 is deliberately principled-but-simple; v2 can add damping/cards.
- Edge quality is bounded by the pre-match anchor: if the market's pre-match price
  was off, so is our baseline.
- The live market is fairly efficient and edges close in seconds–minutes — the
  GitHub Actions */5 cadence is a real limiter; genuine capture likely needs the
  short-loop worker noted in `run-inplay.yml`.
- "Value" here is model-vs-market divergence, not certainty; sizing/variance still
  apply.

## Phased build

1. **Maths core + tests** — `lib/inplayWinProb.js`, consensus→λ inversion, full
   unit/Monte-Carlo coverage. (No DB, fully verifiable.)
2. **Baseline capture** — `inplay_baseline` migration + capture step.
3. **Wire the stage** — `computeInplayValues.js` win-prob stage, gated + capped.
4. **Backtest harness** — pre-match calibration script over the 37k results.
5. **Forward-test** — enable signal *recording* (no posting); review in-play
   performance + calibration.
6. **Enable posting** — only after 3–5 pass.

## Open decisions for you

- **λ source**: market-inversion only (simplest, market-dependent) vs also fit
  Dixon-Coles from the 37k results (more work, independent fallback)?
- **Scope**: internationals only first, or universal (clubs too) from day one?
  (The engine is identical; it's just which fixtures we let through the gate.)
- **Red cards in v1**: ingest live cards now (extra `ingestLiveOdds` work) or
  defer to v2?
