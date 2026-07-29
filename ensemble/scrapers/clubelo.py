#!/usr/bin/env python3
"""
ensemble/scrapers/clubelo.py — club world ranking (ClubElo) scraper.

ClubElo (clubelo.com) publishes a cross-league, world-wide club ranking by Elo,
with FULL daily history back to ~2000 and a clean CSV API — no auth, bulk-friendly.
We use it as an EXTERNAL "club world ranking" factor, independent of the engine's
own internal Elo (which is single-corpus). Its cross-league calibration is the
value-add: it ranks a Bundesliga side against a Premier League side on one scale.

API
───
  GET http://api.clubelo.com/YYYY-MM-DD
    → CSV of EVERY ranked club on that date:
      Rank,Club,Country,Level,Elo,From,To
  Iterating snapshots (weekly is plenty — Elo moves slowly) yields the whole
  history for every club at once, so we never need per-club URL spellings.

Output
──────
  ensemble/data/external/clubelo.csv  (long):  date,club,country,level,elo,rank
  → the feature builder joins it onto each match by (club, nearest prior date).

NOTE: this dev container's egress is allow-listed and blocks api.clubelo.com, so
this runs in CI (scrape-external.yml) or anywhere with open network — not here.
The CSV parsing is unit-tested offline in test_parsers.py.
"""
from __future__ import annotations

import argparse
import csv
import io
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, List, Optional

OUT = Path(__file__).resolve().parents[1] / "data" / "external" / "clubelo.csv"
API = "http://api.clubelo.com/{d}"
FIELDS = ["date", "club", "country", "level", "elo", "rank"]


def parse_snapshot(csv_text: str, snapshot: str) -> List[Dict]:
    """Parse one ClubElo date-snapshot CSV into normalised rows."""
    rows: List[Dict] = []
    reader = csv.DictReader(io.StringIO(csv_text))
    for r in reader:
        club = (r.get("Club") or "").strip()
        if not club:
            continue
        try:
            elo = float(r.get("Elo"))
        except (TypeError, ValueError):
            continue
        rank_raw = (r.get("Rank") or "").strip()
        rank = int(rank_raw) if rank_raw.isdigit() else None
        rows.append({
            "date": snapshot,
            "club": club,
            "country": (r.get("Country") or "").strip(),
            "level": (r.get("Level") or "").strip(),
            "elo": round(elo, 2),
            "rank": rank,
        })
    return rows


def _daterange(start: date, end: date, step_days: int):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=step_days)


def fetch_snapshot(session, d: str, retries: int = 3) -> Optional[str]:
    for attempt in range(retries):
        try:
            resp = session.get(API.format(d=d), timeout=30)
            if resp.status_code == 200 and resp.text.strip():
                return resp.text
            if resp.status_code == 404:
                return None
        except Exception as e:  # noqa: BLE001 — network best-effort
            print(f"  warn {d}: {e}")
        time.sleep(2 ** attempt)
    return None


def scrape(start: date, end: date, step_days: int, out: Path,
           pause: float = 0.3) -> int:
    """Iterate date snapshots → write the long ClubElo CSV. Returns row count."""
    import requests  # local import so the module imports without network deps
    session = requests.Session()
    session.headers.update({"User-Agent": "eve-engine-clubelo/1.0"})

    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for d in _daterange(start, end, step_days):
            ds = d.isoformat()
            text = fetch_snapshot(session, ds)
            if not text:
                continue
            rows = parse_snapshot(text, ds)
            w.writerows(rows)
            n += len(rows)
            print(f"  {ds}: {len(rows)} clubs  (total {n})")
            time.sleep(pause)
    print(f"\nwrote {n:,} rows -> {out}")
    return n


def main():
    ap = argparse.ArgumentParser(description="Scrape ClubElo world club ranking")
    ap.add_argument("--start", default="2000-01-01")
    ap.add_argument("--end", default=date.today().isoformat())
    ap.add_argument("--step-days", type=int, default=7, help="snapshot cadence (default weekly)")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    scrape(date.fromisoformat(args.start), date.fromisoformat(args.end),
           args.step_days, Path(args.out))


if __name__ == "__main__":
    main()
