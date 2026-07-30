#!/usr/bin/env python3
"""
ensemble/lambda_model.py — market-anchored expected-goals (λ) model.

WHY THIS EXISTS
───────────────
The audit proved a form-only classifier loses to the closing market
(prematch supermodel: -0.77pp CLV, -3.4% ROI) because it never *sees* the
price. This model fixes that: it predicts each team's expected goals λ with the
CLOSING-ODDS-IMPLIED STRENGTH as the anchor feature, then nudges λ with Elo,
rolling form and proxy-xG. Monte Carlo (monte_carlo.py) turns (λ_home, λ_away)
into every market price.

The edge it targets (from the audit): the favourite–longshot bias and the soft
non-big-5 leagues — not out-forecasting Pinnacle everywhere.

INTEGRITY
─────────
  • Walk-forward: Elo + rolling form built chronologically; every feature is
    strictly PRE-match. Closing odds are pre-kickoff, so legitimate.
  • Chronological split (train < 2019-07-01 ≤ test) — no random shuffle.
  • League target-stats computed on TRAIN ONLY, then applied to test.
  • Trains/tests only on matches that HAVE closing odds (the bettable universe).

Poisson gradient boosting predicts λ_home and λ_away. Evaluation compares the
model to the market baseline on calibration, log-loss and value-betting ROI/CLV.
"""
from __future__ import annotations

from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb

from expected_goals import fit_weights
from monte_carlo import score_matrix, markets_from_matrix
from scrapers.names import key as club_key

CACHE = Path(__file__).parent / "models" / "_csv_cache_v3.csv.gz"
SQUAD_CSV = Path(__file__).parent / "data" / "external" / "squad_values.csv"
SPLIT = pd.Timestamp("2019-07-01", tz="UTC")
ELO_K, ELO_HOME_ADV, ELO_DEFAULT = 20.0, 60.0, 1500.0
FORM_N = 10

FEATURES = [
    "m_home", "m_draw", "m_away",          # market anchor (overround-removed)
    "elo_home", "elo_away", "elo_diff",
    "h_gf", "h_ga", "a_gf", "a_ga",        # rolling goals for/against (prior-N)
    "h_xg", "a_xg", "has_xg",              # rolling proxy-xG (fallback to goals)
    "lg_home_gf", "lg_away_gf", "lg_draw", # league target-stats (train-only)
    "sv_home", "sv_away", "sv_diff", "sv_has",  # Transfermarkt squad value (log €)
]


def _season_start(ts) -> int:
    """European season start year for a match date (Aug→next May)."""
    return ts.year if ts.month >= 7 else ts.year - 1


def load_squad_values(path=SQUAD_CSV):
    """(league, season_start, tm_club_key) → log10(squad value €), and the set
    of Transfermarkt club keys per league (for name resolution)."""
    if not path.exists():
        return {}, {}
    sv = pd.read_csv(path)
    out, tm_keys = {}, defaultdict(set)
    for r in sv.itertuples(index=False):
        v = float(r.squad_value_eur)
        if v > 0:
            k = club_key(r.club)
            out[(r.league, int(r.season_start), k)] = np.log10(v)
            tm_keys[r.league].add(k)
    return out, dict(tm_keys)


def resolve_names(corpus_keys_by_league, tm_keys, floor=0.84):
    """Map each corpus club key → best Transfermarkt key in the same league.

    football-data uses SHORT names ("Newcastle", "West Ham") where Transfermarkt
    uses FULL names ("Newcastle United", "West Ham United"), so the corpus key is
    a PREFIX of the TM key and scores low on pure fuzzy. Resolution order:
      1. exact key
      2. prefix/containment (one side startswith the other) — unique → take it,
         several → best fuzzy among them
      3. difflib fuzzy over the whole league above `floor`
    Done once per league, not per row.
    """
    from difflib import SequenceMatcher
    resolve = {}
    for lg, cset in corpus_keys_by_league.items():
        tmset = tm_keys.get(lg, set())
        if not tmset:
            continue
        for ck in cset:
            if ck in tmset:
                resolve[(lg, ck)] = ck
                continue
            cands = [tk for tk in tmset
                     if len(ck) >= 4 and (tk.startswith(ck) or ck.startswith(tk))]
            if len(cands) == 1:
                resolve[(lg, ck)] = cands[0]
                continue
            pool = cands if cands else tmset
            best, bs = None, 0.0
            for tk in pool:
                s = SequenceMatcher(None, ck, tk).ratio()
                if s > bs:
                    best, bs = tk, s
            if cands or bs >= floor:
                resolve[(lg, ck)] = best
    return resolve


def _implied(psh, psd, psa):
    inv = np.array([1 / psh, 1 / psd, 1 / psa])
    return inv / inv.sum()


def build_features(df: pd.DataFrame, xw, squad=None, resolve=None, anchor="close") -> pd.DataFrame:
    """Chronological walk-forward → one pre-match feature row per odds match."""
    squad = squad or {}
    resolve = resolve or {}
    sv_fallback = float(np.median(list(squad.values()))) if squad else 7.5
    df = df.sort_values("date").reset_index(drop=True)
    elo = defaultdict(lambda: ELO_DEFAULT)
    gf = defaultdict(lambda: deque(maxlen=FORM_N))
    ga = defaultdict(lambda: deque(maxlen=FORM_N))
    xgf = defaultdict(lambda: deque(maxlen=FORM_N))
    rows = []

    def mean(d, fb):
        return float(np.mean(d)) if len(d) else fb

    for m in df.itertuples(index=False):
        h, a = m.home, m.away
        eh, ea = elo[h], elo[a]
        # proxy-xG for this match (if shots present) — used to UPDATE after
        hx = ax = np.nan
        if not pd.isna(m.hst) and not pd.isna(m.hs):
            hx = xw.sot * m.hst + xw.off * max((m.hs - m.hst), 0) + xw.corner * (m.hc if not pd.isna(m.hc) else 0)
        if not pd.isna(m.ast) and not pd.isna(m.ashots):
            ax = xw.sot * m.ast + xw.off * max((m.ashots - m.ast), 0) + xw.corner * (m.ac if not pd.isna(m.ac) else 0)

        # Market anchor: 'close' = Pinnacle closing (default, for the close-priced
        # model); 'open' = market-average OPENING, so the CLV test can't cheat by
        # feeding the model the very line it's later benchmarked against.
        if anchor == "open":
            ok = not (pd.isna(m.oh) or pd.isna(m.od) or pd.isna(m.oa))
            mp = _implied(m.oh, m.od, m.oa) if ok else (0, 0, 0)
        else:
            ok = not (pd.isna(m.psh) or pd.isna(m.psd) or pd.isna(m.psa))
            mp = _implied(m.psh, m.psd, m.psa) if ok else (0, 0, 0)
        if ok:
            h_gf, a_gf = mean(gf[h], 1.35), mean(gf[a], 1.15)
            h_xg = mean(xgf[h], h_gf)
            a_xg = mean(xgf[a], a_gf)
            ss = _season_start(m.date)
            hk = resolve.get((m.league, club_key(h)), club_key(h))
            ak = resolve.get((m.league, club_key(a)), club_key(a))
            svh = squad.get((m.league, ss, hk))
            sva = squad.get((m.league, ss, ak))
            has_sv = 1.0 if (svh is not None and sva is not None) else 0.0
            rows.append({
                "date": m.date, "league": m.league, "home": h, "away": a,
                "fthg": m.fthg, "ftag": m.ftag, "ftr": m.ftr,
                "psh": m.psh, "psd": m.psd, "psa": m.psa,
                "maxh": m.maxh, "maxd": m.maxd, "maxa": m.maxa,
                "b365h": m.b365h, "b365d": m.b365d, "b365a": m.b365a,
                "o25": m.o25, "u25": m.u25,
                "oh": m.oh, "od": m.od, "oa": m.oa,   # opening avg 1X2
                "ch": m.ch, "cd": m.cd, "ca": m.ca,   # closing avg 1X2 (for CLV)
                "m_home": mp[0], "m_draw": mp[1], "m_away": mp[2],
                "elo_home": eh, "elo_away": ea, "elo_diff": eh - ea,
                "h_gf": h_gf, "h_ga": mean(ga[h], 1.15),
                "a_gf": a_gf, "a_ga": mean(ga[a], 1.35),
                "h_xg": h_xg, "a_xg": a_xg,
                "has_xg": 1.0 if len(xgf[h]) and len(xgf[a]) else 0.0,
                "sv_home": svh if svh is not None else sv_fallback,
                "sv_away": sva if sva is not None else sv_fallback,
                "sv_diff": (svh - sva) if has_sv else 0.0,
                "sv_has": has_sv,
            })

        # ── update state AFTER emitting (no leakage) ──
        exp_h = 1 / (1 + 10 ** (-((eh + ELO_HOME_ADV) - ea) / 400))
        res_h = 1.0 if m.ftr == "H" else (0.5 if m.ftr == "D" else 0.0)
        elo[h] = eh + ELO_K * (res_h - exp_h)
        elo[a] = ea + ELO_K * ((1 - res_h) - (1 - exp_h))
        gf[h].append(m.fthg); ga[h].append(m.ftag)
        gf[a].append(m.ftag); ga[a].append(m.fthg)
        if not pd.isna(hx): xgf[h].append(hx)
        if not pd.isna(ax): xgf[a].append(ax)

    return pd.DataFrame(rows)


def add_league_stats(feat: pd.DataFrame, train_mask) -> pd.DataFrame:
    """League target-stats from TRAIN only (no leakage), applied everywhere."""
    tr = feat[train_mask]
    g = tr.groupby("league")
    home_gf = g["fthg"].mean()
    away_gf = g["ftag"].mean()
    draw = tr.assign(d=(tr.ftr == "D").astype(float)).groupby("league")["d"].mean()
    gmean_h, gmean_a, gmean_d = tr.fthg.mean(), tr.ftag.mean(), (tr.ftr == "D").mean()
    feat["lg_home_gf"] = feat["league"].map(home_gf).fillna(gmean_h)
    feat["lg_away_gf"] = feat["league"].map(away_gf).fillna(gmean_a)
    feat["lg_draw"] = feat["league"].map(draw).fillna(gmean_d)
    return feat


def fit_predict(anchor="close"):
    """Train the λ-model and predict on the chronological test set.
    Returns (te, lh, la): the test frame + predicted home/away expected goals.
    Shared by evaluate() and backtest.py so both use identical, leak-free preds.
    """
    print("Loading corpus …")
    df = pd.read_csv(CACHE, low_memory=False)
    df["date"] = pd.to_datetime(df["date"], utc=True, errors="coerce")
    for c in ["fthg", "ftag", "hst", "ast", "hs", "as", "hc", "ac",
              "psh", "psd", "psa", "maxh", "maxd", "maxa"]:
        df[c] = pd.to_numeric(df.get(c), errors="coerce")
    df = df.dropna(subset=["fthg", "ftag", "date"])
    xw = fit_weights(df)                        # needs the original 'as' column
    print(f"proxy-xG weights: sot={xw.sot:.3f} off={xw.off:.3f} corner={xw.corner:.3f}")

    squad, tm_keys = load_squad_values()
    print(f"squad-value rows: {len(squad):,} across {len(tm_keys)} leagues"
          if squad else "squad-value file absent")
    corpus_keys = (df.assign(k=df["home"].map(club_key))
                     .groupby("league")["k"].apply(set).to_dict()) if squad else {}
    resolve = resolve_names(corpus_keys, tm_keys) if squad else {}

    print("Walk-forward feature build …")
    # 'as' is a Python keyword → unusable via itertuples attribute access; rename now.
    feat = build_features(df.rename(columns={"as": "ashots"}), xw, squad, resolve, anchor=anchor)
    cov = feat["sv_has"].mean()
    print(f"  squad-value coverage on odds matches: {100*cov:.0f}%")
    train_mask = feat["date"] < SPLIT
    feat = add_league_stats(feat, train_mask)
    tr, te = feat[train_mask], feat[~train_mask]
    print(f"  train {len(tr):,} (odds matches < 2019-07)   test {len(te):,} (≥ 2019-07)")

    Xtr = tr[FEATURES].to_numpy(np.float32)
    Xte = te[FEATURES].to_numpy(np.float32)
    params = dict(objective="count:poisson", max_depth=4, learning_rate=0.05,
                  n_estimators=500, subsample=0.8, colsample_bytree=0.8,
                  reg_alpha=0.5, reg_lambda=2.0, min_child_weight=5,
                  random_state=42, n_jobs=-1)
    print("Training λ_home …");  mh = xgb.XGBRegressor(**params).fit(Xtr, tr["fthg"])
    print("Training λ_away …");  ma = xgb.XGBRegressor(**params).fit(Xtr, tr["ftag"])
    lh = np.clip(mh.predict(Xte), 0.05, 6.0)
    la = np.clip(ma.predict(Xte), 0.05, 6.0)
    return te.reset_index(drop=True), lh, la


def train_and_eval():
    te, lh, la = fit_predict()
    evaluate(te, lh, la)


def evaluate(te, lh, la):
    n = len(te)
    p_home = np.zeros(n); p_draw = np.zeros(n); p_away = np.zeros(n); p_over = np.zeros(n)
    for i in range(n):
        M = score_matrix(lh[i], la[i])
        mk = markets_from_matrix(M)
        p_home[i], p_draw[i], p_away[i] = mk["1x2"]["home"], mk["1x2"]["draw"], mk["1x2"]["away"]
        p_over[i] = mk["over_under"]["over_2.5"]

    occ_h = (te.ftr == "H").to_numpy(int)
    occ_d = (te.ftr == "D").to_numpy(int)
    occ_a = (te.ftr == "A").to_numpy(int)

    def ece_ll(ph, pd_, pa):
        preds = np.concatenate([ph, pd_, pa])
        occ = np.concatenate([occ_h, occ_d, occ_a])
        bins = np.linspace(0, 1, 11); idx = np.clip(np.digitize(preds, bins) - 1, 0, 9)
        ece = sum(abs(preds[idx == b].mean() - occ[idx == b].mean()) * (idx == b).mean()
                  for b in range(10) if (idx == b).any())
        ll = -np.mean(occ * np.log(np.clip(preds, 1e-9, 1)) +
                      (1 - occ) * np.log(np.clip(1 - preds, 1e-9, 1)))
        return ece, ll

    # market baseline (overround-removed closing)
    mh_, md_, ma_ = te.m_home.to_numpy(), te.m_draw.to_numpy(), te.m_away.to_numpy()
    e_mkt, ll_mkt = ece_ll(mh_, md_, ma_)
    e_mod, ll_mod = ece_ll(p_home, p_draw, p_away)

    print("\n" + "=" * 66)
    print("λ-MODEL EVALUATION (chronological test, ≥ 2019-07)")
    print("=" * 66)
    print(f"{'':22s}{'ECE':>10s}{'log-loss':>12s}")
    print(f"{'Market (Pinnacle)':22s}{e_mkt:>10.4f}{ll_mkt:>12.4f}")
    print(f"{'λ-model':22s}{e_mod:>10.4f}{ll_mod:>12.4f}")

    # Value betting at BEST available price (Max), CLV benchmark = Pinnacle close.
    best = {"H": te.maxh.to_numpy(), "D": te.maxd.to_numpy(), "A": te.maxa.to_numpy()}
    pin = {"H": te.psh.to_numpy(), "D": te.psd.to_numpy(), "A": te.psa.to_numpy()}
    pmod = {"H": p_home, "D": p_draw, "A": p_away}
    for thr in (0.0, 0.03, 0.05):
        bets = pnl = clv = nclv = staked = 0
        wins = 0
        for oc in ("H", "D", "A"):
            odds = best[oc]; p = pmod[oc]; occ = (te.ftr == oc).to_numpy(int)
            edge = p * odds - 1
            take = np.where((edge > thr) & ~np.isnan(odds))[0]
            for i in take:
                bets += 1; staked += 1
                pnl += (odds[i] - 1) if occ[i] else -1
                wins += occ[i]
                if not np.isnan(pin[oc][i]) and pin[oc][i] > 0:
                    clv += np.log(odds[i] / pin[oc][i]); nclv += 1
        if bets:
            print(f"\nMin edge {int(thr*100)}%:  bets={bets:,}  ROI={100*pnl/staked:+.2f}%  "
                  f"win%={100*wins/bets:.1f}  meanCLV={100*clv/max(nclv,1):+.2f}pp")
    print("\n(baseline to beat: old form model was CLV -0.77pp, ROI -3.4%)")

    # ── Per-outcome flat-bet helper on the 1X2 book at best price ──────────────
    def bet_1x2(mask, thr=0.03):
        bets = pnl = wins = 0
        for oc, p in (("H", p_home), ("D", p_draw), ("A", p_away)):
            odds = best[oc]; occ = (te.ftr == oc).to_numpy(int)
            edge = p * odds - 1
            take = np.where(mask & (edge > thr) & ~np.isnan(odds))[0]
            for i in take:
                bets += 1; pnl += (odds[i] - 1) if occ[i] else -1; wins += occ[i]
        return bets, pnl

    # ── Where is it profitable? Per-league 1X2 ROI @ edge≥3% ──────────────────
    print("\n" + "-" * 66)
    print("PER-LEAGUE 1X2 value (bet best price, edge ≥ 3%, min 200 bets):")
    rows = []
    for lg in te["league"].unique():
        b, pl = bet_1x2((te["league"] == lg).to_numpy(), 0.03)
        if b >= 200:
            rows.append((lg, b, 100 * pl / b))
    rows.sort(key=lambda r: r[2], reverse=True)
    print(f"  {'league':28s}{'bets':>7s}{'ROI%':>9s}")
    for lg, b, roi in rows[:8]:
        print(f"  {lg:28s}{b:>7,}{roi:>+9.2f}   ▲")
    for lg, b, roi in rows[-5:]:
        print(f"  {lg:28s}{b:>7,}{roi:>+9.2f}")

    # ── Favourite–longshot: ROI of model bets by the outcome's market prob ─────
    print("\nFAVOURITE–LONGSHOT edge (model 1X2 bets @ edge≥3%, by market prob):")
    mp = {"H": te.m_home.to_numpy(), "D": te.m_draw.to_numpy(), "A": te.m_away.to_numpy()}
    seg = {"longshot (p<0.25)": (0, .25), "mid (0.25-0.5)": (.25, .5), "fav (p>0.5)": (.5, 1.01)}
    for name, (lo, hi) in seg.items():
        bets = pnl = wins = 0
        for oc, p in (("H", p_home), ("D", p_draw), ("A", p_away)):
            odds = best[oc]; occ = (te.ftr == oc).to_numpy(int); mpr = mp[oc]
            edge = p * odds - 1
            take = np.where((edge > .03) & ~np.isnan(odds) & (mpr >= lo) & (mpr < hi))[0]
            for i in take:
                bets += 1; pnl += (odds[i] - 1) if occ[i] else -1; wins += occ[i]
        if bets:
            print(f"  {name:20s} bets={bets:>7,}  ROI={100*pnl/bets:+6.2f}%  win%={100*wins/bets:4.1f}")

    # ── Over/Under 2.5 goals value (model prices totals natively via MC) ───────
    ou = te.dropna(subset=["o25", "u25"]).index.to_numpy()
    if len(ou):
        o = te.o25.to_numpy(); u = te.u25.to_numpy()
        occ_o = ((te.fthg + te.ftag) > 2.5).to_numpy(int)
        for thr in (0.0, 0.03, 0.05):
            bets = pnl = 0
            for i in ou:
                eo, eu = p_over[i] * o[i] - 1, (1 - p_over[i]) * u[i] - 1
                if max(eo, eu) <= thr:
                    continue
                bets += 1
                if eo >= eu:
                    pnl += (o[i] - 1) if occ_o[i] else -1
                else:
                    pnl += (u[i] - 1) if not occ_o[i] else -1
            if bets:
                print(f"\nOver/Under 2.5 @ edge {int(thr*100)}%:  bets={bets:,}  "
                      f"ROI={100*pnl/bets:+.2f}%  (coverage {len(ou):,} matches)")


if __name__ == "__main__":
    train_and_eval()
