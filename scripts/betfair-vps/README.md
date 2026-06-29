# Betfair ingest on a UK host

Betfair geo-blocks non-UK/IE IPs (GitHub Actions runs in the US → HTTP 403
"Restricted"), so `betfairIngest.js` can't run in CI. Run it instead on a small
**UK-based** host on a 15-minute cron. It writes Over/Under, BTTS, **corners** and
**cards (booking points)** straight to Supabase, and the rest of the stack (engine
compute, feed, detail, signals) picks them up automatically.

`betfairIngest.js` self-throttles (skips if it wrote within `BETFAIR_MIN_INTERVAL_MIN`,
default 12 min), so a slightly-too-frequent cron is harmless.

## Where to run it (cheapest first)
- **£0** — Oracle Cloud *Always Free* VM, **London (UK South)** region.
- **£0** — your own always-on UK machine / Raspberry Pi (a residential IP is the
  most reliable against Betfair's "unusual traffic" checks).
- **~£4–5/mo** — Hetzner / DigitalOcean / Vultr, London region.

> A UK **datacenter** IP normally passes Betfair's geo gate, but is occasionally
> flagged as "unusual". If you hit 403s on a cloud VPS, switch to a residential IP.

## One-time setup (Ubuntu/Debian)

```bash
# 1. Node 22 + git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2. Clone the engine
sudo git clone https://github.com/oweybee/eve-engine.git /opt/eve-engine
cd /opt/eve-engine && sudo npm install --omit=dev --no-audit --no-fund

# 3. Credentials (UK Betfair account + Supabase service role)
sudo cp scripts/betfair-vps/.env.example scripts/betfair-vps/.env
sudo nano scripts/betfair-vps/.env     # fill in the 5 values

# 4. Smoke test (should log events + inserted rows, NOT a 403)
sudo bash scripts/betfair-vps/run.sh
```

## Schedule it — pick ONE

### A) systemd timer (recommended)
```bash
sudo cp scripts/betfair-vps/betfair-ingest.service /etc/systemd/system/
sudo cp scripts/betfair-vps/betfair-ingest.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now betfair-ingest.timer
systemctl list-timers betfair-ingest.timer        # confirm it's scheduled
journalctl -u betfair-ingest.service -f           # watch logs
```

### B) cron
```bash
sudo crontab -e
# add:
*/15 * * * * /opt/eve-engine/scripts/betfair-vps/run.sh >> /var/log/maxedge-betfair.log 2>&1
```

## Keeping it current
```bash
cd /opt/eve-engine && sudo git pull && sudo npm install --omit=dev --no-audit --no-fund
```

## Verifying it works
After a run, in Supabase:
```sql
select market, count(*), max(fetched_at)
from odds where bookmaker = 'betfair_ex_uk'
group by market;   -- expect recent 'corners' and 'bookings' rows
```
Once corners/cards odds land, the engine's next compute prices them and they
appear on the feed card, detail tabs and signals — no further changes needed.
