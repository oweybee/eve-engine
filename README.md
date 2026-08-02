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

## Daily edge review — learning the sweet-spot edge from results

`.github/workflows/edge-review.yml` runs `node edgeReview.js` at 08:15 UTC and
answers, every morning, the question the PRIME box is currently guessing at:
**which edge band actually pays?**

**Why it exists.** The PRIME box in `lib/signalTier.js` — odds 1.40–3.00, edge
4–10% — was chosen as the best-performing cell of a matrix computed over
Jun 15 – Jul 3. That is a fine way to *form* a hypothesis and a bad way to
*hold* one: the maximum of many noisy estimates is biased upward, so a band
picked that way is expected to look worse afterwards even when it is genuinely
the best band. Until it is measured on results it did not come from, its
numbers are an estimate wearing the costume of a finding.

Each run prints, and stores to `edge_calibration` (migration 045):

1. **What settled**, fixture by fixture, with the edge each pick carried, its
   tier, its P&L and its CLV — plus a per-tier summary for the window.
2. **The edge carried by winners vs losers.** Asked for directly, and printed
   next to the losers' distribution on purpose: if the two are the same, the
   edge number is not separating outcomes and no band will fix that.
3. **The edge response** — strike, yield and a bootstrap interval per band,
   inside the PRIME odds window and across all prices.
4. **The box in-sample vs out-of-sample**, split at `PERFORMANCE_EPOCH`. This
   is the headline: rows before the epoch are the window the box was fitted on
   and cannot confirm it; only the rows after it can.
5. **A sweep of every edge band**, ranked by a Šidák-corrected lower bound on
   yield rather than by yield, so a band that looks spectacular on nine bets
   cannot win, and picking the best of ~100 boxes is priced in.
6. **A verdict** — `insufficient` / `hold` / `advisory` / `shift` — with the
   number of settled bets still needed before it could change.

**It never edits a threshold.** Moving the PRIME box is a human edit to
`lib/signalTier.js`; this job produces the evidence for or against it. A band
that re-fits itself nightly would chase every bad weekend and stop being a band.

```bash
node edgeReview.js                 # yesterday's results + full calibration
node edgeReview.js --days=7        # widen the settled-results window
node edgeReview.js --no-write      # print only, no snapshot row
node edgeReview.js --json          # machine-readable
```

Because the snapshot is a **history, not a singleton**, the useful signal
accrues over weeks: whether the same band keeps winning as the sample grows, or
whether the "optimum" wanders — which is itself the answer (no resolvable sweet
spot yet, hold the box).

---

## In-play signals

The pre-match engine and the in-play engine are **separate pipelines that share
one codebase**, kept apart so live picks never distort the headline CLV.

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
`INPLAY_MIN_ELO_GAMES` (default `5`), `LIVE_WINDOW_MIN` (default `160`),
`TELEGRAM_INPLAY_CHAT_ID`. ELO tuning: `ELO_K`, `ELO_HOME_ADV`, `ELO_DEFAULT`.

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
