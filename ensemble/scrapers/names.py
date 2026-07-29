#!/usr/bin/env python3
"""
ensemble/scrapers/names.py — club-name normalisation & matching.

The corpus (football-data), Transfermarkt and ClubElo all spell clubs
differently ("Man City" / "Manchester City" / "ManCity"). To join squad value
and club-world-ranking onto matches we need a stable key. Strategy:

  1. normalize()  — lowercase, strip accents/punctuation/suffixes ("FC", "AFC",
     "1.", "CF", "SC", …). Deterministic, no deps.
  2. ALIAS        — curated overrides for the stubborn ones.
  3. best_match() — difflib fuzzy fallback (stdlib) against a candidate set,
     with a similarity floor, so unmatched names are reported rather than
     silently mis-joined.

Coverage is iterative: scrapers emit every unmatched name to a report so the
ALIAS map can be grown over time. 1300+ clubs across 39 leagues — we do NOT
pretend this is 100% on day one.
"""
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher
from typing import Dict, Iterable, Optional, Tuple

# Common club-name noise stripped before comparison.
_SUFFIXES = [
    "fc", "afc", "cf", "sc", "ac", "as", "ss", "ssd", "ssc", "us", "ud", "cd",
    "sv", "vfb", "vfl", "tsv", "fsv", "bsc", "rc", "sd", "if", "bk", "ff", "aik",
    "calcio", "club", "the",
]
_PREFIXES = ["1.", "1", "real", "cd", "ca"]  # note: 'real'/'ca' handled carefully via ALIAS


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s)
                   if not unicodedata.combining(c))


def normalize(name: str) -> str:
    """Canonical comparison key for a club name."""
    if name is None:
        return ""
    s = strip_accents(str(name)).lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    toks = [t for t in s.split() if t]
    # drop leading '1' (e.g. "1. FC Koln") and trailing/leading generic suffixes
    toks = [t for t in toks if t not in _SUFFIXES]
    if toks and toks[0] in ("1",):
        toks = toks[1:]
    return "".join(toks)


# Curated cross-source aliases → canonical normalized key.
# Grown iteratively from the unmatched-name reports the scrapers emit.
ALIAS: Dict[str, str] = {
    # football-data short forms → canonical
    "man city": "manchestercity", "man united": "manchesterunited",
    "man utd": "manchesterunited", "nott'm forest": "nottinghamforest",
    "wolves": "wolverhampton", "sheffield weds": "sheffieldwednesday",
    "west brom": "westbromwichalbion", "spurs": "tottenham",
    "qpr": "queensparkrangers", "west ham": "westham",
    # Transfermarkt / ClubElo variants
    "manchester city": "manchestercity", "manchester united": "manchesterunited",
    "tottenham hotspur": "tottenham", "wolverhampton wanderers": "wolverhampton",
    "bayern munich": "bayernmunchen", "bayern munchen": "bayernmunchen",
    "fc bayern munich": "bayernmunchen", "borussia dortmund": "dortmund",
    "inter milan": "inter", "internazionale": "inter", "ac milan": "milan",
    "paris saint-germain": "parissaintgermain", "psg": "parissaintgermain",
    "atletico madrid": "atleticomadrid", "atletico de madrid": "atleticomadrid",
    "sporting cp": "sporting", "sporting lisbon": "sporting",
}


def key(name: str) -> str:
    """Alias-aware canonical key."""
    raw = str(name).strip().lower()
    if raw in ALIAS:
        return ALIAS[raw]
    n = normalize(name)
    return ALIAS.get(n, n)


def similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def best_match(name: str, candidates: Iterable[str],
               floor: float = 0.86) -> Tuple[Optional[str], float]:
    """Best fuzzy match of `name` among candidates (already raw names).

    Returns (candidate, score) or (None, best_score) if below the floor —
    callers should log the miss rather than force a join.
    """
    k = key(name)
    best, best_s = None, 0.0
    for c in candidates:
        s = similarity(k, key(c))
        if s > best_s:
            best, best_s = c, s
    return (best, best_s) if best_s >= floor else (None, best_s)
