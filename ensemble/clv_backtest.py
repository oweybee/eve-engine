#!/usr/bin/env python3
"""
ensemble/clv_backtest.py — the genuine alpha test: closing-line value from the
OPENING price.

The pre-match backtest showed the model matches the sharp CLOSE (breakeven), so
its only edge was line-shopping. The real question a model should answer: if you
bet the EARLY (opening) price, does the market then move TOWARD your bets? That
is closing-line value (CLV), and it's the cleanest, least-gameable evidence of
predictive edge — a bettor with persistent positive CLV is beating the market
before it sharpens.

Method: bet model value at the market-average OPENING odds; measure
  CLV = ln(open_odds / close_odds)  per bet (positive = line shortened our way).
Both prices are the market average (same source), so vig cancels and the
baseline over all outcomes is ~0. Model-selected bets beating that baseline =
signal. Also reports ROI settled at the opening price (the realistic fill).

Model trained < 2019-07; evaluated on ≥ 2019-07 with opening+closing coverage.
"""
from __future__ import annotations

import numpy as np

from lambda_model import fit_predict
from monte_carlo import markets_from_matrix, score_matrix

OUTS = (("H", "oh", "ch", "p_home"),
        ("D", "od", "cd", "p_draw"),
        ("A", "oa", "ca", "p_away"))


def probs(lh, la):
    n = len(lh); ph = np.zeros(n); pd_ = np.zeros(n); pa = np.zeros(n)
    for i in range(n):
        mk = markets_from_matrix(score_matrix(lh[i], la[i]))["1x2"]
        ph[i], pd_[i], pa[i] = mk["home"], mk["draw"], mk["away"]
    return ph, pd_, pa


def main():
    te, lh, la = fit_predict(anchor="open")  # anchor on OPENING, not closing — no leakage
    ph, pd_, pa = probs(lh, la)
    te = te.assign(p_home=ph, p_draw=pd_, p_away=pa)
    d = te.dropna(subset=["oh", "od", "oa", "ch", "cd", "ca"]).copy()

    print("\n" + "=" * 66)
    print("CLOSING-LINE-VALUE TEST (bet the OPENING price, ≥2019-07)")
    print("=" * 66)
    print(f"opening+closing coverage: {len(d):,} of {len(te):,} test matches")

    # Baseline: mean CLV over ALL outcomes = market's own open→close drift (~0).
    base = []
    for _, o_open, o_close, _ in OUTS:
        oo = d[o_open].to_numpy(); co = d[o_close].to_numpy()
        m = (oo > 1) & (co > 1)
        base.extend(np.log(oo[m] / co[m]))
    base = np.array(base)
    print(f"baseline (all outcomes) meanCLV = {100*base.mean():+.3f}pp  "
          f"(vig-neutral reference, ≈0)\n")

    print(f"{'edge≥':>6}{'bets':>9}{'ROI@open':>10}{'meanCLV':>10}{'%+CLV':>8}{'t':>7}")
    for thr in (0.0, 0.03, 0.05):
        clvs = []; pnl = 0.0; bets = 0
        for oc, o_open, o_close, o_p in OUTS:
            oo = d[o_open].to_numpy(); co = d[o_close].to_numpy(); p = d[o_p].to_numpy()
            occ = (d.ftr == oc).to_numpy(int)
            edge = p * oo - 1
            take = np.where((edge > thr) & (oo > 1) & (co > 1))[0]
            for i in take:
                bets += 1
                pnl += (oo[i] - 1) if occ[i] else -1
                clvs.append(np.log(oo[i] / co[i]))
        clvs = np.array(clvs)
        if len(clvs) < 2:
            continue
        t = clvs.mean() / (clvs.std(ddof=1) / np.sqrt(len(clvs)))
        print(f"{int(thr*100):>5}%{bets:>9,}{100*pnl/bets:>+9.2f}%"
              f"{100*clvs.mean():>+9.2f}p{100*(clvs>0).mean():>7.0f}{t:>7.1f}")

    print("\nRead: meanCLV ABOVE the baseline (with positive t) = genuine edge — the")
    print("market moves toward the model's early bets. AT/BELOW baseline with negative")
    print("ROI@open = no predictive edge once the model can't see the closing line.")


if __name__ == "__main__":
    main()
