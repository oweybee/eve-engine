#!/usr/bin/env python3
"""
ensemble/train_lambda_prod.py — production build of the λ (expected-goals) model.

Unlike lambda_model.py (research: chronological train/test split for honest
evaluation), this trains on the FULL corpus and exports everything the Node.js
engine needs to run the "model vs market" board live:

  models/lambda_home.onnx / lambda_away.onnx
      float32[1,20] feature vector → expected goals (count:poisson; ONNX parity
      with native XGBoost verified to <1e-3).

  models/lambda_bundle.json
      feature_order            — exact input order (contract with lib/lambdaBoard.js)
      league_stats             — per-league {home_gf, away_gf, draw_rate}
      league_tags              — proven / neutral / avoid (holdout ROI evidence)
      seg_weights / tag_weights— credible-edge ranking weights
      defaults                 — fallbacks for unknown clubs
      clubs                    — per club-key CURRENT state: elo, rolling gf/ga,
                                 rolling proxy-xG, squad value (log10 €), aliases
                                 resolved. The corpus runs to the present, so this
                                 is tomorrow's pre-match state; refreshed on every
                                 weekly retrain.

The Node side then only does: normalize club name → look up state → assemble
vector → ONNX → Dixon-Coles price sheet → compare to live odds.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb

from expected_goals import fit_weights
from lambda_model import (CACHE, ELO_DEFAULT, FEATURES, build_features,
                          load_squad_values, resolve_names)
from scrapers.names import key as club_key

MODELS = Path(__file__).parent / "models"

LEAGUE_GOOD = {"e1", "e3", "epl", "e2", "ec", "sc1", "sc2", "austria_bundesliga",
               "g1", "argentina_copadelaligaprofesional"}
LEAGUE_AVOID = {"china_superleague", "finland_veikkausliiga", "denmark_superliga",
                "mexico_ligamx", "t1", "russia_premierleague"}


def current_club_state(feat: pd.DataFrame) -> dict:
    """Latest pre-match state per club, from each club's most recent feature row.

    A club's newest row already contains its walk-forward elo + rolling form as
    of its last match — exactly the state to price its NEXT match.
    """
    state = {}
    f = feat.sort_values("date")
    for side, e, gfc, gac, xgc in (("home", "elo_home", "h_gf", "h_ga", "h_xg"),
                                   ("away", "elo_away", "a_gf", "a_ga", "a_xg")):
        for r in f.itertuples(index=False):
            name = getattr(r, side)
            state[club_key(name)] = {
                "name": name, "league": r.league,
                "elo": round(float(getattr(r, e)), 1),
                "gf": round(float(getattr(r, gfc)), 3),
                "ga": round(float(getattr(r, gac)), 3),
                "xg": round(float(getattr(r, xgc)), 3),
                "sv": round(float(r.sv_home if side == "home" else r.sv_away), 3),
                "sv_has": int(r.sv_has),
                "last": str(pd.Timestamp(r.date).date()),
            }
    return state


def main():
    print("Loading corpus …")
    df = pd.read_csv(CACHE, low_memory=False)
    df["date"] = pd.to_datetime(df["date"], utc=True, errors="coerce")
    for c in ["fthg", "ftag", "hst", "ast", "hs", "as", "hc", "ac",
              "psh", "psd", "psa", "maxh", "maxd", "maxa",
              "b365h", "b365d", "b365a", "o25", "u25", "oh", "od", "oa",
              "ch", "cd", "ca"]:
        df[c] = pd.to_numeric(df.get(c), errors="coerce")
    df = df.dropna(subset=["fthg", "ftag", "date"])
    xw = fit_weights(df)

    squad, tm_keys = load_squad_values()
    corpus_keys = (df.assign(k=df["home"].map(club_key))
                     .groupby("league")["k"].apply(set).to_dict()) if squad else {}
    resolve = resolve_names(corpus_keys, tm_keys) if squad else {}

    print("Walk-forward features (full corpus) …")
    feat = build_features(df.rename(columns={"as": "ashots"}), xw, squad, resolve)
    print(f"  {len(feat):,} odds matches")

    # League stats from the whole corpus (production: no holdout needed)
    g = feat.groupby("league")
    league_stats = {
        lg: {"home_gf": round(float(d.fthg.mean()), 3),
             "away_gf": round(float(d.ftag.mean()), 3),
             "draw": round(float((d.ftr == "D").mean()), 3)}
        for lg, d in g
    }
    gl = {"home_gf": round(float(feat.fthg.mean()), 3),
          "away_gf": round(float(feat.ftag.mean()), 3),
          "draw": round(float((feat.ftr == "D").mean()), 3)}
    feat["lg_home_gf"] = feat["league"].map(lambda l: league_stats[l]["home_gf"])
    feat["lg_away_gf"] = feat["league"].map(lambda l: league_stats[l]["away_gf"])
    feat["lg_draw"] = feat["league"].map(lambda l: league_stats[l]["draw"])

    X = feat[FEATURES].to_numpy(np.float32)
    params = dict(objective="count:poisson", max_depth=4, learning_rate=0.05,
                  n_estimators=500, subsample=0.8, colsample_bytree=0.8,
                  reg_alpha=0.5, reg_lambda=2.0, min_child_weight=5,
                  random_state=42, n_jobs=-1)
    print("Training λ_home / λ_away on full corpus …")
    mh = xgb.XGBRegressor(**params).fit(X, feat["fthg"])
    ma = xgb.XGBRegressor(**params).fit(X, feat["ftag"])

    # ── Export ONNX + verify parity ──────────────────────────────────────────
    from onnxmltools import convert_xgboost
    from onnxmltools.convert.common.data_types import FloatTensorType
    import onnxruntime as ort
    MODELS.mkdir(exist_ok=True)
    it = [("float_input", FloatTensorType([None, len(FEATURES)]))]
    for name, model in (("lambda_home", mh), ("lambda_away", ma)):
        onnx = convert_xgboost(model, initial_types=it)
        (MODELS / f"{name}.onnx").write_bytes(onnx.SerializeToString())
        sess = ort.InferenceSession((MODELS / f"{name}.onnx").read_bytes(),
                                    providers=["CPUExecutionProvider"])
        sample = X[:500]
        diff = float(np.abs(model.predict(sample) -
                            sess.run(None, {"float_input": sample})[0].ravel()).max())
        assert diff < 1e-3, f"{name}: ONNX parity broke ({diff})"
        print(f"  ✓ {name}.onnx  (parity {diff:.2e})")

    # ── Bundle: contract + current per-club state ────────────────────────────
    clubs = current_club_state(feat)
    bundle = {
        "built_at": str(pd.Timestamp(feat.date.max()).date()),
        "n_train": len(feat),
        "feature_order": FEATURES,
        "league_stats": league_stats,
        "league_global": gl,
        "league_tags": {**{k: "proven" for k in LEAGUE_GOOD},
                        **{k: "avoid" for k in LEAGUE_AVOID}},
        "seg_weights": {"fav": 1.0, "mid": 0.85, "longshot": 0.35},
        "tag_weights": {"proven": 1.0, "neutral": 0.75, "avoid": 0.4},
        "max_plausible_edge": 0.25,
        "defaults": {"elo": ELO_DEFAULT, "gf_home": 1.35, "gf_away": 1.15,
                     "sv": round(float(np.median([c["sv"] for c in clubs.values()])), 3)},
        "clubs": clubs,
    }
    out = MODELS / "lambda_bundle.json"
    out.write_text(json.dumps(bundle))
    print(f"  ✓ lambda_bundle.json  ({len(clubs):,} clubs, {len(league_stats)} leagues, "
          f"{out.stat().st_size/1024:.0f} KB)")
    print("\nProduction λ-model build complete.")


if __name__ == "__main__":
    main()
