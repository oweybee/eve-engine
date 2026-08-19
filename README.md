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
