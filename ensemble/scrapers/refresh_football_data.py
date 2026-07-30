#!/usr/bin/env python3
"""
ensemble/scrapers/refresh_football_data.py — keep the corpus current in-season.

THE PROBLEM THIS SOLVES
───────────────────────
The λ model's club state (Elo, rolling form) is built from the CSVs in
ensemble/data/. Those are static season files, so as 2026/27 plays out the
ratings freeze at the corpus's last date — a weekly retrain rebuilds from the
same stale files and Elo never advances. Promoted sides stay seeded, in-form
teams stay cold, and the board's fair values drift out of date.

football-data.co.uk updates its CURRENT-season files continuously (typically a
few times a week). Re-downloading them is all that's needed to keep the model
learning through the season.

WHY THIS IS SAFE TO RE-RUN
Files are written to ensemble/data/_current/, and build_training_corpus.py
already dedups on (league, date, home, away) keeping the RICHEST row. So a
current-season file that overlaps an existing archive file merges cleanly instead
of double-counting — the dedup built for the mirror/upload overlap covers this
case for free.

Usage:
  python3 ensemble/scrapers/refresh_football_data.py            # current season
  python3 ensemble/scrapers/refresh_football_data.py --season 2526
  python3 ensemble/scrapers/refresh_football_data.py --dry-run
"""
from __future__ import annotations

import argparse
import time
from datetime import date
from pathlib import Path

BASE = "https://www.football-data.co.uk/mmz4281/{season}/{div}.csv"
OUT_DIR = Path(__file__).resolve().parents[1] / "data" / "_current"

# football-data.co.uk division codes we hold history for. Keep in step with the
# country folders under ensemble/data/ — these are the same divisions, just the
# live season instead of the archive.
DIVISIONS = [
    "E0", "E1", "E2", "E3", "EC",          # England
    "SC0", "SC1", "SC2", "SC3",            # Scotland
    "D1", "D2",                            # Germany
    "SP1", "SP2",                          # Spain
    "I1", "I2",                            # Italy
    "F1", "F2",                            # France
    "N1",                                  # Netherlands
    "P1",                                  # Portugal
    "T1",                                  # Turkey
    "G1",                                  # Greece
    "B1",                                  # Belgium
]

MIN_BYTES = 200          # anything smaller isn't a real season file


def current_season(today: date | None = None) -> str:
    """football-data season code: Aug 2026 → '2627', Feb 2027 → '2627'."""
    d = today or date.today()
    start = d.year if d.month >= 7 else d.year - 1
    return f"{str(start)[2:]}{str(start + 1)[2:]}"


def looks_like_csv(text: str) -> bool:
    """Reject error pages / empty responses that would poison the corpus."""
    if not text or len(text.encode("utf-8", "ignore")) < MIN_BYTES:
        return False
    head = text.splitlines()[0] if text.splitlines() else ""
    # a real football-data file always has Div + Date + the two team columns
    return ("Div" in head and "Date" in head
            and ("HomeTeam" in head or "Home" in head))


def fetch(div: str, season: str, session, retries: int = 3):
    url = BASE.format(season=season, div=div)
    for attempt in range(retries):
        try:
            r = session.get(url, timeout=30)
            if r.status_code == 404:
                return None                      # division not in this season
            r.raise_for_status()
            # football-data serves cp1252; decode leniently, the parser re-reads it
            text = r.content.decode("utf-8", "ignore")
            if not looks_like_csv(text):
                print(f"  skip {div}: response doesn't look like a season CSV")
                return None
            return r.content
        except Exception as e:  # noqa: BLE001 — best-effort refresh
            print(f"  warn {div} (attempt {attempt + 1}): {e}")
            time.sleep(2 ** attempt)
    return None


def main():
    ap = argparse.ArgumentParser(description="Refresh current-season football-data CSVs")
    ap.add_argument("--season", default=None, help="season code, e.g. 2627 (default: current)")
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pause", type=float, default=1.0, help="seconds between requests")
    args = ap.parse_args()

    season = args.season or current_season()
    out = Path(args.out)
    print(f"Refreshing {len(DIVISIONS)} division(s) for season {season} → {out}")
    if args.dry_run:
        for d in DIVISIONS:
            print(f"  would fetch {BASE.format(season=season, div=d)}")
        return

    import requests
    session = requests.Session()
    session.headers.update({"User-Agent": "eve-engine-corpus-refresh/1.0"})
    out.mkdir(parents=True, exist_ok=True)

    wrote = skipped = 0
    for div in DIVISIONS:
        body = fetch(div, season, session)
        if body is None:
            skipped += 1
            continue
        path = out / f"{div}_{season}.csv"
        path.write_bytes(body)
        wrote += 1
        print(f"  ✓ {div}: {len(body) / 1024:.0f} KB → {path.name}")
        time.sleep(args.pause)

    print(f"\nrefreshed {wrote} division(s), skipped {skipped}")
    if wrote:
        print("build_training_corpus.py will merge these and dedup on "
              "(league, date, home, away) — safe to re-run.")


if __name__ == "__main__":
    main()
