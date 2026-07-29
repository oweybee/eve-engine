#!/usr/bin/env python3
"""
ensemble/monte_carlo.py — Dixon-Coles Monte Carlo match & season simulator.

THE IDEA
────────
The goals-model produces two expected-goals rates per fixture — λ_home and
λ_away (built from ELO, form, proxy-xG, conversion, set-piece threat, squad
value, home advantage). This module turns those rates into the FULL outcome
distribution, and from it every market price:

    1X2 · over/under (any line) · BTTS · correct score · clean sheet · win-to-nil

Two engines, same maths:
  • score_matrix()  — EXACT. Builds the joint scoreline probability grid
    (independent Poisson × the Dixon-Coles low-score correction), normalised.
    Best for match markets — deterministic, fast, no sampling noise.
  • simulate_match() — MONTE CARLO. Draws N scorelines from that grid. Same
    answers ± sampling error; the sampling path is what season simulation and
    exotic parlays need.

WHY DIXON-COLES (not plain Poisson)
───────────────────────────────────
Independent Poisson under-predicts 0-0 / 1-1 draws and over-predicts 1-0 / 0-1.
The Dixon-Coles τ correction reweights exactly those four scorelines by ρ
(rho, typically small and negative), restoring realistic draw probability —
directly relevant to the draw-collapse we saw in the classifier.

No third-party deps beyond numpy — ships anywhere the trainer runs.
"""
from __future__ import annotations

import math
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

# Default low-score dependence. Fit per-league later; -0.03…-0.06 is typical for
# football. 0.0 collapses this back to independent Poisson.
DEFAULT_RHO = -0.05
DEFAULT_MAX_GOALS = 10          # P(≥10 goals for one side) is ~0 at football λs
DEFAULT_OU_LINES = (0.5, 1.5, 2.5, 3.5, 4.5)


def _dc_tau(x: int, y: int, lh: float, la: float, rho: float) -> float:
    """Dixon-Coles low-score correction for scoreline (x, y)."""
    if x == 0 and y == 0:
        return 1.0 - lh * la * rho
    if x == 0 and y == 1:
        return 1.0 + lh * rho
    if x == 1 and y == 0:
        return 1.0 + la * rho
    if x == 1 and y == 1:
        return 1.0 - rho
    return 1.0


def score_matrix(lambda_home: float, lambda_away: float,
                 rho: float = DEFAULT_RHO,
                 max_goals: int = DEFAULT_MAX_GOALS) -> np.ndarray:
    """Joint scoreline probability grid M[h, a] = P(home=h, away=a).

    Independent Poisson marginals × Dixon-Coles τ, renormalised so it sums to 1.
    """
    lh = max(float(lambda_home), 1e-6)
    la = max(float(lambda_away), 1e-6)
    hs = np.arange(max_goals + 1)
    # Poisson pmf per side (vectorised, log-space for stability)
    log_ph = -lh + hs * math.log(lh) - np.array([math.lgamma(k + 1) for k in hs])
    log_pa = -la + hs * math.log(la) - np.array([math.lgamma(k + 1) for k in hs])
    ph = np.exp(log_ph)
    pa = np.exp(log_pa)
    M = np.outer(ph, pa)
    # Dixon-Coles correction on the four low scores
    for x in (0, 1):
        for y in (0, 1):
            M[x, y] *= _dc_tau(x, y, lh, la, rho)
    total = M.sum()
    return M / total if total > 0 else M


def markets_from_matrix(M: np.ndarray,
                        ou_lines: Sequence[float] = DEFAULT_OU_LINES,
                        top_scores: int = 6) -> Dict:
    """Derive market probabilities from a scoreline grid (exact)."""
    n = M.shape[0]
    idx = np.arange(n)
    home = float(np.tril(M, -1).sum())         # h > a
    draw = float(np.trace(M))                   # h == a
    away = float(np.triu(M, 1).sum())           # a > h
    total_goals = idx[:, None] + idx[None, :]

    ou = {}
    for line in ou_lines:
        over = float(M[total_goals > line].sum())
        ou[f"over_{line}"] = over
        ou[f"under_{line}"] = 1.0 - over

    btts_yes = float(M[1:, 1:].sum())           # both scored ≥1
    # Top correct scores
    flat = [((h, a), float(M[h, a])) for h in range(n) for a in range(n)]
    flat.sort(key=lambda kv: kv[1], reverse=True)
    correct_score = {f"{h}-{a}": p for (h, a), p in flat[:top_scores]}

    return {
        "1x2": {"home": home, "draw": draw, "away": away},
        "over_under": ou,
        "btts": {"yes": btts_yes, "no": 1.0 - btts_yes},
        "clean_sheet": {
            "home": float(M[:, 0].sum()),       # away scores 0
            "away": float(M[0, :].sum()),       # home scores 0
        },
        "correct_score": correct_score,
        "expected_goals": {
            "home": float((idx[:, None] * M).sum()),
            "away": float((idx[None, :] * M).sum()),
        },
    }


def price_match(lambda_home: float, lambda_away: float,
                rho: float = DEFAULT_RHO,
                ou_lines: Sequence[float] = DEFAULT_OU_LINES,
                max_goals: int = DEFAULT_MAX_GOALS) -> Dict:
    """Exact market prices for one fixture from its expected-goals rates."""
    return markets_from_matrix(score_matrix(lambda_home, lambda_away, rho, max_goals),
                               ou_lines=ou_lines)


def simulate_match(lambda_home: float, lambda_away: float,
                   rho: float = DEFAULT_RHO,
                   n: int = 20000,
                   rng: Optional[np.random.Generator] = None,
                   max_goals: int = DEFAULT_MAX_GOALS) -> Dict:
    """Monte Carlo: draw N scorelines from the DC grid → market frequencies.

    Same expectations as price_match(), ± 1/√N sampling noise. Use this path
    when you need sampled scorelines (season sims, parlay correlation).
    """
    rng = rng or np.random.default_rng()
    M = score_matrix(lambda_home, lambda_away, rho, max_goals)
    n_cells = M.size
    draws = rng.choice(n_cells, size=n, p=M.ravel())
    hg, ag = np.divmod(draws, M.shape[1])
    home = float(np.mean(hg > ag))
    draw = float(np.mean(hg == ag))
    away = float(np.mean(hg < ag))
    tot = hg + ag
    ou = {}
    for line in DEFAULT_OU_LINES:
        over = float(np.mean(tot > line))
        ou[f"over_{line}"] = over
        ou[f"under_{line}"] = 1.0 - over
    return {
        "1x2": {"home": home, "draw": draw, "away": away},
        "over_under": ou,
        "btts": {"yes": float(np.mean((hg >= 1) & (ag >= 1)))},
        "expected_goals": {"home": float(hg.mean()), "away": float(ag.mean())},
        "n": n,
    }


# ── In-play (live) pricing ──────────────────────────────────────────────────────

def price_live(lambda_home: float, lambda_away: float,
               minute: float, goals_home: int, goals_away: int,
               ou_lines: Sequence[float] = DEFAULT_OU_LINES,
               max_goals: int = DEFAULT_MAX_GOALS,
               full_minutes: float = 90.0) -> Dict:
    """Live market book from the pre-match rates + current state.

    The pre-match λ are full-match expected goals. In-play, only the REMAINING
    time can still produce goals: with (roughly uniform) arrival, remaining rate
    = λ · (remaining minutes / full). We grid the remaining-goals distribution,
    add the goals already on the board, and read every market off the FINAL
    score distribution.

    This is where a model edge is real — live markets are far less efficient than
    the pre-match close. Independent Poisson on the remainder (the Dixon-Coles
    low-score draw fix is a pre-match artefact and doesn't apply mid-game).
    """
    frac = max(0.0, (full_minutes - minute) / full_minutes)
    M = score_matrix(lambda_home * frac, lambda_away * frac, rho=0.0, max_goals=max_goals)
    n = M.shape[0]
    rh = np.arange(n)[:, None]          # remaining home goals
    ra = np.arange(n)[None, :]          # remaining away goals
    fh = goals_home + rh                # final home
    fa = goals_away + ra                # final away
    home = float(M[fh > fa].sum())
    draw = float(M[fh == fa].sum())
    away = float(M[fh < fa].sum())
    total = fh + fa
    ou = {}
    for line in ou_lines:
        over = float(M[total > line].sum())
        ou[f"over_{line}"] = over
        ou[f"under_{line}"] = 1.0 - over
    p_home_scores = 1.0 if goals_home >= 1 else float(1.0 - M[0, :].sum())
    p_away_scores = 1.0 if goals_away >= 1 else float(1.0 - M[:, 0].sum())
    return {
        "minute": minute, "score": [int(goals_home), int(goals_away)],
        "1x2": {"home": home, "draw": draw, "away": away},
        "over_under": ou,
        "btts": {"yes": p_home_scores * p_away_scores},
        "exp_final_goals": float((total * M).sum()),
    }


# ── Season simulation ──────────────────────────────────────────────────────────

def simulate_season(fixtures: Sequence[Tuple[str, str, float, float]],
                    rho: float = DEFAULT_RHO,
                    n_sims: int = 5000,
                    rng: Optional[np.random.Generator] = None,
                    points_win: int = 3) -> Dict[str, Dict[str, float]]:
    """Monte Carlo a whole season from per-fixture (home, away, λ_home, λ_away).

    Returns, per team: mean points, and P(finish 1st) / P(finish last). This is
    the season-level product the full pyramid unlocks — title / relegation /
    promotion probabilities — impossible from a per-match classifier.
    """
    rng = rng or np.random.default_rng()
    teams = sorted({t for h, a, _, _ in fixtures for t in (h, a)})
    tidx = {t: i for i, t in enumerate(teams)}
    nt = len(teams)

    # Pre-build each fixture's scoreline grid once; sample all sims from it.
    grids = [(tidx[h], tidx[a], score_matrix(lh, la, rho)) for h, a, lh, la in fixtures]

    points = np.zeros((n_sims, nt))
    first = np.zeros(nt)
    last = np.zeros(nt)
    for s in range(n_sims):
        pts = np.zeros(nt)
        for hi, ai, M in grids:
            cell = rng.choice(M.size, p=M.ravel())
            hg, ag = divmod(cell, M.shape[1])
            if hg > ag:
                pts[hi] += points_win
            elif hg < ag:
                pts[ai] += points_win
            else:
                pts[hi] += 1
                pts[ai] += 1
        points[s] = pts
        order = np.argsort(-pts)
        first[order[0]] += 1
        last[order[-1]] += 1

    return {
        teams[i]: {
            "mean_points": float(points[:, i].mean()),
            "p_first": float(first[i] / n_sims),
            "p_last": float(last[i] / n_sims),
        }
        for i in range(nt)
    }


if __name__ == "__main__":
    # Quick demo: a moderate home favourite.
    lh, la = 1.6, 1.1
    exact = price_match(lh, la)
    print(f"λ_home={lh}  λ_away={la}  ρ={DEFAULT_RHO}")
    print("1X2 (exact):    ", {k: round(v, 3) for k, v in exact["1x2"].items()})
    mc = simulate_match(lh, la, n=50000, rng=np.random.default_rng(0))
    print("1X2 (MC 50k):   ", {k: round(v, 3) for k, v in mc["1x2"].items()})
    print("Over/Under 2.5: ", {k: round(v, 3) for k, v in exact["over_under"].items()
                                if "2.5" in k})
    print("BTTS:           ", {k: round(v, 3) for k, v in exact["btts"].items()})
    print("Top scores:     ", {k: round(v, 3) for k, v in exact["correct_score"].items()})
