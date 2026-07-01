# In-play worker (live signal cadence)

In-play edges close in seconds-to-minutes. GitHub Actions throttles the
`run-inplay` schedule to roughly every few hours — useless for reacting to a
goal. This runs the in-play loop on a small **always-on host** instead, on a
~30-second interval.

Unlike the Betfair worker, this needs **no UK IP** — API-Football works from
anywhere, so the cheapest free VM is fine. It can share the same host as
`scripts/betfair-vps/` if you already run that.

Each tick runs three idempotent, self-gating steps:

1. `ingestLiveOdds.js` — live score/minute/status + current 1X2 price
2. `computeInplayValues.js` — book-lag + model-vs-market + **win-prob** stages
3. `postToX.js` — posts in-play signals to `TELEGRAM_INPLAY_CHAT_ID` (if set)

When nothing is live it costs one `/fixtures?live=all` poll per tick and a couple
of DB reads — cheap enough to run continuously and stay inside the 75k/day
API-Football budget.

## Where to run it (cheapest first)
- **£0** — Oracle Cloud *Always Free* VM (any region).
- **£0** — any always-on machine / Raspberry Pi.
- **~£4/mo** — Hetzner / DigitalOcean / Vultr.

## One-time setup (Ubuntu/Debian)

```bash
# 1. Node 22 + git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2. Clone the engine
sudo git clone https://github.com/oweybee/eve-engine.git /opt/eve-engine
cd /opt/eve-engine && sudo npm install --omit=dev --no-audit --no-fund

# 3. Credentials
sudo cp scripts/inplay-vps/.env.example scripts/inplay-vps/.env
sudo nano scripts/inplay-vps/.env      # fill in Supabase + API-Football (+ Telegram)

# 4. Smoke test (Ctrl-C after a couple of ticks)
sudo bash scripts/inplay-vps/loop.sh
```

## Run it as a service (systemd)

```bash
sudo cp scripts/inplay-vps/inplay-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now inplay-worker
sudo systemctl status inplay-worker         # should be "active (running)"
journalctl -u inplay-worker -f              # live logs
```

The service restarts on crash/reboot (`Restart=always`).

## Rollout order (don't skip)
1. Deploy with `INPLAY_WINPROB_ENABLED=false` and **no** `TELEGRAM_INPLAY_CHAT_ID`
   — the worker just keeps live state fresh; no signals emitted.
2. Once the backtest looks good, set `INPLAY_WINPROB_ENABLED=true` but **still no**
   inplay chat id → signals are **recorded, not posted** (the forward-test).
   Watch the in-play row on the Performance page.
3. When the in-play yield/calibration holds up, set `TELEGRAM_INPLAY_CHAT_ID` to
   start publishing.

## Turning it off
```bash
sudo systemctl disable --now inplay-worker
```
Signals fall back to the (slow) GitHub `run-inplay` schedule.
