#!/usr/bin/env python3
"""
ensemble/audit.py — ML data + market audit over the historical corpus.

Answers, on the 295k-match corpus, the questions that decide how to build the
goals-model:

  A. Coverage & integrity   — per league: size, era, odds/shot/corner coverage,
                              result mix. Where is the data thin?
  B. Cross-division continuity — teams that move between divisions (why a single
                              cross-league Elo / world ranking matters).
  C. Market calibration     — how honest are closing odds, and where is the
                              favourite–longshot bias? That bias is where value lives.
  D. Proxy-xG validation    — does rolling proxy-xG predict scoring better than
                              rolling goals? (justifies the xG feature).

Pure pandas over models/_csv_cache_v3.csv.gz — run after build_training_corpus.py.
Writes docs/ML_AUDIT.md and prints the same report.
"""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pandas as pd

from expected_goals import fit_weights

CACHE = Path(__file__).parent / "models" / "_csv_cache_v3.csv.gz"
REPORT = Path(__file__).resolve().parents[1] / "docs" / "ML_AUDIT.md"


def load() -> pd.DataFrame:
    df = pd.read_csv(CACHE, low_memory=False)
    df["date"] = pd.to_datetime(df["date"], utc=True, errors="coerce")
    for c in ["fthg", "ftag", "hst", "ast", "hs", "as", "hc", "ac",
              "psh", "psd", "psa"]:
        df[c] = pd.to_numeric(df.get(c), errors="coerce")
    return df


def section_coverage(df: pd.DataFrame) -> str:
    rows = []
    g = df.groupby("league")
    for lg, d in g:
        n = len(d)
        rows.append({
            "league": lg, "n": n,
            "from": d["date"].min().date(), "to": d["date"].max().date(),
            "odds%": round(100 * d["psh"].notna().mean()),
            "shots%": round(100 * d["hs"].notna().mean()),
            "corners%": round(100 * d["hc"].notna().mean()),
            "home%": round(100 * (d["ftr"] == "H").mean()),
            "draw%": round(100 * (d["ftr"] == "D").mean()),
        })
    t = pd.DataFrame(rows).sort_values("n", ascending=False)
    out = ["## A. Coverage & integrity", "",
           f"- **{len(df):,} matches**, {len(t)} divisions, "
           f"{df['date'].min().date()} → {df['date'].max().date()}",
           f"- Closing odds on **{round(100*df['psh'].notna().mean())}%**, "
           f"shots on **{round(100*df['hs'].notna().mean())}%**, "
           f"corners on **{round(100*df['hc'].notna().mean())}%** of matches",
           f"- Overall result mix: Home {round(100*(df.ftr=='H').mean())}% / "
           f"Draw {round(100*(df.ftr=='D').mean())}% / Away {round(100*(df.ftr=='A').mean())}%",
           "", t.to_markdown(index=False)]
    return "\n".join(out)


def section_continuity(df: pd.DataFrame) -> str:
    # team → set of leagues it played home matches in
    tl = df.groupby("home")["league"].nunique().sort_values(ascending=False)
    movers = tl[tl > 1]
    ex = ", ".join(movers.index[:12])
    return "\n".join([
        "## B. Cross-division continuity", "",
        f"- **{len(movers):,}** clubs appear in **more than one division** "
        f"(promotion/relegation) out of {df['home'].nunique():,} total.",
        f"- Their Elo/form history should carry ACROSS divisions — a single "
        f"cross-league rating (our internal Elo + ClubElo world ranking) captures "
        f"this; a per-league model throws it away each promotion.",
        f"- Examples (most divisions played): {ex}",
    ])


def _implied(df: pd.DataFrame) -> pd.DataFrame:
    d = df.dropna(subset=["psh", "psd", "psa"]).copy()
    inv = 1.0 / d[["psh", "psd", "psa"]].to_numpy()
    over = inv.sum(axis=1, keepdims=True)
    p = inv / over            # overround-removed implied probabilities
    d["p_home"], d["p_draw"], d["p_away"] = p[:, 0], p[:, 1], p[:, 2]
    return d


def section_calibration(df: pd.DataFrame) -> str:
    d = _implied(df)
    # Pool the three outcomes: each match → 3 (predicted, occurred) points.
    preds = np.concatenate([d["p_home"], d["p_draw"], d["p_away"]])
    occ = np.concatenate([(d.ftr == "H").astype(int), (d.ftr == "D").astype(int),
                          (d.ftr == "A").astype(int)])
    # Reliability deciles
    bins = np.linspace(0, 1, 11)
    idx = np.clip(np.digitize(preds, bins) - 1, 0, 9)
    rows, ece = [], 0.0
    for b in range(10):
        m = idx == b
        if not m.any():
            continue
        pm, om, w = preds[m].mean(), occ[m].mean(), m.mean()
        ece += w * abs(pm - om)
        rows.append({"implied_prob_bin": f"{bins[b]:.1f}-{bins[b+1]:.1f}",
                     "n": int(m.sum()),
                     "predicted": round(pm, 3), "actual": round(om, 3),
                     "gap(a-p)": round(om - pm, 3)})
    market_ll = float(-np.mean(occ * np.log(np.clip(preds, 1e-9, 1)) +
                               (1 - occ) * np.log(np.clip(1 - preds, 1e-9, 1))))
    t = pd.DataFrame(rows)
    return "\n".join([
        "## C. Market calibration & favourite–longshot bias", "",
        f"- Closing-odds (Pinnacle, overround-removed) on {len(d):,} matches.",
        f"- **Expected Calibration Error: {ece:.4f}** (lower = sharper market).",
        f"- Market binary log-loss: {market_ll:.4f}.",
        f"- Read the gap column: **negative at high prob = favourites slightly "
        f"over-priced; positive at low prob = longshots over-bet** (classic FLB) "
        f"— the soft spots a calibrated model can exploit.",
        "", t.to_markdown(index=False),
    ])


def section_proxy_xg(df: pd.DataFrame) -> str:
    w = fit_weights(df)
    # per-team innings, chronological
    d = df.dropna(subset=["hst", "hs", "hc", "fthg", "ftag"]).sort_values("date")
    home = pd.DataFrame({"team": d["home"], "date": d["date"], "gf": d["fthg"],
                         "xg": w.sot * d["hst"] + w.off * (d["hs"] - d["hst"]).clip(lower=0)
                              + w.corner * d["hc"]})
    away = pd.DataFrame({"team": d["away"], "date": d["date"], "gf": d["ftag"],
                         "xg": w.sot * d["ast"] + w.off * (d["as"] - d["ast"]).clip(lower=0)
                              + w.corner * d["ac"]})
    log = pd.concat([home, away]).sort_values("date")
    g = log.groupby("team")
    # rolling PRIOR-10 mean (shift 1 to exclude current game)
    log["roll_gf"] = g["gf"].transform(lambda s: s.shift(1).rolling(10, min_periods=5).mean())
    log["roll_xg"] = g["xg"].transform(lambda s: s.shift(1).rolling(10, min_periods=5).mean())
    v = log.dropna(subset=["roll_gf", "roll_xg"])
    c_goals = float(np.corrcoef(v["roll_gf"], v["gf"])[0, 1])
    c_xg = float(np.corrcoef(v["roll_xg"], v["gf"])[0, 1])
    verdict = ("proxy-xG is the better predictor — keep it as the scoring-form feature"
               if c_xg >= c_goals else
               "rolling goals edge it here — worth blending, not replacing")
    return "\n".join([
        "## D. Proxy-xG validation", "",
        f"- Fitted conversion weights: shot-on-target **{w.sot:.3f}**, off-target "
        f"{w.off:.3f}, corner **{w.corner:.3f}** goals each (fit R²={w.r2:.3f}).",
        f"- Predicting a team's goals in a match from their PRIOR-10 rolling form "
        f"({len(v):,} innings):",
        f"  - rolling **actual goals** → next goals: corr **{c_goals:.3f}**",
        f"  - rolling **proxy-xG**     → next goals: corr **{c_xg:.3f}**",
        f"- Verdict: {verdict}.",
    ])


def main():
    df = load()
    parts = [
        "# EVE Engine — ML Audit",
        f"_Corpus: {len(df):,} matches, {df['date'].min().date()} → "
        f"{df['date'].max().date()}._",
        "",
        section_coverage(df),
        "",
        section_continuity(df),
        "",
        section_calibration(df),
        "",
        section_proxy_xg(df),
    ]
    report = "\n".join(parts)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(report)
    print(report)
    print(f"\n\n(written to {REPORT})")


if __name__ == "__main__":
    main()
