#!/usr/bin/env python3
"""Offline unit tests for the scraper parsers (no network).
Run: python3 ensemble/scrapers/test_parsers.py
"""
from clubelo import parse_snapshot
from names import best_match, key, normalize
from transfermarkt import parse_league_page, parse_value


def eq(a, b):
    assert a == b, f"{a!r} != {b!r}"


def approx(a, b, tol=1.0):
    assert abs(a - b) <= tol, f"{a} != {b}"


# ── Transfermarkt value parser ──────────────────────────────────────────────
def test_value_units():
    approx(parse_value("€1.20bn"), 1_200_000_000)
    approx(parse_value("€950.50m"), 950_500_000)
    approx(parse_value("€35.00m"), 35_000_000)
    approx(parse_value("€800k"), 800_000)
    approx(parse_value("£45.00m"), 45_000_000)


def test_value_empty():
    for s in ("-", "", "?", None, "€0"):
        eq(parse_value(s), None)


# ── Transfermarkt HTML table parse ──────────────────────────────────────────
_HTML = """
<table class="items"><tbody>
  <tr>
    <td class="hauptlink no-border-links"><a href="/x" title="Manchester City">Man City</a></td>
    <td class="zentriert">24</td>
    <td class="rechts hauptlink"><a href="/y">€1.29bn</a></td>
  </tr>
  <tr>
    <td class="hauptlink no-border-links"><a href="/z" title="Arsenal FC">Arsenal</a></td>
    <td class="zentriert">23</td>
    <td class="rechts hauptlink"><a href="/w">€1.02bn</a></td>
  </tr>
</tbody></table>
"""


def test_league_page_parse():
    rows = parse_league_page(_HTML, season_start=2023, league="epl")
    eq(len(rows), 2)
    eq(rows[0]["club"], "Manchester City")
    approx(rows[0]["squad_value_eur"], 1_290_000_000)
    eq(rows[1]["club"], "Arsenal FC")
    eq(rows[0]["league"], "epl")
    eq(rows[0]["season_start"], 2023)


# ── ClubElo snapshot parse ──────────────────────────────────────────────────
_ELO_CSV = ("Rank,Club,Country,Level,Elo,From,To\n"
            "1,Man City,ENG,1,2012.34,2023-05-01,2023-05-08\n"
            "2,Bayern,GER,1,1998.10,2023-05-01,2023-05-08\n"
            "None,Wigan,ENG,3,1499.99,2023-05-01,2023-05-08\n")


def test_clubelo_parse():
    rows = parse_snapshot(_ELO_CSV, "2023-05-04")
    eq(len(rows), 3)
    eq(rows[0]["club"], "Man City")
    eq(rows[0]["rank"], 1)
    approx(rows[0]["elo"], 2012.34, 0.01)
    eq(rows[2]["rank"], None)          # 'None' rank handled
    eq(rows[0]["date"], "2023-05-04")


# ── Name normalisation / matching ───────────────────────────────────────────
def test_normalize_and_alias():
    eq(key("Man City"), "manchestercity")
    eq(key("Manchester City"), "manchestercity")
    eq(key("Bayern Munich"), "bayernmunchen")
    eq(normalize("1. FC Köln"), normalize("FC Koln"))


def test_best_match():
    cands = ["Manchester City", "Manchester United", "Newcastle United"]
    m, s = best_match("Man City", cands)
    eq(m, "Manchester City")
    m2, s2 = best_match("Totally Unknown FC", cands, floor=0.86)
    eq(m2, None)                       # below floor → reported, not forced


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"  ✓ {t.__name__}")
    print(f"\nAll {len(tests)} scraper-parser tests passed.")
