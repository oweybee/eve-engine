# The scoring anchor cannot be the selection anchor

**19 Aug 2026.** `paper_trade_gate` could not fail `MARKET_ANCHORED`. This is
what was wrong, what was built, and what survives once it is fixed.

---

## 1. The circularity

`MARKET_ANCHORED` selects the outcome whose best bettable price most exceeds
**Pinnacle's Shin-de-vigged fair line**. `no_vig_clv` scored that same price
against **Pinnacle's Shin-de-vigged closing line**. Same books, same de-vig,
same line — two timestamps.

The identity `no_vig_clv = ln(detected_odds / no_vig_odds)` was verified against
`closing_lines` to a max error of 5e-5, so CLV splits exactly:

    no_vig_clv  =  ln(1 + detected_edge)  +  ln(p_anchor_close / p_anchor_detect)
                   └── the selection rule ──┘   └──── where skill would live ────┘

Over 89 settled fixtures, fixture-clustered:

| | |
|---|---|
| no-vig CLV | **+3.475%** |
| edge at detection, vs the same anchor | **+3.844%** |
| **anchor line movement toward the selection** | **−0.369% (z −0.91)** |

The headline was the selection threshold restated. Pinnacle's own line does not
move toward the pick. **A gate whose metric is the selection rule is not a weak
test; it is not a test.**

---

## 2. The independent anchor

`closing_lines_independent` (migration 073): the last price vector quoted
strictly before kickoff, taken as the **median across the bettable panel with
Pinnacle excluded**, then Shin-de-vigged. Minimum five books. Same pre-kickoff
enforcement as `closing_lines` — a row-level CHECK plus a 12-hour staleness
window — and it is stored **alongside** the Pinnacle anchor, never instead of it.

`captureIndependentLines.js` is the ongoing writer and de-vigs through
`lib/devig.js`, the single Shin implementation. The one-off backfill inside the
migration uses a bisection in SQL, verified against that module on real 2- and
3-outcome vectors: **max |Δz| 1.5e-10, max |Δp| 6.3e-11**, every de-vigged
vector summing to 1.000000000.

Coverage, last 30 days: **635 h2h · 615 BTTS · 610 totals** fixtures against
Pinnacle's 705. Zero rows carry `pinnacle` in `books`; zero quotes after kickoff.

**It is a softer line, and that matters when the two CLVs are compared.** Panel
median overround runs 1.075 h2h / 1.081 BTTS / 1.066 totals against the Pinnacle
side's 1.046 / — / 1.043. A soft benchmark flatters CLV relative to a sharp one,
so the fall from the Pinnacle figure to the independent figure understates the
circularity rather than exaggerating it.

**A median, not a best price.** The benchmark has to be what the market
believed, not what the luckiest book showed; a max-of-panel close would bake the
line-shopping premium into the benchmark itself.

---

## 3. The gate precondition

Migration 074. A **precondition**, ahead of sample size, takeability and CLV.

- `scoring_anchor` — every benchmark, described by the three things that make a
  yardstick: **which books, which de-vig, which line**. Timestamp is
  deliberately not part of the key; "the same line at a later moment" is the
  tautology being refused.
- `model_selection_anchor` — what each model optimises against. All five live
  architectures are declared.
- `paper_trades.scoring_anchor` — a **column, not a gate parameter**, because a
  default parameter can be overridden by whoever calls the gate and a column
  cannot. Book sets are compared as actual book lists, so a scope renamed or
  narrowed cannot silently stop overlapping.

Every branch was **probed in a rolled-back transaction** against real fixtures;
`paper_trades` is still at 0 rows.

| condition | verdict |
|---|---|
| scoring anchor == selection anchor | `HOLD - scoring anchor (pinnacle_anchor) IS the declared selection anchor: same books, shin de-vig, own_vector...` |
| model has no declaration | `HOLD - ... has not declared a selection anchor, so independence ... cannot be shown` |
| two anchors in one group | `HOLD - 2 different scoring anchors mixed into one CLV figure` |
| anchor absent from the catalogue | `HOLD - ... not in scoring_anchor, cannot be checked for independence` |
| books overlap, line kind differs | `PASS (... - WARNING: shares books with the selection anchor, independence is partial ...)` |
| no overlap | `PASS (anchor independent_consensus; ...)` — no warning |

---

## 4. Re-baseline

Takeable-only, fixture-clustered, as §7 requires. `edge at detection` is against
the **independent** fair line — the same quantity `detected_edge` is against
Pinnacle's — so the three columns add up: `CLV = edge at detection + movement`.

| architecture | market | fixtures | CLV vs **Pinnacle** anchor | z | CLV vs **independent** anchor | z | edge at detection | **movement** | z |
|---|---|---|---|---|---|---|---|---|---|
| `MARKET_ANCHORED` | h2h | 75 | **+3.05%** | 7.05 | **+1.38%** | 2.89 | +0.40% | **+0.98%** | **2.75** |
| `API_PREDICTIVE` | h2h | 54 | −3.15% | −4.18 | −3.40% | −4.48 | −2.99% | −0.40% | −0.54 |
| `LAMBDA_MC` | h2h | 44 | −3.02% | −4.30 | −2.53% | −3.95 | −3.51% | +0.98% | 1.76 |
| `DIXON_COLES` | totals | 20 | −0.55% | −0.30 | +0.87% | 0.47 | +1.37% | −0.50% | −0.64 |
| `DIXON_COLES` | btts | 20 | +0.40% | 0.36 | +0.40% | 0.36 | +0.09% | +0.30% | 0.38 |

### Something survives, and it is smaller than advertised

`MARKET_ANCHORED` falls from **+3.05% to +1.38%** — the circularity was worth
**1.67pp, 55% of the headline** — and what is left is not zero: **+1.38% at
z 2.89**, of which only +0.40% is the detection-time edge and **+0.98% (z 2.75)
is genuine movement of a Pinnacle-free consensus toward the selection.**

Two checks that it is real rather than an artefact of the transform:

- **It is differential, not a general drift.** On the same 75 fixtures the two
  outcomes the model did *not* pick move **−0.44% (z −1.95)**. The legs sum to
  roughly zero, as the probability constraint requires.
- **It does not scale with the disagreement.** Regressing movement on the
  detection-time Pinnacle-minus-soft gap gives slope **−0.146 ± 0.114**
  (t −1.28, r² 0.02) against a +1.49% intercept — so it is not a mechanical
  "close a fixed fraction of the gap". At n=75 this regression is underpowered
  and should be re-run at the 150-fixture bar.

### What the surviving number actually claims

Pinnacle's de-vigged probability exceeds the soft panel's by **+3.43%** on the
selected outcome at detection, and the soft panel then closes about **29%** of
that gap by kickoff. **The mechanism is soft books converging on Pinnacle, and
`MARKET_ANCHORED` is positioned on the right side of that convergence.**

So the independent anchor removes Pinnacle from the **price**, not from the
**causal chain**. That is a weaker circularity than the one it replaces — the
selection rule never referenced the independent panel's closing line, and
whether that line subsequently moves is a fact about the future, which is
exactly what CLV is for — but the honest claim is *"the soft market came to
us"*, resting on Pinnacle being sharper than the panel. It is **not** *"our
model beat the market"*. Anything published should say the first.

Realised P&L on the same 75 takeable fixtures is **+29.95% (z 2.11)**,
fixture-clustered. Unfiltered — the published-performance basis, which never
filters — the same architecture is **+13.58% over 90 fixtures at z 1.06**, which
`/performance` already withholds as `insufficient`. Neither is a result yet.

### The other three moved little, as expected — with one thing worth knowing

`API_PREDICTIVE` and `LAMBDA_MC` select against a model probability, so they had
no shared yardstick to lose, and their verdicts survive the anchor change intact
(−3.40% and −2.53%). But the **decomposition** says something the totals never
did: their loss is **not** the line moving against them. Their movement terms are
−0.40% (z −0.54) and +0.98% (z 1.76) — nothing. It is **all** in the detection
edge, at **−2.99%** and **−3.51%**: they select prices that are already below
the independent panel's own fair line at the moment of detection.

That is not a bad-price bug. All four architectures take the panel maximum
(`API_PREDICTIVE` 100%, `DIXON_COLES` 100%, `MARKET_ANCHORED` 100%, `LAMBDA_MC`
93.3%, shortfall −2.31% on the remainder). They take the best price available
and it is *still* short of fair, because they pick the outcome their model likes
rather than the outcome the price favours. **They were not unlucky; they were
paying above fair value from the first tick.**

---

## 5. BTTS has no independent anchor, and cannot get one from these books

**Pinnacle does not price BTTS.** Every BTTS row in `closing_lines` therefore
carries `basis = 'consensus'` — the bettable-panel median — which is exactly
what the "Pinnacle-excluded" anchor is. Measured across every matched row:

| market | rows compared | identical fair prices | mean abs difference |
|---|---|---|---|
| h2h | 1,896 | 15 (0.8%) | 0.156 |
| totals | 1,214 | 15 (1.2%) | 0.031 |
| **btts** | **1,224** | **1,224 (100%)** | **0.0000** |

For BTTS the two anchors are the same line, to the last decimal. That is why
`DIXON_COLES` btts reads +0.40% against both. **Excluding Pinnacle from a
benchmark Pinnacle was never in is a no-op**, and no amount of it will make a
BTTS figure independent of the panel `DIXON_COLES` selects its best price from.

The gate says so — the `WARNING: shares books with the selection anchor` branch
fires — but a warning is the weakest true thing available here. **A genuinely
independent BTTS benchmark needs books the selection never saw**: hold out a
fixed half of the panel for scoring, or leave out the book that supplied the
taken price. Neither is built. Do not read the BTTS row as validated.

`DIXON_COLES` totals is separately uninformative at **20 takeable fixtures** —
far below anything the powered bar would accept.

---

## 6. What this does not settle

- The re-baseline is measured on data captured **before** the ingest fixes
  merged (`4c408e9`, 08:58 UTC 19 Aug). It is a measurement, not a threshold,
  and no threshold has been set from it. Re-measure after one clean week.
- 75 takeable fixtures is half the powered bar. The movement term at z 2.75
  is suggestive, not certified.
- The decisive test the corpus cannot yet run: does the movement **predict the
  outcome**? That is what separates "the soft market came to us" from "the soft
  market came to us and was right". At the 150-fixture bar it becomes answerable.
