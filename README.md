# EVE Engine

The value-detection engine for **EVE** (Expected Value Edge). It ingests UK
bookmaker odds from The Odds API, compares them against the Betfair Exchange
sharp baseline, writes computed value signals to Supabase, and maintains a
historical record of every value signal in `value_signals` (CLV tracking).

This repository runs **fully in the cloud** via GitHub Actions — nothing needs
to run on your local machine.

---

## What runs

`.github/workflows/run-engine.yml` runs on two triggers:

| Trigger | When |
| --- | --- |
| `schedule` | Every 10 minutes — `cron: '*/10 * * * *'` |
| `workflow_dispatch` | On demand, whenever you click **Run workflow** |

Each run, on an `ubuntu-latest` runner with Node.js 22:

1. Checks out the repo
2. Installs dependencies (`npm install`)
3. Runs `node ingestOdds.js` — fetches odds → Supabase
4. Runs `node computeValues.js` — computes edges + records value signals
5. Runs `node fetchResults.js` — settles results + refreshes performance summary

A **second** workflow, `.github/workflows/run-inplay.yml`, runs the in-play
pipeline on a tighter cadence (`*/5`). See "In-play signals" below.

---

## A PostgREST filter is a URL — and that has stopped two writers

Twice on 19 Aug 2026 a script stopped writing to the database, stayed green, and
went unnoticed for more than a day. Both had the same cause, and it is worth
stating as a rule rather than as two anecdotes.

`supabase.from(t).select().in('col', ids)` puts every id **in the request line**.
A uuid costs ~39 bytes once quoted and comma-separated, so:

| ids | approximate URL |
| --- | --- |
| 200 | ~8 KB — safe |
| 821 | **~32 KB — rejected by the transport** |
| 1,226 | ~48 KB — rejected |

The request never reaches Postgres. It fails as `TypeError: fetch failed`, which
looks nothing like a query error and carries no SQL in it.

**What it cost:**

- `computeElo.js` built `not.in.(...)` from all 1,226 live team names to find
  stale rows. It failed, the handler was a `console.warn`, and 190 orphan
  ratings survived a run that reported success — inflating every count taken
  over `team_elo` and leaving one stale rating reachable by a live lookup.
- `captureSnapshot.js` built `.in('match_id', ids)` from 821 matches in all
  three of its prefetches. It failed on every run from **18 Aug 14:17 to 19 Aug
  23:33**, and the workflow ran it as `2>/dev/null || true`, so both the reason
  and the exit code were discarded. `odds_snapshots` and `recommendations` both
  stopped dead at the same second.

**The rule, and it already existed here.** `captureIndependentLines.js` slices,
`backfillMatchStats.js` chunks, and `computeValues.js` carries a comment
explaining the hazard. Chunk any id filter at ~200, or derive the set by reading
keys and diffing in memory. Never inline an unbounded list.

**And never silence the writer.** Non-fatal is a legitimate choice — a snapshot
failure should not stop ingest or compute. Silent is not: `2>/dev/null` is what
turned a crash into a month-shaped gap in the price history. If a step may fail
without failing the run, it must still say so.

## The ELO forecast, and what it refuses to say

`.github/workflows/elo-forecasts.yml` runs `computeEloForecasts.js` twice a day
(05:10 and 15:40 UTC) and writes one row per upcoming fixture into
`elo_forecasts`. The frontend's `/api/match-card` reads it and nothing computes
a vector of its own — the engine writes the verdict, the surface reads it.

Twice a day rather than every tick is a property of the inputs: a rating only
moves when a result settles, the league offsets only move on a refit, and the
draw model's parameters are fitted constants. Between settlements it is the same
number recomputed.

**Three things have to hold before a fixture gets a forecast**, and each is
owned by exactly one place:

| Question | Owner |
| --- | --- |
| Do both clubs have a rating? | `team_elo`, written by `computeElo.js` from `elo_corpus` |
| Can the two ratings be compared? | `fixture_placement` → `lib/leagueStrength.js` |
| What is the 1X2 vector? | `lib/eloProbs.js`, over the adjusted pair |

A rating is only meaningful inside the pool it was earned in — ELO is zero-sum
within a match, so a set of clubs that only plays itself never leaves the
default. Migration 077 fits one offset per league so two pools can be compared;
15 leagues have no cross-league fixture anywhere in the record and get no
offset at all.

**A refusal is a row, and it names the club.** `status = 'withheld'` carries a
`withheld_code` and a `withheld_reason`, and the database rejects a withheld row
that has neither. Same shape as `value_signals.score_withheld_reason` and
`/api/inplay`'s source block: "we have no forecast for this" and "nobody asked
about this fixture" are different facts, and three features in this product
shipped silently dead when they were confused.

**It never defaults a rating.** `eloProbs` returns null for a missing side
rather than substituting 1500 — a defaulted rating is the absence of a forecast
wearing a number, and it would be scored as though it were a read.

`node computeEloForecasts.js --dry-run` prints the tally without writing. As of
19 Aug 2026: 8,967 forecasts, 124 withheld for a missing rating, 10 unplaceable,
across 9,101 upcoming fixtures.

**A caution for anyone reading `team_elo` in JS.** `elo` is `numeric`, and
PostgREST serialises numeric as a JSON **string**. `Number.isFinite(row.elo)` is
therefore false for every row — coerce first, then check. Written the wrong way
round it produces an empty ratings map, a full table of confident-looking
refusals, and a run that reports success.

---

## A PostgREST RESPONSE IS CAPPED AT 1000 ROWS — and that is silent too

The sibling of the URL-length rule above, and it bit the same file.

`captureSnapshot` drove itself from `select * from computed_values` with no
filter, no `order by` and no `.range()`. The table holds **1,509 rows**, so 509
were dropped on EVERY run — an arbitrary 509, because without an order the
server may return rows in any order between statements.

**The symptom was nowhere near the cause.** Only 96 of those 1,509 rows are
upcoming fixtures; the rest are past ones. So what a reader saw was
`odds_snapshots` carrying a `current` h2h row for **11 of 65 board fixtures**,
and the frontend's model block reporting "no comparable market price" on most
of the board — while `elo_forecasts` sat at 100% coverage and the snapshot job
reported success every fifteen minutes.

It also produced an asymmetry that looks impossible until you know the cause:
in three hours the job wrote `current` snapshots for **155 fixtures on btts and
totals but 4 on h2h**. Secondary markets come from the computed_values row's own
best-price columns, so a stale fixture still writes them; h2h needs a matching
recent row in `odds`, which a stale fixture does not have.

`pageAll(query, orderBy, label)` walks the whole table, and **it orders** —
paging without an order is not paging, it is sampling with replacement. Order
on a **unique** column: a walk ordered by one with ties has the same skip-and-
repeat hazard at every page boundary that lands inside a tie, which is why the
first version of this fix paged `computed_values` on `match_id` (1,509 rows,
830 distinct) and was itself wrong. A short page ends the walk; an error throws
rather than truncating the corpus quietly.

### CHUNKING A READ IS NOT EVIDENCE IT IS BOUNDED

The first fix corrected the driving query and left the three prefetches, and
that was not enough — coverage went 11 → 44 of 66 and then STOPPED, across
three iterations of the loop. The prefetches chunk their `.in(...)` filters at
200 ids, which answers the URL-length rule and says nothing whatever about how
many ROWS come back. Measured on production, per 200-match chunk:

    prefetchSnapshotExistence   35,159 rows ->  4,931 returned   86% discarded
    prefetchLatestOdds           4,671 rows ->  4,078 returned   13% discarded

The first of those is the one that hurt. That Set is the only thing deciding
`open` vs `current`, so a fixture whose existence rows fell outside the
returned 1,000 was tagged `open` again on every single run — and both
`/api/match-card` and `/api/match-reads` read `current` only. **22 board
fixtures could never graduate, however many times the loop ran.** `inChunks`
now pages each chunk through `pageAll`.

`prefetchLatestOdds` changed shape with it. It took the first occurrence of
each (match, bookmaker) out of a `fetched_at DESC` result, which is "latest"
only while the server's sort survives to the caller — and it does not once a
read is paged by `id` ascending. It compares the timestamp now, which is
correct under any arrival order. Getting that wrong prints a **stale price
under a live fixture**, a failure with no shape anything downstream can detect.

Two silent caps, two outages, one lesson: **a PostgREST read that returns
"fewer rows than you expected" has not necessarily failed, and has not
necessarily succeeded either.** Bound the request explicitly, both ways — and
check both bounds on every read, not on the one that was in the traceback.

### A `.limit()` LARGER THAN THE CAP IS NOT A BOUND

`verifyIntegrity.js` read both its tables with `.limit(2000)`. That reads as a
considered ceiling and is not one: the server cap of 1,000 simply wins, in
silence. It is the worst of the five instances found on 20 Aug 2026 for exactly
that reason — the other four had no bound at all, which at least looks like an
oversight.

And it was the one that mattered most, because this file is the smoke alarm:
truncating its read does not lose work, it loses the CHECK. 1,599 rows in
`computed_values`, of which 186 live, against a 1,000-row arbitrary slice —
roughly 116 live rows verified and **~70 missed every cycle**, a different ~70
each run for want of an `order`. It logged `OK — 1000 computed rows` throughout.

Two further rules came out of it. **Report what you CHECKED, not what you
fetched** — "OK — 1000 computed rows" reads as a thousand rows verified when
the real figure was ~116, so the log now prints both. And **a client-side
`.limit()` is never evidence a read is bounded**; only paging is.

## BEING KILLED IS NOT STOPPING

`fetchTeamStats` resolved teams for EVERY scheduled match — **9,152** of them on
20 Aug 2026, one HTTP call plus a 120ms sleep each — before any team work began.
The workflow step kills it at its timeout, so it never reached the team loop:
**`team_statistics` had not been written since 6 Aug**, a fortnight, while the
step's own comment claimed the cadence had been fixed so stats would populate.
They did not. A step that runs, burns two minutes and is killed looks identical
to one that works.

Only **242** of those 9,152 kick off inside three days. The run spent its whole
budget on fixtures weeks away and died before the ones a reader is about to
look at.

**A SIGKILL DISCARDS THE WORK.** `referee_stats` is written AFTER the team loop,
so being killed at the timeout throws away the entire aggregate the run just
computed — and prints no summary, so nothing records that it happened. The
script holds its own `BUDGET_SECONDS` (100) under the step's `timeout-minutes`
(3) now, and **the order of those two numbers is the guard** — pinned by a test,
because lowering the timeout to the budget silently restores the data loss.

Three other things came with it, and each is load-bearing:

* **The horizon is bounded** to `TEAM_STATS_HORIZON_DAYS` (3) and ordered
  nearest-kickoff-first, so the budget is spent on fixtures that matter.
* **Freshness is one read, not one per team.** `isFresh` fired a query per team
  to decide whether to make a query.
* **Teams are worked STALEST FIRST.** Stopping partway through a stable order
  would refresh the same head every cycle and starve the tail forever — busy,
  covering a fixed subset, and indistinguishable from working. That is the same
  shape as the truncated reads elsewhere in this file.

That match read was also unpaged, against 9,152 rows and a 1,000-row cap. It is
the sixth instance.

## ONE REQUEST PER FIXTURE, NOT ONE PER PRICE

`ingestOdds` awaited a separate `insert` for every odds row. Measured on run
32376915580: **137 fixtures, 3,107 rows, 638 seconds** — a flat ~160ms per row,
which is a network round-trip each and nothing else. The fetch phase was
already pooled; the write phase never was.

That is what made the engine loop overrun. Its budget is 300s, so the loop
managed **one iteration instead of four**, and the job's later steps were
cancelled when the next scheduled run displaced it — the backlog behaviour the
workflow's own header documents. Batching leaves ~137 requests where there were
3,107.

**A BATCH IS ONE STATEMENT, so one malformed row rejects all 36** — strictly
worse than the row-at-a-time version, which lost only the bad row. So
`insertOddsRows` falls back to per-row on any batch error: the good rows still
land, the bad one is still named, and the fast path costs one request while the
failure path costs exactly what the old code always cost. Only the rows that
LANDED are returned, because the caller seeds `lastOddsMap` from them and a
failed row recorded as present would suppress its own re-insert next cycle.

### A TEST THAT CANNOT FAIL IS NOT A TEST

These tests are in `engine.ingestodds.test.js` and not in
`engine.oddsapi.test.js`, deliberately. That file's hand-rolled harness is
`function test(n, f) { try { f(); passed++; ... } }` — it does not AWAIT `f`, so
an async test that throws still prints a tick and increments the counter. Six
tests were written there first and every one of them passed without asserting
anything.

`node:test` awaits. This is the same failure this repo fixed in
`engine.lambda.test.js` on the same day — a check that reports success while
doing nothing — and it is worth knowing that the older hand-rolled harnesses in
this repo are only safe for synchronous tests.

## A JOB THAT STILL PROCESSES A FINISHED MATCH STILL WRITES

`computed_values` is not pruned, so it accumulates. On 20 Aug 2026 it held
1,510 rows: **97 upcoming and 1,413 kicked off more than three hours earlier**,
830 distinct fixtures where 66 were live. captureSnapshot ran its whole loop
over all of them.

That is not just wasted work, because the loop WRITES. **150 of the 587 rows in
`recommendations` (26%) were recorded more than three hours after their match
kicked off**, 98 of them in the last seven days, the most recent while this was
being investigated. A recommendation freezes a price as a claim, and
eve-frontend's `lib/feed.js` plots it on the price terminal from
`recommendation_timestamp` — so a claim recorded after the result was known
draws as a signal after the match ended. It is the engine-side form of the bug
`expireKickedOffClaims()` fixed in the browser.

**THE HAZARD IN FIXING IT IS THE OBVIOUS FILTER.** `kickoff_at > now()` is
wrong: the CLV back-fill runs ONLY under `snapType === 'closing'`, which spans
60 minutes BEFORE kickoff to 180 minutes AFTER, so a fixture dropped at kickoff
never has its CLV written and nothing reports the loss. `POST_KICKOFF_GRACE_MIN`
is therefore ONE constant serving BOTH the closing window and the retention
filter — change it in one place, or the two disagree in silence. Pinned by
mutation: the naive filter fails the test, as does failing closed on a fixture
whose kickoff cannot be read.

The filter runs before `matchIds` is derived, so the three prefetches narrow
with it — they are keyed on that list and it is what made them large. And the
job LOGS what it skipped, because a job that quietly processes a tenth of
yesterday's corpus looks exactly like one that broke.

## AN UPSERT UPDATES THE VALUE AND NOT THE DEFAULT

`odds_snapshots.captured_at` was a column default. A default is evaluated on
INSERT and never again — while `odds` and `snapshot_type` **are** overwritten,
because `captureSnapshot` upserts on
`(match_id, bookmaker, selection, market_type, hour_bucket)` and every re-run
inside the same hour lands on the same physical row. So the row carried the
**latest price under the first time it was seen**, and nothing about it looked
wrong from either end.

It produced two false readings on 20 Aug 2026, in opposite directions, within
half an hour of each other:

* a cycle that promoted 22 fixtures from `open` to `current` **in place**
  reported "5 fixtures written", because only 5 rows were new;
* a query asking when each fixture first reached `current` answered
  12:25–12:27 for all 66 — the rows' creation stamps, not their tagging — and
  that looked like strong enough evidence to retract a correct result over.

Both are the same mistake: **`captured_at` was answering a question about the
row's birth while every other column answered one about its present.**

Fixed at the write layer. `snapshotRow()` is the single declaration of the row
shape, and it takes a `stamp` carrying the tag, the bucket and the instant
together, so no call site can supply two and forget the third — which is
precisely how the field went missing from two near-identical payload literals.

**Stamped from the app's `now`, deliberately not from a trigger's.** A trigger
fires at statement time, so a batch crossing the hour boundary would stamp a
row into the next hour while its `hour_bucket` says this one. Those two fields
have to agree, and only the caller knows the instant it meant.

**Not backfilled.** Every existing row's last-write time is unrecoverable and
inventing one would put noise on the only price history the product has — the
same ruling as `gap_basis`. Rows written before this change mean *first seen*;
rows after mean *last confirmed*. Anything reasoning about quote age across
that boundary is reading two different columns with one name.

The sibling rule already in this file: **`odds` is a price-CHANGE log, not a
poll log** — never infer polling frequency or quote age from its timestamps.

## `available()` is two questions, and a skip is not a pass

`lib/lambdaBoard.available()` checked that the three λ-model artifacts were on
disk and called that available. A runtime is the other half. `onnxruntime-node`
is an **optionalDependency** whose postinstall DOWNLOADS a native binary, so
behind an egress block `npm install` prints success and leaves the package
absent — and `available()` said yes to that, so `priceFixture` threw
`MODULE_NOT_FOUND` several frames later instead of declining. It now asks both,
and `unavailableReason()` NAMES which half is missing: a retrain that never
shipped and a dependency that never installed both end at the same `return` and
are not the same problem.

`engine.lambda.test.js` splits on the same seam. The bundle test reads a JSON
feature contract and needs no runtime, so it still runs where the runtime is
absent; only the two inference tests skip, and a skip prints `⊘` with its
reason and is counted in the summary line. **On the runner the runtime does
install, so a skip there is a regression** — `.github/workflows/test.yml` sets
`REQUIRE_LAMBDA_RUNTIME=1`, which turns one back into a failure. The point is
that the suite can be green in a sandbox without that greenness being a lie.

**Two test files were never in the `npm test` chain at all.**
`engine.capturesnapshot.test.js` and `engine.eloforecasts.test.js` passed on
disk and guarded nothing, because the chain is thirty filenames joined by `&&`
and nobody re-reads it. `engine.suite.test.js` asserts that every
`engine.*.test.js` on disk is named in the script and that every name in the
script exists — including itself, since a coverage check outside the chain
covers nothing.

---

## In-play signals

The pre-match engine and the in-play engine are **separate pipelines that share
one codebase**, kept apart so live picks never distort the headline CLV.

### It had never written one, and the cause was a CHECK constraint (26 Aug 2026)

`value_signals` held **ZERO** rows with `phase='inplay'` — not "insufficient",
zero, since migration 030 added the column. The pipeline was not idle:
`run-inplay.yml` had completed 1,290 times, recent runs green, with two of the
four stages enabled in its own env. Its log:

    [inplay] win-prob: 18/18 live match(es) have a baseline; 0 candidate(s)

Candidates *were* being produced. Replayed over the 3,798 h2h selection-ticks in
`inplay_market_series` carrying a model probability and a minute under
`INPLAY_WINPROB_MINUTE_CAP`, re-priced against the same 24-hour window
`fetchMatchesForComputation` hands `bestH2hOdds`: **355 (9.3%) land inside
[2%, 20%] and would fire.** Every one was rejected by Postgres.

**The enumeration was rewritten and three names fell out.** Every migration
that touches `value_signals_model_architecture_check` drops it and re-adds the
whole array, so a new architecture is added by copying the previous list — and
039 copied 028's:

    028   8 names                                    (no in-play)
    030   + SUPERMODEL_HALFTIME                      9
    038   + INPLAY_DIXON_COLES, SECOND_HALF_SNIPER  11   <- in-play storable
    039   + LAMBDA_MC, rebuilt from 028's list       9   <- all three GONE
    055   + MARKET_ANCHORED                         10   <- inherits the loss

Nothing failed, because a CHECK is only felt by a WRITER — and the writers it
silenced were not switched on yet. By the time they were, the reason they
produced nothing had been in the schema for a month. 055 was reading this very
list when it recorded a *different* latent bug in it and did not see three
missing names beside them: reading a list for one absence does not find another.

**And the failure reported success.** `insertModelSignals` swallows only
`/duplicate key/`, so a check violation throws into `winProbStage`'s try/catch,
which logs `[inplay] win-prob stage failed:` and lets the job exit 0 — the shape
"BEING KILLED IS NOT STOPPING" describes from the other direction.

**Migration 108 restores the three names** (`INPLAY_DIXON_COLES`,
`SECOND_HALF_SNIPER`, `SUPERMODEL_HALFTIME`) and nothing else. It is numbered
108 rather than 096 because the database already carried 096–107 from an
unmerged branch; the file number follows the database, as migration 059's header
records. Applied and verified in production 26 Aug 2026: the constraint carries
13 names, its probes wrote nothing (`0` rows at `detected_odds=2.00`), and
`'ELO'` is still refused — migration 088's ruling, re-asserted inside 108 so a
widening cannot retire it silently.

**Storable is not publishable**, and four gates were verified before it was
applied: the RESTRICTIVE policy `pending_needs_a_publishing_architecture` denies
a pending row whose architecture has no `publish = true` (none of the three has
a `model_calibration` row at all, so every browser seat is denied);
`trg_score_needs_measured_sigma` strips the score for want of a measured σ;
`lib/publication.js` fails closed on the name; and `postToX.js` routes
`phase='inplay'` to `TELEGRAM_INPLAY_CHAT_ID`, which is unset, so these are
**recorded, not posted** — rollout step 2 of `scripts/inplay-vps/README.md`.

**Volume.** `value_signals_selection_price_unique` includes `detected_odds`, so
this is *not* one row per fixture whatever `insertModelSignals`' comment says.
Counting distinct keys over the same replay: **341 rows across 16 days, ~21 a
day** at the current `run-inplay.yml` cadence. The 30-second worker in
`scripts/inplay-vps/` ticks ~100× more often; read
`select count(*) from value_signals where phase='inplay'` for a week before
enabling it rather than assuming this estimate survived the cadence change.

**`engine.archconstraint.test.js` is the ratchet.** It asserts every
`model_architecture: 'NAME'` the engine writes is admitted by the LAST migration
to declare the constraint, and that `'ELO'` is not. Its first version could not
go red — it read the revert quoted in 108's own header comment — and the note in
the file records that, because a ratchet nobody has seen fail is not one.

### The stages had no odds band, and a live price read 24 hours back (26 Aug 2026)

Follow-on from the section above, and it is a different finding: 108 made an
in-play signal STORABLE, and this is why so few were worth storing.
**`INPLAY_MAX_EDGE` was rejecting 42% of everything the model produced**, and the
first report of it named the 24-hour odds window as the cause. That was only ~30
of those 78 points. **`INPLAY_MAX_EDGE` IS NOT MOVED** — it is the last guard,
it is correctly catching a miscalibration, and lowering a threshold to make a
signal appear is the move this repo forbids. Both fixes are on the INPUT.

**THE CHART AND THE SIGNALS BESIDE IT HELD TWO BELIEFS ABOUT THE LIVE PRICE.**
`captureInplaySeries.js` has read a 10-minute window since it was written;
`computeInplayValues.fetchLiveMatches` called `fetchMatchesForComputation` with
no window override and got the pre-match default, `ODDS_MAX_AGE_HOURS = 24`. So
on a match that had moved, `bestH2hOdds` returned a PRE-MATCH price and the
"edge" against it was mostly the game state. The chart was the correct one.
`lib/inplay.INPLAY_ODDS_MAX_AGE_MIN` is the single constant now and both read
it; the pre-match path is untouched and still reads 24 hours, which is right for
a market that has not started moving. Replayed over the same 3,798 h2h ticks:
**72.7% above `INPLAY_MAX_EDGE` at 24 hours, 42.4% at 10 minutes.**

**It does not starve the book-lag stage**, which is the one thing a tighter
window could break — Stage 1 needs a multi-book pack, not one price. Measured
over 400 recent live captures: a 10-minute window holds a mean of **10.5
distinct h2h books and never zero** (24 hours reads 23.17, and the difference is
the pre-match panel). It is also tighter than `lib/dataQuality`'s own 15-minute
`maxPriceAgeMinutes`, so nothing surviving the window can then fail that gate on
age.

**AND EVERY PRE-MATCH PATH HAS AN ODDS BAND WHILE THESE THREE HAD NONE.**
`liveWinProb` advances a FROZEN pre-match λ by minute and score and never reads
the live market, which is a textbook favourite–longshot bias — and it is
monotonic in price. Median model probability over the market's own implied
probability, same ticks:

    price < 2.0    0.80        price 5-10     1.38
    price 2-3      1.10        price 10-25    2.40
    price 3-5      1.06        price 25+      2.47

Above 3.00 the model claims one and a half to two and a half times the market's
chance. Split by market:

    market   band          ticks   med ratio   above max edge     fires
    h2h      <= 3.00        1349       0.868      175 (13.0%)       258
    h2h      >  3.00        2449       1.431     1434 (58.6%)       206
    totals   <= 3.00         882       0.751      155 (17.6%)       156
    totals   >  3.00         276       3.491      265 (96.0%)         0

The totals row is the plainest form of it: above 3.00 the sniper has **never
once** produced a candidate inside the band, only rejects. `lib/inplay`'s
`INPLAY_MAX_ODDS` applies the ceiling to all three stages and **READS the
pre-match box's own `PRIME_ODDS_MAX`** rather than declaring a second 3.00 —
a constant typed twice in this repo drifted inside twenty-four hours once
already. It removes **1,434 of the 1,609 above-max rejects (89%)** and keeps
**258 of the 464 in-band candidates (56%)**.

**NO LOWER BOUND, deliberately.** The box's 1.40 floor is a staking rule, not a
calibration one: under 2.00 the model claims 0.80× the market and produces 52
above-max ticks in 993. Adding it would cut fires 258 → 164 and the rejects only
175 → 172 — all cost, no correction.

**THE CEILING IS ON THE CANDIDATE, NEVER INSIDE `bestH2hOdds`.** That map also
feeds `devigLiveH2h`, which needs all three legs to remove the margin, so
dropping a leg there would silently de-vig a two-legged 1X2 vector and mis-state
every `market_prob` on the row. `isBackablePrice` fails closed on an absent or
non-numeric price, and `engine.inplay.test.js` asserts each surviving leg's
de-vigged probability still sits BELOW its own `1/odds` — which is only possible
if the vector was complete.

**AND THE STAGE SAYS WHY IT IS EMPTY.** `winProbCandidates` takes a census
out-parameter and `winProbStage` prints it, so "over the price ceiling" and
"over the max edge" are separate counts rather than one silence — they are
different findings, one saying the model is not calibrated at THIS PRICE and the
other that it is not calibrated at all. The test suite asserts the CALL SITE
passes it, because this repo has already shipped a census that was dead for a
day while its own tests covered it.

**STILL OPEN, AND IT IS THE MODEL'S.** The ceiling contains the bias; it does
not remove it. `liveWinProb` reading 2.4× the market at 10–25 is a calibration
defect in the model itself, and correcting it means letting the live market
inform λ rather than freezing it at kickoff. That is its own change with its own
measurement, and nothing in `lib/inplayWinProb.js` was touched here.

### The cron was never the cadence, and the model could not see the match (26 Aug 2026)

Found by tracing one live fixture: **Rapid Vienna v Heart Of Midlothian**,
Conference League, kicked off 16:45, 1-1 at 84'. Nothing shot for it. Three
independent causes, and the section above is only the second of them.

**THE ENGINE LOOKED AT A 90-MINUTE MATCH ONCE, WITH FOURTEEN MINUTES LEFT.**
`run-inplay.yml` declares `2-59/5` — twelve ticks an hour. Consecutive
scheduled runs delivered on 26 Aug:

    04:04 04:51 05:19 05:53 06:29 07:26 08:07 08:57 09:41 10:16 10:53
    11:18 11:49 12:19 13:27 14:10 15:50 16:38 18:20

Gaps of **25 to 102 minutes**, about 1.3 ticks an hour — a tenth of what the
cron asks for. Exactly one landed inside the match (18:20, the 76th minute), so
`odds` holds a single post-kickoff row for it and `inplay_market_series` a
single capture. `fetchLineups.js` already recorded the same thing ("a MEDIAN
GAP OF 34 MINUTES, minimum 17, never once 15"); **do not read a cron expression
in this project as a statement about how often something happens.**

**`runInplayLoop.js` is that file's fix applied where cadence IS the product.**
One GitHub tick keeps a process alive for `INPLAY_LOOP_MINUTES` running a pass
every `INPLAY_PASS_INTERVAL_SECONDS` (60); the cron's only duty is to make sure
a process is running at all. LOOP_MINUTES **must exceed the delivered gap** — a
fresh tick lands while a loop is still running, GitHub holds it as the single
pending run (`cancel-in-progress: false`) and starts it the instant this one
ends, so coverage closes up instead of gapping.

**IT SHIPPED AT 50 AND THAT WAS NOT ENOUGH — IT IS 170.** The median is not the
thing to clear, because the delivered gaps are not spread around it: the tail
lands in the evening, when the fixtures are. The last four scheduled runs of
26 Aug were **100, 102 and 113 minutes** apart, so the 19:00 kickoffs got their
first tick at 20:14 and seven matches carry that timestamp to the millisecond —
it is the loop's first pass, not a coincidence. 170 clears the worst gap
observed with margin. **The cost is deploy latency**: the run checks out `main`
when it starts, so a merge can take up to LOOP_MINUTES to reach production, and
a manual dispatch QUEUES behind the running loop rather than replacing it — to
ship immediately, cancel the running job, then dispatch.

It **spawns the six existing scripts unchanged**, in the workflow's own order,
rather than requiring them in-process: each owns its Supabase client, its
budget guard and its exit code, and one dying must not take the loop with it.
Nothing about what any of them writes changes. Two guards make the new cadence
affordable: **The Odds API step keeps its own slower clock**
(`INPLAY_ODDS_API_INTERVAL_SECONDS`, 600) because it is the only metered one,
and **a pass is skipped entirely when nothing is in the live window** — 47% of
all hours — on one indexed count that **fails OPEN**, because a database blip
must not become a silent in-play outage.

`timeout-minutes` (175) exceeds LOOP_MINUTES and the loop stops itself before a
pass would overrun its own budget: being killed is not stopping, and a killed
run prints no summary. Health is reported on `always()`, because a job killed
by a timeout ends **cancelled, not failed**, and `if: failure()` does not fire
on it.

**AND THE MODEL COULD NOT SEE THE MATCH.** `liveWinProb` takes
(λ_home, λ_away, goals, minute) and nothing else, and λ is FROZEN — inverted
from the pre-match de-vigged 1X2 at `inplay_baseline` capture time (15:58 for
this fixture, 47 minutes before kickoff) and never revised. Meanwhile
`fetchLiveStats.js` has been writing **18 statistics per side** into
`match_stats` every ~90 seconds and **nothing in the signal path read them**:
the frontend drew possession 61/39 and shots 11/7 on the match page, beside a
probability that had never seen either.

`lib/inplayState.js` is where live state now enters, and it moves **exactly one
thing**, because exactly one thing is measured.

**A SENDING-OFF, AND THE NUMBER IS THE CORPUS'S.** Over `match_results`: 10,215
matches carrying exactly one red card and a half-time score, against 64,294
with none. Second-half goals only (FT − HT), each compared with the
**same-half-time-margin** baseline so a side already chasing is not counted as
evidence:

    ten-man side     0.4973 observed / 0.8050 expected   = x0.6178
    eleven-man side  1.0604 observed / 0.6620 expected   = x1.6018

Stable across game state, which is what says it is the card and not the
scoreline — the ten-man multiplier reads 0.544 / 0.624 / 0.655 for a side
ahead / level / behind at the break, and the eleven-man 1.747 / 1.604 / 1.517.
A card therefore RAISES the expected total slightly (1.6018 outweighs 0.6178),
which is what the raw record shows, so the sniper prices it through the same
multipliers.

**IT IS A FLOOR, NOT A POINT ESTIMATE.** HR/AR are whole-match with no minute,
so a card shown in the 89th counts identically to one in the 20th and dilutes
the average toward 1 — the true effect from the moment of the card is LARGER.
Using them unrounded is already the conservative direction; do not round toward
no effect again on top of that, and do not inflate them to guess at the
undiluted value either. Re-measure with event timings if it ever needs to be
exact. A differential of two or more is priced **as one card** (553 matches in
75,875, not separately measured) rather than compounding a multiplier past its
evidence.

**POSSESSION, SHOTS AND CORNERS MOVE NO NUMBER, DELIBERATELY.** There is no
measurement in this repo for what a possession share is worth in goals, and
inventing one would be a second unmeasured model priced as evidence — the
failure `model_calibration` and the publication gate both exist to prevent.
They are read, carried and printed per match in the run log, so a reader and
the model finally look at the same object.

**EVERYTHING FAILS CLOSED.** No `match_stats` row, a feed that does not report
`Red Cards`, an even count, or a non-finite λ all leave the pair exactly as the
baseline froze it — the behaviour before this existed. The join is on
`matches.external_id`, NOT `matches.id`: `match_stats` keys on the
API-Football fixture id, and joining on the wrong one returns an empty map that
looks exactly like a feed with no stats.

**`Number(null)` IS 0 AND 0 IS FINITE**, so `Number.isFinite(Number(x))` files
a null λ as a real zero — a team that cannot score, which the Poisson grid
prices happily. The frontend bans that shape with a lint rule and this repo has
none, so `lib/inplayState.num` is explicit. Caught by this module's own test
before it ran anywhere.

**Replayed against the fixture that found all three**, with production's own
row (76', 1-0, `apifootball_live` 1.166 / 5.500 / 23.000, the real
`match_stats` payload):

    live state read   reds 0-0 · shots 11-7 · poss 61%
    candidate         home @ 1.166, INPLAY_DIXON_COLES, phase=inplay
    census            2 over the price ceiling, 0 under EV, 0 over max edge
    with a red card   no candidate, and cardAdjusted=1

Under the old code that row was rejected at a fake **+48.2%** edge and the log
said `0 candidate(s)`.

`engine.inplaystate.test.js` and `engine.inplayloop.test.js` are the ratchets.
The loop suite pins the step ORDER (a chart must not record a tick the signals
never saw), that LOOP_MINUTES exceeds the delivered gap, and that
`timeout-minutes` exceeds LOOP_MINUTES — read out of the workflow YAML, so
editing one without the other fails a test.

**STILL OPEN.** `[oddsApi] EXPECTED a sport key and did not find one: ucl,
uecl` — the Champions and Conference Leagues have no Odds API mapping, so the
only live price on a European tie is the single synthetic `apifootball_live`
book and Stage 1 (book-lag, multi-book) can never fire on one. And
`matches.status = 'live'` **is** being written now, on this fixture with a
minute and a scoreline; several notes in eve-frontend's CLAUDE.md still say no
row has ever carried it.

### The in-play channel — a fourth gate, and it was the one that decided it

26 Aug 2026, owner request. The `🔴 IN-PLAY` branch has sat in
`postToX.buildMessage` since it was written and **had never once been
reachable** — and would not have become reachable however
`TELEGRAM_INPLAY_CHAT_ID` was set.

**`fetchRecentSignals` filters every row through `isPublished` before anything
else sees it**, and no in-play architecture is in `PUBLICATION`:

    INPLAY_DIXON_COLES   not in the calibration set, so it has no measured error
    SECOND_HALF_SNIPER   anchored on inplay_baseline, a recombined consensus

So the row was gone at the door. Three gates on this feature were already
documented — the RESTRICTIVE RLS policy, `trg_score_needs_measured_sigma`, and
the browser's own `lib/publication` — and every one of them was described as
the reason in-play stays "recorded, not posted". **This is the fourth and it is
the one that actually decided it.** Counting gates is not the same as finding
the binding one.

**`INPLAY_BROADCAST` IS A SEPARATE SET, NOT AN ENTRY IN `PUBLICATION`.** Those
answer different questions. `PUBLICATION` decides whether output may be
presented as a BACKED SELECTION — it governs the site, the pre-match channel
and the published record — and for these two the answer is still no: no
`model_calibration` row, no measured error bar, and `performance_summary` keyed
'inplay' has sat at **zero settled** since it was created. What the new set
decides is narrower: may a live alert reach a DEDICATED, OPT-IN channel that
states on every post what it is.

**TWO SWITCHES, BOTH FAILING CLOSED.** `INPLAY_BROADCAST_ENABLED` admits
in-play rows past the gate and is unset by default; the chat id decides where
they go. With the flag on and the id UNSET nothing posts and the run says so,
which is the safe order to arrive in — the format can be watched in the log
before a channel exists. A new in-play architecture does not inherit the
channel: the set is by name.

**AND THE DISCLOSURE IS THE CONDITION IT IS ADMITTED ON.** Every message states
that the model has no measured error bar and no settled record, and that the
price is live and may be gone. If that is ever removed from `buildMessage`,
`INPLAY_BROADCAST` should go with it.

**RED IS THE IN-PLAY MARK AND NOTHING ELSE USES IT.** The pre-match channel
runs `>>` for its backed rungs and 🎯 / ⚡ for the rest; nothing there is red.
A reader scanning two channels on a phone can tell which one they are in from
the first glyph, so the header, the rule and the live clock carry it and
nothing else does.

**A MAN ADVANTAGE IS PRINTED ABOVE THE PRICE**, because it is *why* the price
moved and a reader should not have to infer it from a number that looks wrong.
It comes from `lib/inplayState` through `match_stats` — the same read the model
now uses — and an absent line means **not reported**, never "no cards".

**THE BOOKMAKER WAS BEING PRINTED RAW, AND THAT IS A MARKDOWN BUG WITH THE
CHANNEL'S ONLY BOOK IN IT.** `value_signals.bookmaker` holds The Odds API's
keys verbatim — `unibet_uk`, `betfair_sb_uk`, `apifootball_live` — and an
underscore is Telegram's italic delimiter: two silently italicise everything
between them, one leaves a stray `_`. The file already knew this about
OUTCOMES ("Underscores in outcomes are Markdown italic delimiters") and printed
the bookmaker beside it unescaped. It goes through `bookmakerLabel` now, which
fixes the pre-match channel too.

`apifootball_live` had no entry in `BOOKMAKER_LABEL`, so it slugified to
**`apifootballlive`** — a bookmaker nobody has heard of, on the ONE source that
prices every in-play row. It is `Live feed (aggregated)`, which is what it
actually is. **That needed an `ALIASES` entry as well**:
`engine.bookmakers.test.js` pins that a label round-trips back to its own key,
and no display name slugifies to a string containing an underscore — without
it, a bet recorded from an in-play alert would store a bookmaker nothing can
resolve. The first fix keyed only the slug and still failed, because
`bookmakerKey` tries the raw lowercase first.

`engine.inplaybroadcast.test.js` is the ratchet: both switches, the named-only
admission, the pre-match gate held unmoved, the disclosure present in every
message, the paired-underscore check over the real keys, and that an in-play
post can never reach the pre-match channel.

**WHAT IS STILL THE OWNER'S.** Creating the Telegram channel and setting
`TELEGRAM_INPLAY_CHAT_ID` — a channel cannot be created from here. Until it is
set, in-play signals are computed, stored, and logged with their message body,
and posted nowhere.




**Why they must be separate.** The pre-match headline metric is CLV
(`ln(detected/closing)`), where "closing" is the price at kickoff. *In-play,
the line has already closed* — CLV is undefined. So in-play signals are tagged
`value_signals.phase='inplay'` (migration `030`) and measured by their own
`performance_summary` row (`singleton_key='inplay'`): realised yield /
strike-rate / ROI, **no CLV**. The pre-match row (`singleton_key='current'`)
aggregates only `phase='prematch'`, so its CLV is untouched. `computeValues.js`
now also refuses to emit a signal for any match past kickoff even if its status
row still says `scheduled`, closing the leak at the source.

**Two value mechanisms (both-in-stages):**

1. **Book-lag** (`MARKET_CONSENSUS`, on now) — the same Kaunitz consensus engine
   run on live odds. Fires only when one book trails the live crowd. With a
   single-source live feed (see below) it has no crowd to compare against and
   cleanly no-ops; it lights up automatically if a multi-book live source is
   added. Pure plumbing, no false signals in the meantime.
2. **Model-vs-market** (`SUPERMODEL_HALFTIME`, gated `INPLAY_MODEL_ENABLED`) —
   the real differentiator. Holds an **independent** live probability (the
   half-time supermodel, `models/supermodel_halftime_v2.onnx`) against the
   drifted live price: `edge = p_model × live_odds − 1`. This is what can flag
   *"the market overreacted to the goal — the favourite is still value"*.

   The parity feature service that feeds it now exists:
   - **ELO ladder** — `computeElo.js` walks completed `matches` chronologically
     with the trainer's exact rule (`lib/elo.js`: K=30 / home-adv 80 / default
     1500) and upserts `team_elo`. It runs after `fetchResults.js` in
     `run-engine.yml`.
   - **Feature builder** — `lib/halftimeFeatures.js` assembles the 32-feature
     vector in the exact training order (`supermodel_halftime_v2_features.json`)
     from `team_statistics` (form), `team_elo`, league OHE and live state.

   It is **honesty-gated**: the supermodel was trained only on the top-5
   European leagues, so `buildHalftimeVector` returns `null` (logged with a
   reason) unless the league is supported, both teams have ≥ `INPLAY_MIN_ELO_GAMES`
   real games, and both have form. Out-of-distribution fixtures (e.g. the World
   Cup) stay dormant rather than emitting guessed signals. A second guard,
   `INPLAY_MAX_EDGE`, rejects implausibly large model edges as likely
   miscalibration. The stage is still behind `INPLAY_MODEL_ENABLED` (default
   `false`) for rollout control; flip it on once `team_elo` has accumulated
   enough top-5-league history.
3. **Second Half Sniper** (`SECOND_HALF_SNIPER`, gated `SECOND_HALF_SNIPER_ENABLED`) —
   a **half-time trigger**. At the break (elapsed `SNIPER_MIN_MINUTE`–`SNIPER_MAX_MINUTE`),
   on a still-*hot* scoreline (≤ `SNIPER_HOT_MAX_GOALS`) in a match where goals
   were expected pre-match (`λ_home + λ_away ≥ SNIPER_MIN_MATCH_XG`), it prices
   `P(final total > line)` for each `SNIPER_LINES` entry (Over 1.5 / 2.5) from the
   current score and the frozen `inplay_baseline` λ (`lib/inplayWinProb.goalsOverProb`),
   and holds it against the **live Over price**: `edge = p_model × live_over − 1`.
   Competition-agnostic (same Poisson family as the win-prob stage — no trained
   model), it emits **one** Over entry per fixture (the highest-EV line; the dedup
   index is keyed on `(match, market, outcome, model)`, not the line). The
   downstream first-goal exit / no-goal stop-loss is trade management, not
   detection. Behind `SECOND_HALF_SNIPER_ENABLED` (default `false`) for rollout;
   `lib/secondHalfSniper.js`, tested in `engine.sniper.test.js`.

**In-play run order** (`run-inplay.yml`):

1. `node ingestLiveOdds.js` — `/fixtures?live=all` updates `matches`
   (`status='live'`, current `goals_home/away`, `minute`); `/odds/live` writes
   the current 1X2 **and Over/Under goals** prices under the synthetic bookmaker
   `apifootball_live` (the totals rows feed the Second Half Sniper at the break).
2. `node computeInplayValues.js` — Stages 1–4, writing `phase='inplay'`.
3. `node postToX.js` — routes `phase='inplay'` to the dedicated Telegram
   channel (`TELEGRAM_INPLAY_CHAT_ID`). If that channel is unset, in-play
   signals are recorded but **not** posted — they never leak into the main feed.

> **Data-source caveat.** API-Football's `/odds/live` is a single aggregated
> feed, not a crowd of books — that's enough for model-vs-market (needs one
> price) but not for book-lag consensus.
>
> **Cadence caveat.** In-play edges close in seconds-to-minutes; GitHub Actions'
> 5-minute floor is best-effort. If live value proves out, move
> `ingestLiveOdds`/`computeInplayValues` to a short-loop worker — the code is
> cadence-agnostic, only the trigger changes.

In-play-specific env vars: `INPLAY_MODEL_ENABLED` (default `false`),
`INPLAY_EV_THRESHOLD` (default `0.02`), `INPLAY_MAX_EDGE` (default `0.20`),
`INPLAY_MAX_MODEL_PROB` (default `0.85`),
`INPLAY_MAX_CLOCK_EXCESS_MIN` (default `20`),
`INPLAY_MIN_ELO_GAMES` (default `5`), `LIVE_WINDOW_MIN` (default `160`),
`TELEGRAM_INPLAY_CHAT_ID`. ELO tuning: `ELO_K`, `ELO_HOME_ADV`, `ELO_DEFAULT`.

---

## A positive edge is not an opportunity

Added 26 Aug 2026, after the in-play channel's first night. Ten signals were
written and eight of them should not have been. The complaint that started it
was exact: *"1.10 when a team's 4-0 isn't an opportunity."*

All ten, with the model probability recovered as `(1 + edge) / odds`:

    Celje       draw  2.050  +9.97%  p 0.5364   <- keeps
    Lyon        away  1.615 +13.02%  p 0.6998   <- keeps
    Lyon        away  1.181  +9.31%  p 0.9256
    Viking      home  1.090  +3.88%  p 0.9530
    Viking      home  1.083  +5.66%  p 0.9756
    Viking      home  1.071  +5.06%  p 0.9810
    Viking      home  1.062  +5.02%  p 0.9889
    Viking      home  1.050  +4.39%  p 0.9942
    Viking      home  1.045  +4.11%  p 0.9963
    Preston     away  1.100  +8.35%  p 0.9850   <- the 0-4

Five of the eight are the SAME BET, re-detected as the price shortened —
`value_signals_selection_price_unique` includes `detected_odds`, so a shortening
price is a new row. **Tightening what counts as a signal is what removes the
duplicates**, and it does: two of the ten survive.

### The certainty cap — the model past its own resolution

`INPLAY_MAX_MODEL_PROB` is **0.85** and it is derived, not chosen. Replayed over
`inplay_market_series` — every tick on a completed match, taken as the signal
path would take it (backable price under 3.00, minute under 88, claimed EV
between 2% and 20%), clustered to one observation per match:

    cut     above the cut                    below the cut
            n   claimed  realised    z       n   claimed  realised    z
    0.80    84   90.51%   84.52%   -1.87    143   56.88%   52.10%   -1.15
    0.85    65   93.05%   81.54%   -3.65    159   59.85%   57.39%   -0.63
    0.90    46   95.49%   84.78%   -3.50    178   62.94%   59.69%   -0.90
    0.95    27   97.74%   85.19%   -4.39    192   65.81%   62.11%   -1.08
    0.97    18   98.72%   77.78%   -7.91    198   66.83%   63.51%   -0.99

The model is **calibrated below every cut** (|z| under 1.2 in all five rows) and
significantly **overconfident above 0.85**. 0.85 is the lowest cut at which the
miss above it clears |z| >= 2, and it is where the remainder below is best
calibrated. At 0.80 the miss is -1.87 and does not clear the bar.

The unfiltered reliability curve says it with more rows: 119 ticks over 92
matches at p >= 0.97 realise **92.4%**, and the 94 ticks over 67 matches where
the model returns **exactly 1.0000** realise **84.0%**. A model that says
"certain" and is wrong one time in six is not measuring anything at that end of
its range; past there the "edge" is the bookmaker's margin wearing a
probability's clothes.

**AND IT ANSWERS THE PRICE COMPLAINT WITHOUT A PRICE FLOOR.** 1/0.85 is 1.176,
so with the 2% EV floor nothing under about 1.20 can reach the channel. A LOWER
BOUND ON THE ODDS was tried and measured in `lib/inplay.js` and does not work:
under 2.00 the model claims 0.80x the market and produces 52 above-max ticks in
993, so the floor would cut fires 258 -> 164 and the rejects only 175 -> 172 —
all cost, no correction. **The price is the symptom; the model's resolution is
the cause.**

### The clock guard — the model prices time remaining

`liveWinProb` prices remaining goals as Poisson(λ × time left), and time left
comes from the FEED's minute. Time remaining is most of the model, so a stale
clock is not a rounding error — it is the model believing there is another
half-hour of football to come when the match is over. Over the 560 completed
matches in the series, **75 ticks across 25 of them were priced more than 110
minutes after kickoff with the feed still reading under 88 minutes.**

The disagreement is measured as EXCESS — wall-clock elapsed, minus the feed's
minute, minus the half-time break once the second half has started. Over 4,311
completed-match ticks:

    excess > 10 min   22.34%      <- ordinary second-half stoppage
    excess > 15 min   11.34%
    excess > 20 min    3.20%      <- INPLAY_MAX_CLOCK_EXCESS_MIN
    excess > 25 min    1.32%
    maximum           61.7 min

Twenty minutes is on TOP of the fifteen the break is given, so a second-half
tick may run 35 minutes behind the wall clock before it is refused. It catches
48 of the 75 frozen ticks; the other 27 are matches that **kicked off late**,
where the feed's minute is right and `kickoff_at` is wrong, and there the model
prices correctly — refusing them would be the guard doing harm. The negative
side (a clock AHEAD of the wall) has **never fired**: the minimum excess ever
observed is -0.8 minutes.

The certainty cap fails CLOSED — a probability that cannot be read is not one we
may claim an edge against. The clock guard fails OPEN with no kickoff to measure
against, and says `clock_unknown` rather than `clock_stale`, because a missing
column is not a large disagreement.

`lib/inplayOpportunity.js` owns both and returns a REASON, not a boolean; the
stage prints a `win-prob refused:` line naming each. **Nothing here reads
possession, shots or xG, and no threshold was moved.**

---

## `inplay_momentum` — the corpus a momentum model would have to be fitted on

Migration 111. The obvious thing to do with possession, shots and xG is to move
the goal expectation with them. There is no measurement in this database for
what a possession share is worth in goals, and there **could not be one**:

    match_stats           2,276 rows across 1,138 fixtures
    rows per (fixture, side) with more than one          0

It is upserted on `(fixture_id, team_side)`, so it holds one overwritten
snapshot per fixture. **No record of what any match looked like at minute 60
exists anywhere.** A momentum model could not be fitted and could not be
measured, and anything shipped today would be numbers somebody made up wearing
the clothes of evidence.

So the record accumulates first. `captureInplaySeries.js` appends a row per
genuine feed refresh beside the market series it already writes, on the same
clock, so a momentum row and a price row from one tick share a minute and can
be joined on it. It is the right file because `fetchLiveStats.js` runs
immediately before it in the loop. **Nothing reads it and nothing may price off
it** until it has been fitted and measured; it is service-role only, RLS on with
no policy.

**A NULL IS UNKNOWN, NEVER ZERO — with one measured exception.**
`expected_goals` is absent on 41% of rows, and those rows average **12.9 shots**
with 777 of 1,120 carrying shots on target, so a null xG is a competition that
is not tracked rather than a side that has had no chances. `Red Cards` is the
opposite: a value appears on 436 of 1,978 rows, about the rate at which matches
produce one, so null there is a genuine none — and that is what lets the
measured sending-off adjustment in `lib/inplayState.js` fire at all.

**DEDUPE IS ON THE FEED'S STAMP, NOT OURS.** `captured_at` is the tick that
wrote the row; `stats_fetched_at` is carried up from `match_stats.fetched_at`.
`fetchLiveStats` gates each fixture behind 90 seconds while the loop passes
every 60, so without it the corpus fills with consecutive identical rows and a
fit counts one observation twice. A unique `(match_id, stats_fetched_at)` is the
backstop under the writer's own skip.

---

## Teaching the model — uploading historical seasons

The ELO/form **supermodels** (`ensemble/models/supermodel_prematch_v2.onnx` and
`supermodel_halftime_v2.onnx`) learn from a corpus of historical matches. You
can make them more accurate by feeding in more history — previous seasons,
extra leagues, closing odds — **without touching any code**.

### The workflow: drop a CSV, push

1. Get the season file in **football-data.co.uk** format. Two layouts are
   auto-detected:

   - **Extra-league** (same as the committed `ensemble/data/SWE.csv` /
     `USA.csv`) — one file, many seasons, with closing odds:

     ```
     Country,League,Season,Date,Time,Home,Away,HG,AG,Res,PSCH,PSCD,PSCA,MaxCH,MaxCD,MaxCA,...
     Sweden,Allsvenskan,2012,31/03/2012,15:00,Elfsborg,Djurgarden,2,1,H,1.71,3.98,5.44,...
     ```

   - **Main-league** (a single-division download such as `E0.csv`, `D1.csv`):

     ```
     Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HST,AST,HR,AR,B365H,B365D,B365A,PSH,PSD,PSA,...
     ```

2. Drop it into `ensemble/data/` and push it to your branch:

   ```bash
   git add ensemble/data/GER2_2023.csv
   git commit -m "data: add Bundesliga 2 2023/24 history"
   git push
   ```

3. The **Train Supermodels** workflow (`.github/workflows/train-supermodels.yml`)
   fires automatically on any change under `ensemble/data/**`. It rebuilds the
   corpus (`build_training_corpus.py` auto-discovers every CSV in that folder),
   retrains both supermodels, and commits the refreshed `.onnx` +
   `*_features.json` back to your branch. You can also trigger it by hand from
   the **Actions** tab.

The league slug is read from each file's own `League` column (or the `Div`
code), so `Allsvenskan → allsvenskan` and `MLS → mls` map exactly as the
production code already expects.

### Existing league vs brand-new league

- **More seasons of a league the model already knows** (`epl`, `laliga`,
  `bundesliga`, `seriea`, `ligue1`, `allsvenskan`, `mls`) — fully automatic.
  The feature contract is unchanged; the retrained models ship straight away.

- **A brand-new league** — its matches are still learned (they feed ELO,
  rolling form, and the global signal) but it shares the "other" (all-zero)
  one-hot bucket until it is *promoted* to a first-class league. Promotion is a
  deliberate, contract-changing edit: add the slug to `LEAGUES` /
  `LEAGUE_PRIORS` in `ensemble/train_supermodel_v2.py` **and** to the matching
  hardcoded league lists in `lib/halftimeFeatures.js` (production builds the
  feature vector by hand and must stay column-for-column identical to
  `*_features.json`). The retrain workflow has a **guard** that refuses to
  commit a model whose feature count changed, so a mismatched contract can
  never ship silently — if you add a new first-class league, the guard tells
  you exactly what to update.

### Validating a file locally (optional)

```bash
pip install numpy pandas requests
python3 ensemble/build_training_corpus.py --dry-run   # parse + summarise, writes nothing
```

This prints per-file match counts and the leagues it detected, without the
big-5 network fetch — a quick way to confirm a new CSV parses before you push.

---

## Required secrets

The engine needs three credentials. They are **never** stored in the repo — they
come from GitHub repository secrets and are injected as environment variables at
run time.

| Secret name | What it is |
| --- | --- |
| `SUPABASE_URL` | Your Supabase project URL (`https://<ref>.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase **service-role** key (server-side; full access) |
| `ODDS_API_KEY` | Your key for The Odds API (theoddsapi.com) |
| `RAPIDAPI_KEY` | *(optional)* API-Football key via RapidAPI — settles results for ROI/Yield/Win-rate. Sign up free at rapidapi.com → subscribe to "API-Football" (100 req/day free). If unset, settlement is skipped and the run still succeeds. |

### How to add them

1. Go to the repository on github.com.
2. Click **Settings** (top tab of the repo).
3. In the left sidebar: **Secrets and variables → Actions**.
4. Click **New repository secret**.
5. Enter the **Name** exactly as above (e.g. `SUPABASE_URL`) and paste the value.
6. Click **Add secret**.
7. Repeat for all three.

The values are in your local `engine/.env` file (which is git-ignored and never
pushed). Copy each value from there into the matching secret.

> ⚠️ Use the **service-role** key here, not the anon key. The service-role key
> bypasses row-level security and must only ever live in server-side secrets —
> never in the frontend or in committed code.

---

## Triggering a manual run

1. Go to the **Actions** tab of the repository.
2. Select **Run EVE Engine** in the left sidebar.
3. Click **Run workflow** (top right) → choose the branch (`main`) → **Run workflow**.
4. A new run appears within a few seconds; click it to watch the logs live.

The scheduled run fires automatically every 10 minutes once the workflow file is
on the default branch — no action needed. (GitHub's scheduler can lag by a few
minutes under load, and disables schedules after ~60 days of repo inactivity.)

---

## Running locally (optional)

You generally won't need to, but to run by hand:

```bash
npm install
export $(cat .env | xargs)
node ingestOdds.js
node computeValues.js
```

`.env` must define `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `ODDS_API_KEY`.
