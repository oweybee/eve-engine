# GitHub Actions schedule watchdog

GitHub's `schedule:` trigger is delivered **best-effort**, and this repo has
now observed it dropping in two different sizes:

- **~30 minutes**, documented in `engine.yml`'s own header from a 21 Aug
  incident ("GitHub was not delivering it anyway").
- **8-11+ hours**, observed 28 Aug 2026: `engine.yml`'s last
  `schedule`-triggered run completed 05:36 UTC. Nothing fired again until a
  manual `workflow_dispatch` ten and a half hours later — by which point
  `odds_snapshots` was 112 minutes stale with a fixture 26 minutes from
  kickoff. Nothing was queued, nothing was stuck on the concurrency lock;
  GitHub simply never delivered the trigger. `run-inplay.yml`, a separate
  workflow on its own cron, showed the identical shape in the same window
  (an 11.5h gap between its last two scheduled runs) — this is not one
  workflow's cron expression, it is GitHub's scheduler under load.

`run-inplay.yml` already has a real fix for this: `scripts/inplay-vps` moves
the whole in-play loop off GitHub Actions onto an always-on host. This does
the equivalent for the pre-match pipeline **without moving the pipeline
itself** — `engine.yml` stays exactly as it is, tested and budget-tuned as a
GitHub Actions job. All this adds is a second, independent trigger for it
that does not depend on GitHub's own scheduler being healthy.

## How it works

`ghWatchdog.js` reads the same freshness signal a human would check by hand:
`max(odds_snapshots.captured_at)` against the next `matches.kickoff_at`. If
the gap exceeds `WATCHDOG_STALE_MINUTES` (default 30), or a fixture is inside
`WATCHDOG_PREKICKOFF_WINDOW_MINUTES` (default 120) and the gap exceeds the
tighter `WATCHDOG_PREKICKOFF_STALE_MINUTES` (default 25), it calls
`POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches` — a direct
REST call, not a scheduled queue slot, so it is not subject to the same
throttling. It skips dispatching a workflow that already has a run queued or
in progress, so it can't pile duplicate runs on top of a schedule that is
merely running late rather than genuinely stalled.

It can only do this job running somewhere **other than** GitHub Actions —
putting the watchdog on its own GitHub Actions schedule would inherit the
exact failure it exists to catch. It needs no UK IP and no special access
beyond Supabase read + a scoped GitHub token, so it can share whichever host
already runs `scripts/betfair-vps` or `scripts/inplay-vps` if you run either.

## Where to run it (cheapest first)
- **£0** — the same host as `scripts/betfair-vps` or `scripts/inplay-vps`,
  if either is already deployed.
- **£0** — Oracle Cloud *Always Free* VM (any region — no geo requirement).
- **~£4-5/mo** — Hetzner / DigitalOcean / Vultr.

## One-time setup (Ubuntu/Debian)

If you already have `/opt/eve-engine` checked out for betfair-vps or
inplay-vps, skip straight to step 3.

```bash
# 1. Node 22 + git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2. Clone the engine
sudo git clone https://github.com/oweybee/eve-engine.git /opt/eve-engine
cd /opt/eve-engine && sudo npm install --omit=dev --no-audit --no-fund

# 3. Credentials
sudo cp scripts/gh-watchdog/.env.example scripts/gh-watchdog/.env
sudo nano scripts/gh-watchdog/.env      # fill in Supabase + GITHUB_TOKEN

# 4. Smoke test — should log a freshness line and, if fresh, do nothing
sudo bash scripts/gh-watchdog/run.sh --dry-run
```

### Minting the GitHub token
Settings → Developer settings → **Fine-grained personal access tokens** →
Generate new token, scoped to **only** `oweybee/eve-engine`, with repository
permission **Actions: Read and write** and nothing else. It cannot read
secrets, contents, or any other repo.

## Schedule it — pick ONE

### A) systemd timer (recommended)
```bash
sudo cp scripts/gh-watchdog/gh-watchdog.service /etc/systemd/system/
sudo cp scripts/gh-watchdog/gh-watchdog.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gh-watchdog.timer
systemctl list-timers gh-watchdog.timer           # confirm it's scheduled
journalctl -u gh-watchdog.service -f              # watch logs
```

### B) cron
```bash
sudo crontab -e
# add:
*/10 * * * * /opt/eve-engine/scripts/gh-watchdog/run.sh >> /var/log/maxedge-gh-watchdog.log 2>&1
```

## Keeping it current
```bash
cd /opt/eve-engine && sudo git pull && sudo npm install --omit=dev --no-audit --no-fund
```

## Verifying it works
`SuccessExitStatus=0 1` in the service unit means a transient failure (a
Supabase blip, a GitHub API hiccup) never marks the unit permanently failed —
which also means a *genuine* misconfiguration (a bad token, a typo'd repo
name) won't surface as a red systemd status either. Check the log, not just
`systemctl status`:

```bash
journalctl -u gh-watchdog.service --since "1 hour ago"
# expect lines like:
#   [gh-watchdog] odds_snapshots gap=4.2min next_kickoff=38.1min stale=false
```

To confirm the dispatch path itself (not just the check), force a stale read
by temporarily setting `WATCHDOG_STALE_MINUTES=0` in `.env` and running
`sudo bash scripts/gh-watchdog/run.sh` once — it should print
`dispatched engine.yml`, and a new run should appear at
https://github.com/oweybee/eve-engine/actions/workflows/engine.yml within a
few seconds. Put the threshold back afterwards.

## Turning it off
```bash
sudo systemctl disable --now gh-watchdog.timer
```
`engine.yml` falls back to being triggered by GitHub's own `schedule:` alone
— i.e. back to the failure mode this exists to catch.
