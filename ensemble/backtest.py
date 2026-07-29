#!/usr/bin/env python3
"""
ensemble/backtest.py — honest, out-of-sample backtest of the λ-model strategy.

Avoids the classic backtest trap (pick winning leagues after seeing results):
  • Model trained on   < 2019-07  (as always).
  • VALIDATION window  2019-07 → 2022-07  → choose which leagues to bet.
  • HOLDOUT window     2022-07 →  now     → NEVER used for any decision; the
    reported P&L comes only from here.

Strategy (fixed a-priori from the audit): back 1X2 at best price where the
model's edge ≥ 3% and the outcome isn't a longshot (market prob ≥ 0.25), only in
leagues that were profitable in validation. Reports flat-stakes ROI and a
fractional-Kelly bankroll curve; compares to betting ALL leagues to show the
league selection generalises.

Prices: best available closing ("Max"). Real fills are a shade worse — treat the
ROI as an upper bound and the CLV/relative pattern as the robust signal.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from lambda_model import fit_predict
from monte_carlo import markets_from_matrix, score_matrix

VAL_END = pd.Timestamp("2022-07-01", tz="UTC")
EDGE, MIN_MKT_P, KELLY = 0.03, 0.25, 0.25
OUTS = (("H", "maxh", "m_home", "p_home"),
        ("D", "maxd", "m_draw", "p_draw"),
        ("A", "maxa", "m_away", "p_away"))
# Realistic-price floor: same bets, but priced at sharp Pinnacle close instead
# of the single best book. Truth sits between these two.
PIN = {"maxh": "psh", "maxd": "psd", "maxa": "psa"}


def add_probs(te, lh, la):
    n = len(te)
    ph = np.zeros(n); pd_ = np.zeros(n); pa = np.zeros(n)
    for i in range(n):
        mk = markets_from_matrix(score_matrix(lh[i], la[i]))["1x2"]
        ph[i], pd_[i], pa[i] = mk["home"], mk["draw"], mk["away"]
    return te.assign(p_home=ph, p_draw=pd_, p_away=pa)


def flat_roi(frame, leagues=None, price_at="max"):
    """Flat 1-unit stakes. Bet SELECTION uses best-price (Max) edge; settlement
    price is Max ('max') or the sharp Pinnacle close ('pin')."""
    bets = pnl = wins = 0
    d = frame if leagues is None else frame[frame.league.isin(leagues)]
    for oc, oc_odds, oc_mkt, oc_p in OUTS:
        best = d[oc_odds].to_numpy()
        settle = d[PIN[oc_odds]].to_numpy() if price_at == "pin" else best
        mp = d[oc_mkt].to_numpy(); p = d[oc_p].to_numpy()
        occ = (d.ftr == oc).to_numpy(int)
        edge = p * best - 1                       # decide on the price you'd shop for
        take = np.where((edge > EDGE) & ~np.isnan(best) & ~np.isnan(settle) & (mp >= MIN_MKT_P))[0]
        for i in take:
            bets += 1; wins += occ[i]; pnl += (settle[i] - 1) if occ[i] else -1
    return bets, (pnl / bets if bets else 0.0), wins


def league_selection(val):
    sel = []
    for lg, d in val.groupby("league"):
        b, roi, _ = flat_roi(d)
        if b >= 100 and roi > 0:
            sel.append(lg)
    return sorted(sel)


def kelly_curve(hold, leagues):
    """Fractional-Kelly bankroll over the holdout, bets in date order."""
    d = hold[hold.league.isin(leagues)].sort_values("date")
    bank = peak = 1.0; maxdd = 0.0; bets = wins = 0
    for r in d.itertuples():
        for oc, oc_odds, oc_mkt, oc_p in OUTS:
            odds = getattr(r, oc_odds); mp = getattr(r, oc_mkt); p = getattr(r, oc_p)
            if np.isnan(odds) or mp < MIN_MKT_P:
                continue
            edge = p * odds - 1
            if edge <= EDGE:
                continue
            f = max(0.0, (p * odds - 1) / (odds - 1)) * KELLY
            stake = f * bank
            if stake <= 0:
                continue
            win = (r.ftr == oc)
            bank += stake * (odds - 1) if win else -stake
            bets += 1; wins += int(win)
            peak = max(peak, bank); maxdd = max(maxdd, (peak - bank) / peak)
    return bank, maxdd, bets, wins


def main():
    te, lh, la = fit_predict()
    te = add_probs(te, lh, la)
    val = te[te.date < VAL_END]
    hold = te[te.date >= VAL_END]
    print("\n" + "=" * 66)
    print("HONEST BACKTEST — validation picks leagues, holdout pays out")
    print("=" * 66)
    print(f"validation {val.date.min().date()}→{val.date.max().date()}  ({len(val):,} matches)")
    print(f"holdout    {hold.date.min().date()}→{hold.date.max().date()}  ({len(hold):,} matches)")

    sel = league_selection(val)
    print(f"\nLeagues profitable in validation → bet in holdout ({len(sel)}):\n  {', '.join(sel)}")

    # Out-of-sample holdout results
    b_all, roi_all, _ = flat_roi(hold)
    b_sel, roi_sel, w_sel = flat_roi(hold, sel)
    _, roi_sel_pin, _ = flat_roi(hold, sel, price_at="pin")
    print("\n── HOLDOUT (out-of-sample), flat 1u stakes ──")
    print(f"  bet ALL leagues   @ best price:   bets={b_all:,}  ROI={100*roi_all:+.2f}%")
    print(f"  bet SELECTED      @ best price:   bets={b_sel:,}  ROI={100*roi_sel:+.2f}%  win%={100*w_sel/max(b_sel,1):.1f}")
    print(f"  bet SELECTED      @ Pinnacle:     bets={b_sel:,}  ROI={100*roi_sel_pin:+.2f}%   ← realistic floor")
    print("  → true achievable ROI sits between these two.")

    bank, maxdd, kb, kw = kelly_curve(hold, sel)
    yrs = (hold.date.max() - VAL_END).days / 365.25
    cagr = bank ** (1 / yrs) - 1 if yrs > 0 and bank > 0 else float("nan")
    print(f"\n── HOLDOUT fractional-Kelly ({KELLY:g}×), selected leagues ──")
    print(f"  bets={kb:,}  bankroll ×{bank:.2f} over {yrs:.1f}y  (~{100*cagr:+.0f}%/yr)  "
          f"max drawdown {100*maxdd:.0f}%")
    print("\n(prices = best available close; real fills a bit worse — ROI is an upper bound)")


if __name__ == "__main__":
    main()
