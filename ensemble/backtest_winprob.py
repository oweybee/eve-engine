#!/usr/bin/env python3
"""
ensemble/backtest_winprob.py — Phase 3 backtest for the in-play win-probability
engine (lib/inplayWinProb.js), against real closing odds + half-time scores +
full-time results from football-data.co.uk (the same source train_supermodel_v2
uses).

Why here and not against the DB: the 37k completed matches in Supabase carry no
pre-match odds (they were seeded from fixture_predictions), and only ~17 tracked
matches have odds — far too few. football-data CSVs give closing odds AND
half-time scores AND FT results at scale, so this validates BOTH:

  1. Pre-match calibration — the λ recovered from the de-vigged closing 1X2
     should be as well-calibrated as the market itself (Brier / log-loss ≈).
  2. In-play calibration — liveWinProb(λ, half-time score, minute=45) vs the
     actual FT outcome, with a reliability curve. This is the genuine in-play
     check the DB can't provide.

The maths (poisson/invert/liveWinProb) is a direct port of lib/inplayWinProb.js
and is self-checked with `--selftest` (stdlib only, no data needed) so the port
is verified even where the data source is unreachable.

Run (CI, where football-data is reachable):  python3 ensemble/backtest_winprob.py
Verify maths only (anywhere):                 python3 ensemble/backtest_winprob.py --selftest
"""

import sys
import math

# ── Maths — ported verbatim from lib/inplayWinProb.js ────────────────────────
GRID_K = 12
REG_MINUTES = 90


def poisson_pmf_array(lam, k=GRID_K):
    L = max(0.0, lam)
    out = [0.0] * (k + 1)
    out[0] = math.exp(-L)
    for i in range(1, k + 1):
        out[i] = out[i - 1] * L / i
    return out


def outcome_probs_from_lambda(lh, la, k=GRID_K):
    ph, pa = poisson_pmf_array(lh, k), poisson_pmf_array(la, k)
    home = draw = away = 0.0
    for i in range(k + 1):
        for j in range(k + 1):
            p = ph[i] * pa[j]
            if i > j:
                home += p
            elif i == j:
                draw += p
            else:
                away += p
    s = home + draw + away
    return (home / s, draw / s, away / s) if s > 0 else (1 / 3, 1 / 3, 1 / 3)


def invert_consensus_to_lambda(p_home, p_draw, p_away):
    s = p_home + p_draw + p_away
    if not (s > 0):
        return 1.3, 1.1
    tH, tA = p_home / s, p_away / s
    loH, hiH, loA, hiA = 0.02, 6.0, 0.02, 6.0
    best = (float("inf"), 1.3, 1.1)
    N = 24
    for _ in range(5):
        stepH, stepA = (hiH - loH) / N, (hiA - loA) / N
        for a in range(N + 1):
            lh = loH + a * stepH
            for b in range(N + 1):
                la = loA + b * stepA
                oh, _od, oa = outcome_probs_from_lambda(lh, la)
                err = (oh - tH) ** 2 + (oa - tA) ** 2
                if err < best[0]:
                    best = (err, lh, la)
        _, blh, bla = best
        loH, hiH = max(0.01, blh - stepH), blh + stepH
        loA, hiA = max(0.01, bla - stepA), bla + stepA
    return best[1], best[2]


def time_left_fraction(minute):
    rem = REG_MINUTES - (minute or 0)
    if rem <= 0:
        return 0.0
    return min(1.0, rem / REG_MINUTES)


def live_win_prob(lh, la, home_goals, away_goals, minute):
    x, y = max(0, int(round(home_goals))), max(0, int(round(away_goals)))
    f = time_left_fraction(minute)
    ph, pa = poisson_pmf_array(lh * f), poisson_pmf_array(la * f)
    home = draw = away = 0.0
    for i in range(len(ph)):
        for j in range(len(pa)):
            p = ph[i] * pa[j]
            fh, fa = x + i, y + j
            if fh > fa:
                home += p
            elif fh == fa:
                draw += p
            else:
                away += p
    s = home + draw + away
    return (home / s, draw / s, away / s) if s > 0 else (0.0, 1.0, 0.0)


def devig(oh, od, oa):
    if not all(o and o > 1 for o in (oh, od, oa)):
        return None
    raw = [1 / oh, 1 / od, 1 / oa]
    s = sum(raw)
    return raw[0] / s, raw[1] / s, raw[2] / s


# ── Metrics ──────────────────────────────────────────────────────────────────
IDX = {"H": 0, "D": 1, "A": 2}


def brier(probs, result):
    y = [0.0, 0.0, 0.0]
    y[IDX[result]] = 1.0
    return sum((probs[k] - y[k]) ** 2 for k in range(3))


def logloss(probs, result):
    p = max(1e-12, probs[IDX[result]])
    return -math.log(p)


class Acc:
    def __init__(self):
        self.n = 0
        self.brier = 0.0
        self.ll = 0.0
        self.rel = [[0.0, 0] for _ in range(10)]  # home-prob reliability bins

    def add(self, probs, result):
        self.n += 1
        self.brier += brier(probs, result)
        self.ll += logloss(probs, result)
        b = min(9, int(probs[0] * 10))
        self.rel[b][0] += probs[0]
        self.rel[b][1] += 1 if result == "H" else 0

    def report(self, label):
        if not self.n:
            print(f"  {label}: no samples")
            return
        print(f"  {label}: n={self.n}  Brier={self.brier / self.n:.4f}  "
              f"LogLoss={self.ll / self.n:.4f}")
        print(f"    reliability (home-win prob → actual rate):")
        for b in range(10):
            pred_sum, cnt = self.rel[b]
            if cnt:
                print(f"      [{b/10:.1f},{(b+1)/10:.1f}) pred~{pred_sum/cnt:.2f} "
                      f"actual={self.rel[b][1]/cnt:.2f} n={cnt}")


# ── Self-test (stdlib only — verifies the port matches the JS unit tests) ─────
def selftest():
    ok = True

    def check(cond, msg):
        nonlocal ok
        print(("  ✓ " if cond else "  ✗ ") + msg)
        ok = ok and cond

    print("selftest: maths port vs lib/inplayWinProb.js")
    h, d, a = outcome_probs_from_lambda(1.3, 1.3)
    check(abs(h - a) < 1e-9, "equal λ → home==away")
    check(abs(h + d + a - 1) < 1e-9, "probs sum to 1")
    # inversion round-trip
    for lh, la in [(1.6, 1.1), (2.2, 0.7), (0.9, 1.9)]:
        o = outcome_probs_from_lambda(lh, la)
        ilh, ila = invert_consensus_to_lambda(*o)
        o2 = outcome_probs_from_lambda(ilh, ila)
        check(abs(o2[0] - o[0]) < 5e-3 and abs(o2[2] - o[2]) < 5e-3,
              f"invert round-trip λ=({lh},{la})")
    # boundary: KO equals pre-match
    pre = outcome_probs_from_lambda(1.7, 1.0)
    ko = live_win_prob(1.7, 1.0, 0, 0, 0)
    check(abs(ko[0] - pre[0]) < 1e-9, "minute 0 == pre-match")
    # full time decided
    ft = live_win_prob(1.5, 1.2, 2, 0, 90)
    check(abs(ft[0] - 1) < 1e-9, "FT 2-0 → home certain")
    # England scenario: λ2.2 vs 0.6, 0-1 at 40' → home ≈ 0.28
    eng = live_win_prob(2.2, 0.6, 0, 1, 40)
    check(0.24 < eng[0] < 0.33, f"favourite 0-1 at 40' home≈0.28 (got {eng[0]:.3f})")
    print("SELFTEST", "PASS" if ok else "FAIL")
    return 0 if ok else 1


# ── Data loader (football-data.co.uk) + backtest ─────────────────────────────
LEAGUES = {"epl": "E0", "laliga": "SP1", "bundesliga": "D1", "seriea": "I1", "ligue1": "F1"}
SEASONS = ["1516", "1617", "1718", "1819", "1920", "2021", "2122", "2223", "2324"]


def run_backtest():
    try:
        import pandas as pd
        import requests
    except ImportError:
        print("ERROR: pandas + requests required (available in CI). "
              "Use --selftest to verify the maths anywhere.")
        return 1

    session = requests.Session()
    session.headers.update({"User-Agent": "MaxEdge-WinProbBacktest/1.0"})

    pre_model, pre_market, ht_model = Acc(), Acc(), Acc()
    total = 0

    for div in LEAGUES.values():
        for season in SEASONS:
            url = f"https://www.football-data.co.uk/mmz4281/{season}/{div}.csv"
            try:
                r = session.get(url, timeout=30)
                if r.status_code != 200:
                    continue
                import io
                df = pd.read_csv(io.StringIO(r.text))
            except Exception as e:
                print(f"  skip {div}/{season}: {e}")
                continue

            need = {"FTR", "HTHG", "HTAG"}
            odds_cols = ("PSH", "PSD", "PSA") if "PSH" in df.columns else \
                        ("B365H", "B365D", "B365A") if "B365H" in df.columns else None
            if not need.issubset(df.columns) or odds_cols is None:
                continue

            for _, row in df.iterrows():
                ftr = str(row.get("FTR", "")).strip().upper()
                if ftr not in ("H", "D", "A"):
                    continue
                try:
                    oh, od, oa = float(row[odds_cols[0]]), float(row[odds_cols[1]]), float(row[odds_cols[2]])
                    hthg, htag = int(row["HTHG"]), int(row["HTAG"])
                except (TypeError, ValueError):
                    continue
                mkt = devig(oh, od, oa)
                if mkt is None:
                    continue
                lh, la = invert_consensus_to_lambda(*mkt)
                # 1. pre-match: model (λ) vs market (direct de-vig)
                pre_model.add(outcome_probs_from_lambda(lh, la), ftr)
                pre_market.add(mkt, ftr)
                # 2. in-play: win prob given the real half-time state
                ht_model.add(live_win_prob(lh, la, hthg, htag, 45), ftr)
                total += 1

    print(f"\nBacktest over {total} matches (closing odds + HT score + FT result)\n")
    print("PRE-MATCH calibration (λ-model should ≈ market):")
    pre_model.report("model (λ-derived)")
    pre_market.report("market (de-vig)")
    print("\nIN-PLAY calibration — win prob at the real half-time state:")
    ht_model.report("liveWinProb @ HT")
    print("\nGate: pre-match model Brier ≈ market Brier (inversion preserves "
          "calibration); HT reliability curve tracks the diagonal.")
    return 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else run_backtest())
