"""unanchored_eval.py — does the model have a view of its own?

THE QUESTION
The production λ-model takes the market's overround-removed probabilities
(m_home, m_draw, m_away) as its first three FEATURES. So when it "disagrees"
with the market it is disagreeing with a number it was built from, and the
disagreement is bounded by construction. That is a defensible design — the
market is the sharpest single predictor available — but it means the board
cannot honestly be described as an INDEPENDENT second opinion.

This trains the identical model with those three columns removed, so the only
inputs are fundamentals: Elo, rolling form, proxy-xG and squad value. Same
corpus, same walk-forward features, same chronological split, same Poisson
targets (home goals / away goals), same Dixon-Coles pricing of the outcomes.
One difference.

WHAT IT IS NOT
Removing m_* does NOT remove an outcome. The targets are fthg/ftag — goals —
and home/draw/away are derived afterwards from the scoreline matrix. The
unanchored model still prices all three outcomes; it simply is not shown the
bookmaker's answer first.

Usage:  python3 ensemble/unanchored_eval.py
"""
from __future__ import annotations

import json
import pathlib

import numpy as np
import pandas as pd
import xgboost as xgb

from lambda_model import (
    CACHE, FEATURES, SPLIT, add_league_stats, build_features, club_key,
    load_squad_values, resolve_names,
)
from expected_goals import fit_weights
from monte_carlo import markets_from_matrix, score_matrix

MARKET_COLS = ["m_home", "m_draw", "m_away"]
FUNDAMENTALS = [f for f in FEATURES if f not in MARKET_COLS]

PARAMS = dict(objective="count:poisson", max_depth=4, learning_rate=0.05,
              n_estimators=500, subsample=0.8, colsample_bytree=0.8,
              reg_alpha=0.5, reg_lambda=2.0, min_child_weight=5,
              random_state=42, n_jobs=-1)

OUT = pathlib.Path(__file__).parent / "models" / "unanchored_report.json"


def build_once(anchor="open"):
    """Feature frame + split. anchor='open' so the market columns are the OPENING
    price: using the close leaked the answer into the CLV backtest before."""
    print("Loading corpus …")
    df = pd.read_csv(CACHE, low_memory=False)
    df["date"] = pd.to_datetime(df["date"], utc=True, errors="coerce")
    for c in ["fthg", "ftag", "hst", "ast", "hs", "as", "hc", "ac",
              "psh", "psd", "psa", "maxh", "maxd", "maxa"]:
        df[c] = pd.to_numeric(df.get(c), errors="coerce")
    df = df.dropna(subset=["fthg", "ftag", "date"])

    xw = fit_weights(df)
    squad, tm_keys = load_squad_values()
    corpus_keys = (df.assign(k=df["home"].map(club_key))
                     .groupby("league")["k"].apply(set).to_dict()) if squad else {}
    resolve = resolve_names(corpus_keys, tm_keys) if squad else {}

    print("Walk-forward feature build …")
    feat = build_features(df.rename(columns={"as": "ashots"}), xw, squad, resolve,
                          anchor=anchor)
    train_mask = feat["date"] < SPLIT
    feat = add_league_stats(feat, train_mask)
    tr, te = feat[train_mask], feat[~train_mask]
    print(f"  train {len(tr):,}   test {len(te):,}")
    return tr, te.reset_index(drop=True)


def train(tr, te, cols, label):
    Xtr, Xte = tr[cols].to_numpy(np.float32), te[cols].to_numpy(np.float32)
    print(f"Training {label} ({len(cols)} features) …")
    mh = xgb.XGBRegressor(**PARAMS).fit(Xtr, tr["fthg"])
    ma = xgb.XGBRegressor(**PARAMS).fit(Xtr, tr["ftag"])
    return (np.clip(mh.predict(Xte), 0.05, 6.0),
            np.clip(ma.predict(Xte), 0.05, 6.0))


def outcome_probs(lh, la):
    n = len(lh)
    ph, pd_, pa = np.zeros(n), np.zeros(n), np.zeros(n)
    for i in range(n):
        mk = markets_from_matrix(score_matrix(lh[i], la[i]))["1x2"]
        ph[i], pd_[i], pa[i] = mk["home"], mk["draw"], mk["away"]
    return ph, pd_, pa


def ece_ll(preds3, occ3):
    preds = np.concatenate(preds3)
    occ = np.concatenate(occ3)
    bins = np.linspace(0, 1, 11)
    idx = np.clip(np.digitize(preds, bins) - 1, 0, 9)
    ece = sum(abs(preds[idx == b].mean() - occ[idx == b].mean()) * (idx == b).mean()
              for b in range(10) if (idx == b).any())
    ll = -np.mean(occ * np.log(np.clip(preds, 1e-9, 1)) +
                  (1 - occ) * np.log(np.clip(1 - preds, 1e-9, 1)))
    return float(ece), float(ll)


def roi_clv(te, probs, thr=0.03):
    """Flat-stake at the BEST book price; CLV benchmarked to the Pinnacle close."""
    best = {"H": te.maxh.to_numpy(), "D": te.maxd.to_numpy(), "A": te.maxa.to_numpy()}
    pin = {"H": te.psh.to_numpy(), "D": te.psd.to_numpy(), "A": te.psa.to_numpy()}
    pm = dict(zip("HDA", probs))
    bets = pnl = wins = 0
    clv = 0.0
    nclv = 0
    for oc in "HDA":
        odds, p = best[oc], pm[oc]
        occ = (te.ftr == oc).to_numpy(int)
        take = np.where((p * odds - 1 > thr) & ~np.isnan(odds))[0]
        for i in take:
            bets += 1
            pnl += (odds[i] - 1) if occ[i] else -1
            wins += occ[i]
            if not np.isnan(pin[oc][i]) and pin[oc][i] > 0:
                clv += np.log(odds[i] / pin[oc][i]); nclv += 1
    if not bets:
        return dict(bets=0)
    return dict(bets=int(bets), roi_pct=round(100 * pnl / bets, 2),
                win_pct=round(100 * wins / bets, 1),
                mean_clv_pp=round(100 * clv / max(nclv, 1), 2))


def main():
    tr, te = build_once(anchor="open")
    occ3 = [(te.ftr == o).to_numpy(int) for o in "HDA"]

    lh_a, la_a = train(tr, te, FEATURES, "ANCHORED")
    lh_u, la_u = train(tr, te, FUNDAMENTALS, "UNANCHORED")

    print("Pricing outcomes from the scoreline matrices …")
    anc = outcome_probs(lh_a, la_a)
    una = outcome_probs(lh_u, la_u)
    mkt = (te.m_home.to_numpy(), te.m_draw.to_numpy(), te.m_away.to_numpy())

    rows = []
    for label, p in (("Market (opening)", mkt), ("Anchored λ", anc), ("Unanchored λ", una)):
        e, ll = ece_ll(p, occ3)
        rows.append(dict(model=label, ece=round(e, 4), log_loss=round(ll, 4),
                         **roi_clv(te, p)))

    # How far apart are the two models' views? This is the number that decides
    # whether the unanchored model is worth showing: if it tracks the anchored
    # one it adds nothing, if it diverges wildly it is probably just noisy.
    gap = np.abs(np.concatenate(una) - np.concatenate(anc)) * 100
    gap_mkt = np.abs(np.concatenate(una) - np.concatenate(mkt)) * 100

    print("\n" + "=" * 78)
    print("ANCHORED vs UNANCHORED  (chronological holdout ≥ 2019-07, opening-price anchor)")
    print("=" * 78)
    print(f"{'model':22s}{'ECE':>9s}{'log-loss':>11s}{'bets':>9s}{'ROI%':>9s}{'CLVpp':>9s}")
    for r in rows:
        print(f"{r['model']:22s}{r['ece']:>9.4f}{r['log_loss']:>11.4f}"
              f"{r.get('bets', 0):>9,}{r.get('roi_pct', 0):>+9.2f}{r.get('mean_clv_pp', 0):>+9.2f}")

    print(f"\ndisagreement (percentage points, 1X2 probabilities):")
    print(f"  unanchored vs anchored : mean {gap.mean():5.2f}pp   p90 {np.percentile(gap, 90):5.2f}pp")
    print(f"  unanchored vs market   : mean {gap_mkt.mean():5.2f}pp   p90 {np.percentile(gap_mkt, 90):5.2f}pp")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(dict(
        rows=rows, n_test=int(len(te)),
        features_anchored=FEATURES, features_unanchored=FUNDAMENTALS,
        disagreement_vs_anchored_pp=dict(mean=float(gap.mean()),
                                         p90=float(np.percentile(gap, 90))),
        disagreement_vs_market_pp=dict(mean=float(gap_mkt.mean()),
                                       p90=float(np.percentile(gap_mkt, 90))),
    ), indent=2))
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
