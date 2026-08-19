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

| | live ladder (stale) | corrected corpus |
|---|---|---|
| teams rated | 968 | **1,226** |
| teams past 10 games | 430 | **1,017** |
| teams past 30 games | **226** | **881** |
| team-games | 80,622 | **172,594** |

**The right-hand column was a projection when this section was written. It is
now confirmed against `elo_corpus` (21:30 UTC 19 Aug), and it replaced an
earlier projection of 1,314 / 1,089 / 948.** That earlier set was taken before
migration 076 deduplicated the corpus, so it counted 6,199 fixtures twice and
split ~57 clubs across two ladder entries. Measuring beats projecting twice over.

**The live ladder is still the stale one, and the gap is the whole point of this
check.** `team_elo` was last rebuilt at 15:19 UTC — before the backfill landed at
18:26 and before the corpus view existed. Its 80,622 team-games are exactly
2 x 40,311, the pre-backfill completed count. `computeElo` reads `elo_corpus` on
`main` as of the merge, and self-gates at `ELO_REFRESH_HOURS=6`, so the next
engine tick rebuilds it.

On the window that matters -- the next 48 hours, which is as far ahead as prices
exist at all -- 77 fixtures, 70 priced by 3+ books, and both clubs past 30 games
on **57 of them: 81.4%**. The same query against the live ladder, keyed the way
that ladder was actually written, returns **5**. Rating maturity stops being the
binding constraint the moment the rebuild lands.

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

### 6b. Post-rebuild, confirmed against the database (19 Aug 2026, 22:5x UTC)

The ladder rebuilt at **21:47:09** in engine run `32305200497` (SHA `c72f069`,
so `computeElo` was reading `elo_corpus` and this is the CORRECTED ladder, not
the old one). Verified directly rather than inferred:

| | pre-rebuild (15:19) | post-rebuild (21:47) |
|---|---|---|
| teams rated | 968 | **1,226** |
| past 10 games | — | **1,017** |
| past 30 games | 226 | **881** |
| team-games | 80,622 | **172,594** |

Every figure lands on the projection exactly. `elo_corpus` fed it 86,297
completed matches.

**The next-48h window, re-measured:**

| stage | fixtures | |
|---|---|---|
| priced by 3+ books | **70** | |
| both clubs past 30 games | **56** | **80.0%** |

Against **5** on the old ladder. The 14 that miss are 13 genuinely-immature
pairings and 1 club with no rating row at all — so the ceiling really is the
structural ~80% section 6 predicted, and the constraint has moved off the
ladder and onto the fixtures' own history. (The projection said 57 / 81.4%;
one fixture had dropped out of the window by the time this was measured, and
the difference is that fixture, not a discrepancy in the ladder.)

`team_alias_false_merges` and `team_alias_cross_country` are both still **0**.

### 6c. THE PRUNE FAILED SILENTLY, AND THAT IS THE FINDING

The rebuild wrote 1,226 correct rows and the table held **1,416**. The other 190
were orphans from 15:19 that `computeElo`'s prune step should have deleted and
did not. From the run log:

    [elo] 1226 team(s) rated
    [elo] could not check for stale rows: TypeError: fetch failed
    [elo] upserted 1226 rating(s)

The prune asked PostgREST for `not.in.(...)` with all 1,226 live team names
inline — a **~20KB URL** — and the request failed outright. The handler was a
`console.warn`, so the step exited 0, the workflow went green, and the count
over the table was wrong by 190 rows in the direction that makes the ladder look
BIGGER and LESS MATURE than it is: 1,416 / 916 instead of 1,226 / 881. That is
the same shape as the duplicate-fixture bug this whole document exists because
of, arriving through the cleanup step rather than the input.

**Most orphans were unreachable, but not all of them.** A key can drop out of
`elo_corpus` (no completed match under that spelling) while `team_key_map` still
RESOLVES to it — and then the orphan is a stale rating a live lookup will find.
Exactly one of the 190 was in that state: `guimaraes`, **1 game**, elo 1481.61.
No `elo_forecasts` row used it (checked: 0), so nothing shipped wrong — but
"nothing shipped wrong" was luck about which clubs had fixtures, not a control.

Both halves are fixed in `computeElo.js`:

- the stale set is computed by **reading the existing keys and diffing in
  memory**, so there is no URL length in it at all, and deletes go in chunks of
  200 for the same reason;
- a failed prune now **throws instead of warning**. A prune that silently does
  not happen is precisely the failure nobody notices.

The 190 orphans were deleted. The table now reads 1,226 / 1,017 / 881 /
172,594 with every row stamped 21:47:09 and `bayernmunich`, `intermilan` and
`guimaraes` all gone.

**One correction to the check-list this was verified against:**
`tottenhamhotspur` was expected to be a stale split-identity key and is not —
it is the LIVE canonical key (841 games, written at 21:47), because folding
accents does not shorten "Hotspur". The genuine split-identity orphans were
`bayernmunich` (against the live `bayernmunchen`) and `intermilan` (against the
live `inter`).

## 7. Tracking the small leagues would NOT cover European ties

Asked on 19 Aug 2026: can we track the extra leagues so European ties are
covered? Mechanically yes, and it is cheap. It would also make the ratings
worse, and the reason is not the league list.

**The clubs.** 413 teams appear in our UEFA fixtures; **231 of them have no
domestic league in our data at all**, and 93 of those are in this season's ties.
They come from about 34 countries outside the tracked forty -- Faroe Islands,
San Marino, Andorra, Gibraltar, Kosovo, Armenia, Azerbaijan, Georgia, Moldova,
Malta, Luxembourg, Estonia, Latvia, Lithuania, Iceland, Wales, Northern Ireland,
Israel, Kazakhstan and the rest.

**The cost is not the objection.** ELO needs RESULTS, not prices, and those are
two different ingest paths. `backfillSeasonFixtures.js` loads a whole season in
one API-Football request and fills in scorelines and results for finished
fixtures; it spends no Odds API credit at all. Thirty-four leagues over five
seasons is ~170 one-off requests against a 75,000/day allowance. Adding them to
`lib/trackedLeagues.js` is the expensive route, because that list also drives
planDay's odds polling and is mirrored by `AVAILABLE_LEAGUES` in the frontend --
which would put competitions in the league picker that we never price, the exact
failure the header of `trackedLeagues.js` warns about. A ratings-only list is the
correct shape if this is ever done.

**The objection is that the ladder is not one scale.** ELO ratings are only
comparable inside a pool that plays itself. Measured across the completed set,
the share of each league's games that are against a club whose home league is
different:

| league | completed games | cross-league |
|---|---|---|
| Major League Soccer | 4,712 | **0.0%** |
| Liga MX | 2,790 | **0.0%** |
| J1 League | 3,144 | **0.0%** |
| Chinese Super League | 2,410 | **0.0%** |
| Premier League (Russia) | 2,016 | **0.0%** |
| Liga Profesional (Argentina) | 4,356 | 0.0% (2 games) |
| Serie A (Brazil) | 3,501 | 0.3% |
| ... | | |
| Premier League (England) | 19,294 | 9.9% |
| Championship (England) | 3,952 | **50.3%** |
| Serie B (Italy) | 2,172 | **50.0%** |
| Ligue 2 (France) | 1,868 | **53.7%** |

Six leagues are **closed pools**: every game is against themselves, so ELO pins
their mean at exactly the 1500 default. An MLS club on 1620 and a Premier League
club on 1620 are not comparable, and `eloProbs` would call that fixture 50/50.
The European pyramids are fine -- promotion, relegation and the League Cup bridge
them, which is why the Championship and Ligue 2 read above 50%.

**Adding 34 small leagues adds 34 more islands.** Each new pool becomes
internally dense -- a small-nation season is ~36 games, so five backfilled
seasons puts essentially every club past 30 -- and stays unanchored. The clubs
would then PASS the games-played gate while their ratings remained
non-comparable to the opponent's. That is strictly worse than the situation
today, where thin ratings are caught precisely because they are thin. **The gate
would stop catching the failure it exists to catch.**

**And the calibration was never measured on this.** `research_dc_preds` holds
16,480 matches and every one is English: E0/E1/E2/E3/EC, 2019/20 to 2025/26. The
10pp `min_publishable_gap` for ELO was fit on the most densely connected pool we
own and has never been tested on a cross-border tie, which is the only place the
expansion would apply it.

**The prerequisite is a league-strength offset**, estimated from the inter-league
matches we already hold. Of 3,873 completed UEFA ties, 1,536 are
tracked-vs-tracked, **1,270 bridge an untracked club to a tracked one** -- the
anchoring observations -- and 1,067 are island-to-island, which anchor nothing.
1,270 across ~34 countries is ~37 per league: enough to fit one offset per
league, not enough to fit it precisely. That is a modelling job, not a
configuration change.

**The correct order, if it is done at all:**

1. Fit per-league strength offsets from the 1,270 anchoring ties.
2. Then backfill the small leagues, as a ratings-only list, so each pool is
   internally dense.
3. Re-measure the disagreement calibration on cross-border ties SPECIFICALLY,
   and give it its own `min_publishable_gap` row -- migration 075 already made
   the threshold a property of the model rather than a constant, and a
   cross-border tie is a different measurement regime.

**There is no urgency, and the calendar says so.** The thin-side problem is
almost entirely a qualifying-round phenomenon. Share of UEFA fixtures with a
side under 30 games, by month across the whole history:

| Jul | Aug | Sep | Oct | Nov | Dec | Jan-Mar | Apr-May |
|---|---|---|---|---|---|---|---|
| **77.4%** | **43.1%** | 6.7% | 6.7% | 6.9% | 7.3% | 1-5% | **0%** |

1,250 of the 1,352 thin-side ties in the database fall in July and August. We are
in the worst fortnight of the year for it. From September the league phase is
tracked clubs playing tracked clubs and the gap collapses on its own. Today it
costs 15 of 44 upcoming UEFA fixtures; in three weeks it costs about one.

Withholding those rows remains the right behaviour, and it is the behaviour we
already have.

## 8. Reproducing it

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
