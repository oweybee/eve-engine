#!/usr/bin/env python3
"""
ensemble/expected_goals.py — proxy Expected Goals + chance-conversion weighting.

THE PROBLEM YOU RAISED
──────────────────────
"1 penalty converts as often as ~20 corners; some teams (Arsenal) score from
corners more than most — how is that factored in?"

That is CHANCE-QUALITY WEIGHTING, which is exactly what Expected Goals does:
give every chance a conversion probability and sum them. Real xG (Understat/
Opta) prices each shot by location/angle/type. Football-data.co.uk has no xG —
but it DOES have, per match, each side's total shots (HS/AS), shots on target
(HST/AST) and corners (HC/AC). So we fit a transparent proxy:

    proxy_xG = w_sot · (shots on target)
             + w_off · (off-target shots)
             + w_cor · (corners)

The weights are the empirical GOAL VALUE of each chance type — the conversion
rates — fitted by non-negative least squares against actual goals across the
whole corpus. That yields statements like "1 shot on target ≈ N corners" *from
your data*, and a per-match expected-goals number for every league back to the
1990s.

WHAT THIS CAN AND CANNOT DO
───────────────────────────
CAN (from football-data, all leagues):
  • a stable xG proxy (xG predicts future goals better than past goals do)
  • team finishing / conversion:  actual goals − proxy_xG  (regress hard — most
    over-performance is noise, some is skill)
  • a set-piece VOLUME signal via corners.

CANNOT, without shot-situation data (Understat/FBref — a Tier-2 source):
  • separate penalty / open-play / set-piece xG (the true "20 corners = 1
    penalty" split), or isolate Arsenal's set-piece OVER-conversion from their
    open-play. Corner volume is only a proxy. When Understat is ingested,
    `situation_weights()` below is where those real per-situation values plug in.

Output feeds the goals-model: each team's rolling proxy-xG for/against become
λ inputs, and Monte Carlo (monte_carlo.py) turns λ into market prices.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import pandas as pd

CACHE = Path(__file__).parent / "models" / "_csv_cache_v3.csv.gz"

# Reference conversion rates for chance types football-data does NOT itemise —
# used for narrative/equivalence only until Understat situation data lands.
# Sources: public long-run football analytics (approximate).
PENALTY_XG = 0.79           # a penalty is worth ~0.79 goals


@dataclass
class XGWeights:
    """Fitted goal value (conversion rate) of each observed chance type."""
    sot: float               # goals per shot on target
    off: float               # goals per off-target shot
    corner: float            # goals per corner
    n_matches: int
    r2: float                # in-sample fit of goals ~ chances

    def xg(self, sot: float, shots: float, corners: float) -> float:
        """Proxy expected goals for one team-innings."""
        sot = 0.0 if sot is None or np.isnan(sot) else float(sot)
        shots = sot if shots is None or np.isnan(shots) else float(shots)
        corners = 0.0 if corners is None or np.isnan(corners) else float(corners)
        off = max(shots - sot, 0.0)
        return self.sot * sot + self.off * off + self.corner * corners

    def equivalences(self) -> Dict[str, float]:
        """Human-readable 'how many X equal one Y' from the fitted weights."""
        out = {}
        if self.corner > 0:
            out["shots_on_target_per_corner"] = self.sot / self.corner
            out["corners_per_penalty"] = PENALTY_XG / self.corner
        if self.sot > 0:
            out["corners_per_shot_on_target"] = self.corner / self.sot
            out["shots_on_target_per_penalty"] = PENALTY_XG / self.sot
        return out


def _stack_team_innings(df: pd.DataFrame) -> pd.DataFrame:
    """Two rows per match (home attack, away attack): chances → goals scored."""
    have = {"hst", "ast", "hs", "as", "hc", "ac", "fthg", "ftag"}
    if not have.issubset(df.columns):
        missing = have - set(df.columns)
        raise ValueError(f"corpus missing columns {missing}; rebuild the cache "
                         f"with the shots/corners schema")
    home = pd.DataFrame({
        "goals": pd.to_numeric(df["fthg"], errors="coerce"),
        "sot":   pd.to_numeric(df["hst"], errors="coerce"),
        "shots": pd.to_numeric(df["hs"],  errors="coerce"),
        "corners": pd.to_numeric(df["hc"], errors="coerce"),
    })
    away = pd.DataFrame({
        "goals": pd.to_numeric(df["ftag"], errors="coerce"),
        "sot":   pd.to_numeric(df["ast"], errors="coerce"),
        "shots": pd.to_numeric(df["as"],  errors="coerce"),
        "corners": pd.to_numeric(df["ac"], errors="coerce"),
    })
    both = pd.concat([home, away], ignore_index=True)
    # Only innings with the shot/corner data present (≈ 2000+ for most leagues)
    both = both.dropna(subset=["goals", "sot", "shots", "corners"])
    both = both[(both["shots"] >= both["sot"]) & (both["shots"] >= 0)]
    return both


def fit_weights(df: pd.DataFrame) -> XGWeights:
    """Non-negative least squares: goals ~ SoT + off-target + corners."""
    from scipy.optimize import nnls
    d = _stack_team_innings(df)
    off = (d["shots"] - d["sot"]).clip(lower=0.0)
    X = np.column_stack([d["sot"].to_numpy(), off.to_numpy(), d["corners"].to_numpy()])
    y = d["goals"].to_numpy(dtype=float)
    coef, _ = nnls(X, y)
    pred = X @ coef
    ss_res = float(np.sum((y - pred) ** 2))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    return XGWeights(sot=float(coef[0]), off=float(coef[1]), corner=float(coef[2]),
                     n_matches=len(df), r2=r2)


def situation_weights() -> Dict[str, float]:
    """TIER-2 HOOK: per-situation xG once Understat/FBref is ingested.

    Placeholder reference values (goals per attempt). When shot-situation data
    exists, replace these with fitted per-league values and build per-team
    'set-piece xG share' features here — that is where the true Arsenal-from-
    corners over-conversion gets isolated from open play.
    """
    return {"penalty": PENALTY_XG, "open_play_shot": 0.10,
            "set_piece_shot": 0.09, "direct_free_kick": 0.06}


def load_corpus(path: Path = CACHE) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"{path} not found — run build_training_corpus.py first")
    return pd.read_csv(path)


if __name__ == "__main__":
    df = load_corpus()
    w = fit_weights(df)
    cov = _stack_team_innings(df)
    print(f"Corpus: {len(df):,} matches; {len(cov):,} team-innings with shot/corner data\n")
    print("Fitted chance-conversion weights (goals per chance):")
    print(f"  shot on target : {w.sot:.4f}")
    print(f"  off-target shot: {w.off:.4f}")
    print(f"  corner         : {w.corner:.4f}")
    print(f"  fit R² (goals~chances): {w.r2:.3f}\n")
    eq = w.equivalences()
    print("Empirical equivalences from your data:")
    for k, v in eq.items():
        print(f"  {k:32s} {v:6.1f}")
    print(f"\n(reference, needs Understat to fit: 1 penalty ≈ {PENALTY_XG} xG)")
