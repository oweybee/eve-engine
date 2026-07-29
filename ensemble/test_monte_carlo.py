#!/usr/bin/env python3
"""Self-checks for monte_carlo.py — run: python3 ensemble/test_monte_carlo.py"""
import numpy as np

from monte_carlo import (score_matrix, price_match, simulate_match,
                         simulate_season, DEFAULT_RHO)


def approx(a, b, tol=1e-9):
    assert abs(a - b) <= tol, f"{a} != {b} (tol {tol})"


def test_matrix_normalised():
    M = score_matrix(1.5, 1.2)
    approx(float(M.sum()), 1.0, 1e-9)
    assert (M >= 0).all()


def test_1x2_sums_to_one():
    p = price_match(1.7, 1.0)["1x2"]
    approx(p["home"] + p["draw"] + p["away"], 1.0, 1e-9)


def test_symmetry():
    # Equal rates → equal home/away win prob (draw picks up the rest).
    p = price_match(1.3, 1.3)["1x2"]
    approx(p["home"], p["away"], 1e-9)


def test_favourite_monotonic():
    weak = price_match(1.0, 1.5)["1x2"]["home"]
    strong = price_match(2.0, 1.0)["1x2"]["home"]
    assert strong > weak, "higher λ_home must raise P(home win)"


def test_over_under_complement_and_monotonic():
    ou = price_match(1.6, 1.4)["over_under"]
    for line in (0.5, 1.5, 2.5, 3.5, 4.5):
        approx(ou[f"over_{line}"] + ou[f"under_{line}"], 1.0, 1e-9)
    # Over probability must fall as the line rises.
    overs = [ou[f"over_{l}"] for l in (0.5, 1.5, 2.5, 3.5, 4.5)]
    assert all(overs[i] >= overs[i + 1] for i in range(len(overs) - 1))


def test_dc_lifts_draw_vs_independent():
    # Dixon-Coles (ρ<0) should give more draw probability than independent Poisson.
    dc = price_match(1.2, 1.2, rho=DEFAULT_RHO)["1x2"]["draw"]
    indep = price_match(1.2, 1.2, rho=0.0)["1x2"]["draw"]
    assert dc > indep, "DC low-score correction should raise draw probability"


def test_mc_matches_exact():
    rng = np.random.default_rng(0)
    exact = price_match(1.5, 1.1)["1x2"]
    mc = simulate_match(1.5, 1.1, n=80000, rng=rng)["1x2"]
    for k in ("home", "draw", "away"):
        approx(exact[k], mc[k], 0.01)  # within sampling noise


def test_season_probabilities_valid():
    rng = np.random.default_rng(1)
    # tiny 3-team double round-robin
    fx = [("A", "B", 1.6, 1.0), ("B", "A", 1.4, 1.1),
          ("A", "C", 1.8, 0.8), ("C", "A", 1.2, 1.3),
          ("B", "C", 1.5, 1.0), ("C", "B", 1.3, 1.2)]
    table = simulate_season(fx, n_sims=2000, rng=rng)
    approx(sum(t["p_first"] for t in table.values()), 1.0, 1e-9)
    approx(sum(t["p_last"] for t in table.values()), 1.0, 1e-9)
    # Strongest team (A) should most often finish first.
    assert max(table, key=lambda t: table[t]["p_first"]) == "A"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ✓ {t.__name__}")
    print(f"\nAll {len(tests)} Monte Carlo tests passed.")
