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

**In-play run order** (`run-inplay.yml`):

1. `node ingestLiveOdds.js` — `/fixtures?live=all` updates `matches`
   (`status='live'`, current `goals_home/away`, `minute`); `/odds/live` writes
   the current 1X2 price under the synthetic bookmaker `apifootball_live`.
2. `node computeInplayValues.js` — Stage 1 then Stage 2, writing `phase='inplay'`.
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

### Telegram channels (two-tier)

`postToX.js` routes every signal by its conviction tier (`lib/signalTier.js`):

| Tier | Destination | Env var |
| --- | --- | --- |
| **Prime** (odds 1.40–3.00, edge 4–10%) | **Paid** channel | `TELEGRAM_PRIME_CHAT_ID` |
| **Value** / **Longshot** | **Free** channel | `TELEGRAM_FREE_CHAT_ID` |
| **In-play** | In-play channel | `TELEGRAM_INPLAY_CHAT_ID` |

A channel left unset means that tier is recorded (`posted_signals`) but not
posted. `TELEGRAM_PRIME_CHAT_ID` falls back to the legacy `TELEGRAM_CHAT_ID` if
unset, so an un-migrated deploy keeps posting Prime where it always did.
Below-floor edges (< 2%) are never posted. Set `TELEGRAM_PRIME_INVITE_URL` (a
GitHub Actions *variable*) to add a "Go Prime" upsell footer to free-channel
posts. Both the pre-match engine and the in-play job run `postToX.js` and share
the `posted_signals` dedup, so both carry the full channel config.

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
