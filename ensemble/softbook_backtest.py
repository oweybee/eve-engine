#!/usr/bin/env python3
"""
ensemble/softbook_backtest.py — the realistic question: model vs a book you'd
ACTUALLY bet (Bet365), not vs Pinnacle's untouchable closing line.

Value betting as practised: use a sharp fair value, then take a SOFT book when it
prices higher. Here the λ-model's calibrated probability is the fair value
(observable at bet time, so anchoring on the Pinnacle close is legitimate — you
can see it when you place the bet), and we bet Bet365 closing where the model's
edge clears a threshold. We settle the SAME bets two ways:

  • at Bet365  — what you'd actually win.
  • at Pinnacle — the sharp benchmark (≈ breakeven).

The gap between them is the soft-book premium — the real, if limit-capped, edge.
CLV = ln(bet365 / pinnacle): positive means you took a better price than the
sharpest line. Out-of-sample holdout (≥ 2022-07); model trained < 2019-07.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from lambda_model import fit_predict
from monte_carlo import markets_from_matrix, score_matrix

VAL_END = pd.Timestamp("2022-07-01", tz="UTC")
OUTS = (("H", "b365h", "psh", "p_home"),
        ("D", "b365d", "psd", "p_draw"),
        ("A", "b365a", "psa", "p_away"))


def probs(lh, la):
    n = len(lh); ph = np.zeros(n); pd_ = np.zeros(n); pa = np.zeros(n)
    for i in range(n):
        mk = markets_from_matrix(score_matrix(lh[i], la[i]))["1x2"]
        ph[i], pd_[i], pa[i] = mk["home"], mk["draw"], mk["away"]
    return ph, pd_, pa


def main():
    te, lh, la = fit_predict()                       # close-anchored fair value
    ph, pd_, pa = probs(lh, la)
    te = te.assign(p_home=ph, p_draw=pd_, p_away=pa)
    d = te.dropna(subset=["b365h", "b365d", "b365a", "psh", "psd", "psa"])
    hold = d[d.date >= VAL_END]
    print("\n" + "=" * 70)
    print("MODEL vs BET365 (a book you'd actually bet) — out-of-sample ≥2022-07")
    print("=" * 70)
    print(f"Bet365+Pinnacle coverage on holdout: {len(hold):,} matches\n")
    print(f"{'edge≥':>6}{'bets':>8}{'ROI@Bet365':>12}{'ROI@Pinn':>11}{'meanCLV':>10}{'%+CLV':>7}{'avgOdds':>9}")
    for thr in (0.0, 0.03, 0.05, 0.10):
        bets = pnl_b = pnl_p = wins = 0
        clvs = []; oddsum = 0.0
        for oc, ob, op, opp in OUTS:
            b = hold[ob].to_numpy(); pin = hold[op].to_numpy(); p = hold[opp].to_numpy()
            occ = (hold.ftr == oc).to_numpy(int)
            edge = p * b - 1
            take = np.where((edge > thr) & (b > 1) & (pin > 1))[0]
            for i in take:
                bets += 1; wins += occ[i]; oddsum += b[i]
                pnl_b += (b[i] - 1) if occ[i] else -1
                pnl_p += (pin[i] - 1) if occ[i] else -1
                clvs.append(np.log(b[i] / pin[i]))
        if not bets:
            continue
        clvs = np.array(clvs)
        print(f"{int(thr*100):>5}%{bets:>8,}{100*pnl_b/bets:>+11.2f}%{100*pnl_p/bets:>+10.2f}%"
              f"{100*clvs.mean():>+9.2f}p{100*(clvs>0).mean():>6.0f}{oddsum/bets:>9.2f}")

    # How limits bite: the profit concentrates where Bet365 most beats the sharp
    # line — precisely the bets a soft book flags and restricts.
    print("\nWhere the edge lives (holdout, edge≥3%), by Bet365-vs-Pinnacle gap:")
    rows = []
    for oc, ob, op, opp in OUTS:
        b = hold[ob].to_numpy(); pin = hold[op].to_numpy(); p = hold[opp].to_numpy()
        occ = (hold.ftr == oc).to_numpy(int); e = p * b - 1
        for i in np.where((e > 0.03) & (b > 1) & (pin > 1))[0]:
            rows.append((b[i] / pin[i] - 1, (b[i] - 1) if occ[i] else -1))
    r = pd.DataFrame(rows, columns=["gap", "pnl"])
    for lo, hi, lbl in [(-1, 0.02, "Bet365 ≤ +2% vs Pinnacle"),
                        (0.02, 0.06, "Bet365 +2–6%"),
                        (0.06, 9, "Bet365 > +6% (soft misprice)")]:
        seg = r[(r.gap >= lo) & (r.gap < hi)]
        if len(seg):
            print(f"  {lbl:32s} bets={len(seg):>6,}  ROI={100*seg.pnl.mean():+6.2f}%")

    print("\nRead: ROI@Bet365 well above ROI@Pinnacle (≈0) = real value from taking the")
    print("soft price. But it clusters in the biggest soft-vs-sharp gaps — exactly the")
    print("bets Bet365 limits winners on. Real edge, capped by how long they let you bet.")


if __name__ == "__main__":
    main()
