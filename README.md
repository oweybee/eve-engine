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
