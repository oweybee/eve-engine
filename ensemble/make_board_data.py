#!/usr/bin/env python3
"""
ensemble/make_board_data.py — generate the "model vs market" opportunity board
sample from real holdout matches.

For the most recent slice of the out-of-sample holdout, computes for every
fixture: model fair probs (1X2 + O/U 2.5 via Monte Carlo), market implied probs,
best-price edges, and HONEST confidence tags derived from the backtest evidence:

  price_seg : fav / mid / longshot        (FLB: favourite edges reliable,
                                           longshot edges systematically bad)
  league_tag: proven / neutral / avoid    (per-league holdout ROI)

Emits JSON for the board page. Every row is a real match with real odds.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from lambda_model import fit_predict
from monte_carlo import markets_from_matrix, score_matrix

OUT = Path("/tmp/board_data.json")

# From the holdout per-league breakdown (best-price, edge≥3%)
LEAGUE_GOOD = {"e1", "e3", "epl", "e2", "ec", "sc1", "sc2", "austria_bundesliga",
               "g1", "argentina_copadelaligaprofesional"}
LEAGUE_AVOID = {"china_superleague", "finland_veikkausliiga", "denmark_superliga",
                "mexico_ligamx", "t1", "russia_premierleague"}

LEAGUE_LABEL = {
    "epl": "Premier League", "e1": "Championship", "e2": "League One",
    "e3": "League Two", "ec": "National League", "sc0": "Scottish Prem",
    "sc1": "Scottish Champ", "sc2": "Scottish L1", "sc3": "Scottish L2",
    "bundesliga": "Bundesliga", "d2": "2. Bundesliga", "laliga": "La Liga",
    "sp2": "Segunda", "seriea": "Serie A", "i2": "Serie B", "ligue1": "Ligue 1",
    "f2": "Ligue 2", "n1": "Eredivisie", "p1": "Primeira Liga", "t1": "Süper Lig",
    "g1": "Super League GR", "b1": "Pro League BE", "austria_bundesliga": "AT Bundesliga",
    "china_superleague": "CSL", "denmark_superliga": "Superliga DK",
    "finland_veikkausliiga": "Veikkausliiga", "mexico_ligamx": "Liga MX",
    "russia_premierleague": "RPL", "argentina_copadelaligaprofesional": "Copa LPF",
}


def seg_of(market_p):
    if market_p >= 0.5: return "fav"
    if market_p >= 0.25: return "mid"
    return "longshot"


def league_tag(lg):
    if lg in LEAGUE_GOOD: return "proven"
    if lg in LEAGUE_AVOID: return "avoid"
    return "neutral"


def main():
    te, lh, la = fit_predict()
    # newest matches with full best-price odds, positionally aligned with lh/la
    pos = np.where(te[["maxh", "maxd", "maxa"]].notna().all(axis=1))[0]
    pos = pos[np.argsort(te["date"].to_numpy()[pos])][-3000:]
    rows = []
    for i in pos:
        r = te.iloc[i]
        mk = markets_from_matrix(score_matrix(lh[i], la[i]))
        p1 = mk["1x2"]; pou = mk["over_under"]
        cands = [
            ("Home", p1["home"], r.maxh, r.m_home),
            ("Draw", p1["draw"], r.maxd, r.m_draw),
            ("Away", p1["away"], r.maxa, r.m_away),
        ]
        if not (pd.isna(r.o25) or pd.isna(r.u25)):
            tot = 1 / r.o25 + 1 / r.u25
            cands += [("Over 2.5", pou["over_2.5"], r.o25, (1 / r.o25) / tot),
                      ("Under 2.5", pou["under_2.5"], r.u25, (1 / r.u25) / tot)]
        for name, p, odds, mkt_p in cands:
            if pd.isna(odds) or odds <= 1:
                continue
            edge = p * odds - 1
            # 2% floor; >25% is almost always a stale/illiquid price, not value
            # (mirrors the engine's MAX_PLAUSIBLE_EDGE guard)
            if edge <= 0.02 or edge > 0.25:
                continue
            seg = seg_of(mkt_p)
            rows.append({
                "date": str(pd.Timestamp(r.date).date()),
                "league": LEAGUE_LABEL.get(r.league, r.league),
                "lgkey": r.league,
                "home": r.home, "away": r.away,
                "market": name,
                "model_p": round(float(p), 3),
                "market_p": round(float(mkt_p), 3),
                "odds": round(float(odds), 2),
                "fair_odds": round(1 / float(p), 2),
                "edge": round(100 * float(edge), 1),
                "seg": seg,
                "tag": league_tag(r.league),
                "result": {"H": "Home", "D": "Draw", "A": "Away"}[r.ftr],
                "goals": f"{int(r.fthg)}–{int(r.ftag)}",
            })
    # Rank by CREDIBLE edge, not raw edge — encode the backtest evidence:
    # favourites/mid segments are where flagged edges actually paid; longshot
    # edges are systematically overstated (FLB). Proven leagues outrank avoids.
    SEG_W = {"fav": 1.0, "mid": 0.85, "longshot": 0.35}
    TAG_W = {"proven": 1.0, "neutral": 0.75, "avoid": 0.4}
    for x in rows:
        x["score"] = round(x["edge"] * SEG_W[x["seg"]] * TAG_W[x["tag"]], 1)
    rows.sort(key=lambda x: -x["score"])
    # diversify: one pick per fixture, cap 60 rows
    seen = {}
    board = []
    for x in rows:
        k = (x["home"], x["away"], x["date"])
        if seen.get(k, 0) >= 1:
            continue
        seen[k] = seen.get(k, 0) + 1
        board.append(x)
        if len(board) >= 60:
            break
    OUT.write_text(json.dumps(board, indent=1))
    n_fav = sum(1 for b in board if b["seg"] == "fav")
    n_mid = sum(1 for b in board if b["seg"] == "mid")
    print(f"wrote {len(board)} opportunities → {OUT}  (fav {n_fav} / mid {n_mid} / "
          f"longshot {len(board)-n_fav-n_mid})")
    print("sample:", json.dumps(board[0], indent=1))


if __name__ == "__main__":
    main()
