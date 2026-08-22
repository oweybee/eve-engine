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


# Letters NFKD CANNOT decompose. `l/`, dotless `i`, `o/`, sharp-s and friends are
# distinct LETTERS rather than a base plus a combining mark, so NFKD leaves them
# whole and `[^a-z0-9 ]` below turns each into a SPACE — the letter does not
# become its ASCII cousin, it DISAPPEARS:
#
#     Wisla Plock (diacritic form)   -> wisapock      not wislaplock
#     Zaglebie Lubin (ditto)         -> zagebielubin  not zaglebielubin
#
# Measured 22 Aug 2026: our `teams` rows are ASCII and The Odds API sends the
# diacritic form, so ONE club produced TWO keys and the fixture join could never
# be made. This mirrors the same table in eve-engine/lib/lambdaBoard.js — the two
# MUST stay in step, which is why the fix lands in both files together.
#
# NOT a loosened threshold: this is a character identity and cannot bring two
# DIFFERENT clubs together.
# BOTH CASES, because `normalize` calls strip_accents BEFORE `.lower()` — a
# lowercase-only table let "Widzew Lodz" (uppercase L-stroke) through to the
# strip and back to `widzewodz`, which the JS mirror got right by lowercasing
# first. Caught by diffing the two implementations rather than by reading them.
_UNDECOMPOSABLE = str.maketrans({
    "\u0142": "l",  "\u0141": "L",   # l/L with stroke
    "\u0131": "i",  "\u0130": "I",   # dotless i / dotted I
    "\u00f8": "o",  "\u00d8": "O",   # o/O with stroke
    "\u00df": "ss", "\u1e9e": "SS",  # sharp s
    "\u0111": "d",  "\u0110": "D",
    "\u00f0": "d",  "\u00d0": "D",
    "\u00fe": "th", "\u00de": "Th",
    "\u00e6": "ae", "\u00c6": "Ae",
    "\u0153": "oe", "\u0152": "Oe",
    "\u0127": "h",  "\u0126": "H",
    "\u014b": "n",  "\u014a": "N",
    "\u0167": "t",  "\u0166": "T",
    "\u0138": "k",
})


def strip_accents(s: str) -> str:
    folded = "".join(c for c in unicodedata.normalize("NFKD", s)
                     if not unicodedata.combining(c))
    return folded.translate(_UNDECOMPOSABLE)


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
