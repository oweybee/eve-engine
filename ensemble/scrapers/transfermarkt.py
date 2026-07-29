#!/usr/bin/env python3
"""
ensemble/scrapers/transfermarkt.py — squad market value scraper.

Transfermarkt publishes each club's TOTAL squad market value per season on the
league overview ("startseite") page:

  https://www.transfermarkt.com/x/startseite/wettbewerb/{CODE}/plus/?saison_id={YEAR}

One request per (league, season) yields every club's value at once — far more
robust than per-club pages. saison_id is the season START year (2015 → 2015/16).

Output
──────
  ensemble/data/external/squad_values.csv:  league,season_start,club,squad_value_eur
  → joined onto matches as log(squad_value) and the home−away value gap: a
    FORWARD-looking talent prior that complements Elo (which is backward-looking
    form), strongest exactly where Elo is weakest — promoted sides, big summer
    spends, season openers.

CAVEATS
───────
  • Transfermarkt rate-limits and Cloudflare-challenges bots. This scraper uses a
    realistic UA, backs off, and paces requests; from some CI IP ranges it may
    still be blocked — run from an allowed network if so.
  • This dev container's egress blocks transfermarkt.com, so it runs in CI
    (scrape-external.yml) or locally, not here. The value + HTML parsers are
    unit-tested offline in test_parsers.py.
  • Club names differ from the corpus — join via scrapers/names.py; unmatched
    names are reported for the ALIAS map, never force-joined.
"""
from __future__ import annotations

import argparse
import csv
import re
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

OUT = Path(__file__).resolve().parents[1] / "data" / "external" / "squad_values.csv"
URL = "https://www.transfermarkt.com/x/startseite/wettbewerb/{code}/plus/?saison_id={year}"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# corpus league slug → Transfermarkt competition code. Starter set covering the
# leagues we actually price; extend as needed (the code is the only thing that
# matters — the URL slug is cosmetic).
LEAGUES: Dict[str, str] = {
    "epl": "GB1", "e1": "GB2", "e2": "GB3", "e3": "GB4",
    "bundesliga": "L1", "d2": "L2",
    "laliga": "ES1", "sp2": "ES2",
    "seriea": "IT1", "i2": "IT2",
    "ligue1": "FR1", "f2": "FR2",
    "n1": "NL1", "sc0": "SC1", "p1": "PO1", "t1": "TR1", "g1": "GR1", "b1": "BE1",
    # extra leagues (top tiers)
    "brazil_seriea": "BRA1", "argentina_ligaprofesional": "AR1N",
    "mexico_ligamx": "MEXA", "netherlands": "NL1",
}

_MULT = {"bn": 1_000_000_000, "m": 1_000_000, "k": 1_000, "th.": 1_000}


def parse_value(s: str) -> Optional[float]:
    """'€1.20bn' → 1.2e9 · '€950.50m' → 9.505e8 · '€35.00k' → 35000 · '-' → None."""
    if not s:
        return None
    t = str(s).strip().replace("\xa0", " ").lower()
    t = t.replace("€", "").replace("£", "").replace("$", "").strip()
    if not t or t in ("-", "?", "0"):
        return None
    m = re.match(r"^([0-9]+(?:\.[0-9]+)?)\s*(bn|m|k|th\.)?", t)
    if not m:
        return None
    val = float(m.group(1))
    unit = m.group(2)
    return val * _MULT.get(unit, 1.0)


def parse_league_page(html: str, season_start: int, league: str) -> List[Dict]:
    """Extract (club, total squad value) rows from a startseite page."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "lxml")
    table = soup.select_one("table.items")
    if table is None:
        return []
    rows: List[Dict] = []
    for tr in table.select("tbody > tr"):
        name_a = tr.select_one("td.hauptlink a[title], td.hauptlink a")
        if not name_a:
            continue
        club = (name_a.get("title") or name_a.get_text()).strip()
        if not club:
            continue
        # total squad value is the right-aligned value cell (last one in the row)
        val_cell = tr.select_one("td.rechts.hauptlink a") or tr.select_one("td.rechts a")
        value = parse_value(val_cell.get_text()) if val_cell else None
        if value is None:
            continue
        rows.append({
            "league": league, "season_start": season_start,
            "club": club, "squad_value_eur": int(value),
        })
    return rows


def fetch(session, code: str, year: int, retries: int = 3) -> Optional[str]:
    for attempt in range(retries):
        try:
            resp = session.get(URL.format(code=code, year=year), timeout=30)
            if resp.status_code == 200 and "table" in resp.text:
                return resp.text
            print(f"  warn {code}/{year}: HTTP {resp.status_code}")
        except Exception as e:  # noqa: BLE001
            print(f"  warn {code}/{year}: {e}")
        time.sleep(2 ** attempt + 1)
    return None


def scrape(leagues: Dict[str, str], years: range, out: Path,
           pause: float = 2.0) -> int:
    import requests
    session = requests.Session()
    session.headers.update({"User-Agent": UA, "Accept-Language": "en"})
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["league", "season_start", "club", "squad_value_eur"])
        w.writeheader()
        for league, code in leagues.items():
            for year in years:
                html = fetch(session, code, year)
                if not html:
                    continue
                rows = parse_league_page(html, year, league)
                w.writerows(rows)
                n += len(rows)
                print(f"  {league:26s} {year}: {len(rows)} clubs (total {n})")
                time.sleep(pause)
    print(f"\nwrote {n:,} rows -> {out}")
    return n


def main():
    ap = argparse.ArgumentParser(description="Scrape Transfermarkt squad values")
    ap.add_argument("--from-year", type=int, default=2005)
    ap.add_argument("--to-year", type=int, default=2025)
    ap.add_argument("--leagues", default="", help="comma-separated corpus slugs (default: all configured)")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    leagues = LEAGUES if not args.leagues else {
        k: LEAGUES[k] for k in args.leagues.split(",") if k in LEAGUES}
    scrape(leagues, range(args.from_year, args.to_year + 1), Path(args.out))


if __name__ == "__main__":
    main()
