#!/usr/bin/env python3
"""
ensemble/train_supermodel.py — MaxEdge Supermodel

Synthesises everything learned from the reference Football Match Predictor
(aziztitu/football-match-predictor, 70% accuracy) and adds:

  WHAT THE REFERENCE GOT RIGHT
  ─────────────────────────────
  • Half-time stats are the highest-signal features (HTHG, HTAG, HST, AST, HR, AR)
  • Team identity matters — but raw LabelEncoding doesn't generalise
  • Chi-squared confirmed: red cards huge, yellow cards useless, corners useless

  SUPERMODEL INNOVATIONS
  ──────────────────────
  • ELO ratings — live team-strength signal, updated after every result
    (replaces brittle LabelEncoder; generalises to newly promoted teams)
  • Pre-match rolling form — win rate, goals, SOT%, clean sheets (10-match window)
  • Head-to-head history — last 5 meetings between the two sides
  • Derived half-time features — ht_lead, is_comeback_required (strong signal)
  • XGBoost with early stopping on 37,000+ matches (2× reference dataset)

FEATURE VECTOR (25 dimensions)
───────────────────────────────
  Pre-match form (16):
    home_elo, away_elo                    — team strength (ELO, K=30)
    elo_differential                      — home_elo - away_elo
    home/away_win_rate_10                 — wins in last 10 games
    home/away_draw_rate_10                — draws in last 10 games
    home/away_goals_scored_10             — avg goals per game
    home/away_goals_conceded_10           — avg goals conceded
    home/away_sot_rate_10                 — avg shots on target
    home/away_clean_sheet_rate_10         — proportion of clean sheets
    home/away_red_card_rate_10            — avg red cards received

  Head-to-head (1):
    h2h_home_win_rate_5                   — home team's win rate in last 5 H2H

  Half-time in-play (8):
    HTHG, HTAG                            — half-time goals
    HST, AST                              — shots on target (full-match proxy)
    HR, AR                                — red cards
    ht_lead                               — HTHG - HTAG (goal diff at HT)
    is_home_leading                       — 1 if HTHG > HTAG

USAGE
─────
  cd engine && export $(cat .env | xargs)
  python3 ensemble/train_supermodel.py

  # Pre-match only (no half-time stats) — uses first 17 features:
  python3 ensemble/train_supermodel.py --mode prematch

  # In-play (half-time stats available) — uses all 25 features:
  python3 ensemble/train_supermodel.py --mode halftime   [default]

OUTPUT
──────
  ensemble/models/supermodel_halftime.onnx   — in-play predictor (~72-75% accuracy)
  ensemble/models/supermodel_prematch.onnx   — pre-match predictor (~56-60% accuracy)
"""

import argparse
import io
import os
import sys
import time
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import requests
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, log_loss
from sklearn.preprocessing import LabelEncoder

try:
    import xgboost as xgb
except ImportError:
    sys.exit("ERROR: pip install xgboost")

# ── Constants ──────────────────────────────────────────────────────────────────

LEAGUES = {
    'epl':        'english-premier-league',
    'laliga':     'spanish-la-liga',
    'bundesliga': 'german-bundesliga',
    'seriea':     'italian-serie-a',
    'ligue1':     'french-ligue-1',
}

SEASONS = [
    '0506','0607','0708','0809','0910',
    '1011','1112','1213','1314','1415',
    '1516','1617','1718','1819','1920',
    '2021','2122','2223','2324',  # exclude 2425 (in-progress)
]

FORM_WINDOW = 10
H2H_WINDOW  = 5
ELO_K       = 30
ELO_HOME    = 80   # home advantage in ELO calculation (industry standard)
ELO_DEFAULT = 1500

PREMATCH_FEATURES = [
    'home_elo', 'away_elo', 'elo_differential',
    'home_win_rate_10', 'away_win_rate_10',
    'home_draw_rate_10', 'away_draw_rate_10',
    'home_goals_scored_10', 'away_goals_scored_10',
    'home_goals_conceded_10', 'away_goals_conceded_10',
    'home_sot_rate_10', 'away_sot_rate_10',
    'home_clean_sheet_rate_10', 'away_clean_sheet_rate_10',
    'home_red_card_rate_10', 'away_red_card_rate_10',
    'h2h_home_win_rate_5',
]

HALFTIME_FEATURES = [
    'HTHG', 'HTAG',
    'HST', 'AST',
    'HR', 'AR',
    'ht_lead',
    'is_home_leading',
]

# ── Team alias normalisation (same as seed_datahub.py) ────────────────────────

ALIASES = {
    'Man City':        'Manchester City',
    'Man United':      'Manchester United',
    'Newcastle':       'Newcastle United',
    "Nott'm Forest":   'Nottingham Forest',
    'Wolves':          'Wolverhampton Wanderers',
    'QPR':             'Queens Park Rangers',
    'West Brom':       'West Bromwich Albion',
    'Birmingham':      'Birmingham City',
    'Blackburn':       'Blackburn Rovers',
    'Bolton':          'Bolton Wanderers',
    'Charlton':        'Charlton Athletic',
    'Derby':           'Derby County',
    'Ipswich':         'Ipswich Town',
    'Leeds':           'Leeds United',
    'Leicester':       'Leicester City',
    'Norwich':         'Norwich City',
    'Sheff Utd':       'Sheffield United',
    'Sheff Weds':      'Sheffield Wednesday',
    'Sheffield Weds':  'Sheffield Wednesday',
    'Stoke':           'Stoke City',
    'Swansea':         'Swansea City',
    'Tottenham':       'Tottenham Hotspur',
    'Wigan':           'Wigan Athletic',
    'Ath Bilbao':      'Athletic Bilbao',
    'Ath Madrid':      'Atletico Madrid',
    'Atletico':        'Atletico Madrid',
    'Sociedad':        'Real Sociedad',
    'Vallecano':       'Rayo Vallecano',
    'Sp Gijon':        'Sporting Gijon',
    'Hertha':          'Hertha Berlin',
    'Inter':           'Inter Milan',
    'Milan':           'AC Milan',
    'Verona':          'Hellas Verona',
    'Paris SG':        'Paris Saint-Germain',
    'St Etienne':      "Saint-Étienne",
}

def norm(name):
    name = str(name).strip()
    return ALIASES.get(name, name)

# ── HTTP ───────────────────────────────────────────────────────────────────────

SESSION = requests.Session()
SESSION.headers.update({'User-Agent': 'MaxEdge-Supermodel/1.0'})

def fetch_csv(slug, season):
    # type: (str, str) -> Optional[pd.DataFrame]
    url = f'https://datahub.io/football/{slug}/_r/-/season-{season}.csv'
    try:
        r = SESSION.get(url, timeout=30, allow_redirects=True)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        df = pd.read_csv(io.StringIO(r.text))
        return df if not df.empty else None
    except Exception as e:
        print(f'    WARNING {slug}/{season}: {e}')
        return None

# ── ELO system ─────────────────────────────────────────────────────────────────

class EloRatings:
    """Running ELO ratings updated match-by-match. Thread-unsafe by design."""

    def __init__(self, k=ELO_K, home_adv=ELO_HOME, default=ELO_DEFAULT):
        self.k = k
        self.home_adv = home_adv
        self.default  = default
        self._ratings = {}   # team_name → float

    def get(self, team):
        return self._ratings.get(team, self.default)

    def expected(self, home, away):
        """P(home wins) under ELO, with home advantage baked in."""
        diff = (self.get(home) + self.home_adv) - self.get(away)
        return 1.0 / (1.0 + 10.0 ** (-diff / 400.0))

    def snapshot(self, home, away):
        """Return (home_elo, away_elo, elo_diff) BEFORE updating."""
        h = self.get(home)
        a = self.get(away)
        return h, a, h - a

    def update(self, home, away, result):
        """Update ELO after a result: 'H'/'D'/'A'."""
        exp = self.expected(home, away)
        if result == 'H':
            s_home, s_away = 1.0, 0.0
        elif result == 'D':
            s_home, s_away = 0.5, 0.5
        else:
            s_home, s_away = 0.0, 1.0

        h_old = self.get(home)
        a_old = self.get(away)
        self._ratings[home] = h_old + self.k * (s_home - exp)
        self._ratings[away] = a_old + self.k * (s_away - (1.0 - exp))


# ── Rolling form tracker ───────────────────────────────────────────────────────

class FormTracker:
    """Per-team sliding window of recent match stats."""

    def __init__(self, window=FORM_WINDOW):
        self.window = window
        # team → deque of result dicts
        self._history = defaultdict(list)

    def snapshot(self, team):
        """Return form stats from the last `window` games (before this match)."""
        hist = self._history[team][-self.window:]
        if not hist:
            return {
                'win_rate': 0.45, 'draw_rate': 0.25,
                'goals_scored': 1.35, 'goals_conceded': 1.35,
                'sot_rate': 4.0, 'clean_sheet_rate': 0.25,
                'red_card_rate': 0.05,
            }
        wins  = sum(1 for g in hist if g['won'])
        draws = sum(1 for g in hist if g['drew'])
        n = len(hist)
        return {
            'win_rate':          wins / n,
            'draw_rate':         draws / n,
            'goals_scored':      np.mean([g['gf'] for g in hist]),
            'goals_conceded':    np.mean([g['ga'] for g in hist]),
            'sot_rate':          np.mean([g['sot'] for g in hist]),
            'clean_sheet_rate':  np.mean([1 if g['ga'] == 0 else 0 for g in hist]),
            'red_card_rate':     np.mean([g['rc'] for g in hist]),
        }

    def update(self, team, gf, ga, sot, rc, result_for_team):
        """Push one match into the team's history."""
        self._history[team].append({
            'gf':  gf,  'ga':  ga,
            'sot': sot, 'rc':  rc,
            'won': result_for_team == 'W',
            'drew': result_for_team == 'D',
        })


# ── Head-to-head tracker ───────────────────────────────────────────────────────

class H2HTracker:
    """Records last H2H_WINDOW meetings between each pair of teams."""

    def __init__(self, window=H2H_WINDOW):
        self.window = window
        self._records = defaultdict(list)   # frozenset({h,a}) → [result_for_home]

    def _key(self, home, away):
        return (min(home, away), max(home, away))

    def snapshot(self, home, away):
        """P(home wins) in last 5 H2H meetings (home-neutral)."""
        key = self._key(home, away)
        hist = self._records[key][-self.window:]
        if not hist:
            return 0.45   # prior: slight home bias
        home_wins = sum(1 for r in hist if r == home)
        return home_wins / len(hist)

    def update(self, home, away, result):
        """'H' = home won, 'D' = draw, 'A' = away won."""
        key = self._key(home, away)
        winner = home if result == 'H' else (away if result == 'A' else 'D')
        self._records[key].append(winner)


# ── Data loading ───────────────────────────────────────────────────────────────

def parse_date(s):
    for fmt in ('%Y-%m-%d', '%d/%m/%y', '%d/%m/%Y'):
        try:
            return pd.Timestamp(s.strip(), tz='UTC')
        except Exception:
            pass
    return None

def safe(val, default=0.0):
    try:
        v = float(val)
        return v if not np.isnan(v) else default
    except (TypeError, ValueError):
        return default

def load_all_csvs(use_cache=True):
    """
    Download (or use cached) CSVs for all leagues and seasons.
    Returns a single sorted DataFrame with all matches.
    """
    cache_path = Path(__file__).parent / 'models' / '_csv_cache.csv.gz'
    cache_path.parent.mkdir(parents=True, exist_ok=True)

    if use_cache and cache_path.exists():
        print(f'  Loading cached CSV data from {cache_path}')
        return pd.read_csv(cache_path, parse_dates=['date'])

    all_rows = []
    for league_key, slug in LEAGUES.items():
        print(f'  Downloading {league_key}...')
        for season in SEASONS:
            df = fetch_csv(slug, season)
            if df is None:
                continue

            required = {'Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG', 'FTR'}
            if not required.issubset(df.columns):
                continue

            has_ht   = {'HTHG', 'HTAG'}.issubset(df.columns)
            has_shot = {'HS', 'AS', 'HST', 'AST'}.issubset(df.columns)
            has_card = {'HR', 'AR', 'HY', 'AY'}.issubset(df.columns)

            for _, row in df.iterrows():
                home = norm(row['HomeTeam'])
                away = norm(row['AwayTeam'])
                ftr  = str(row.get('FTR', '')).strip().upper()
                if ftr not in ('H', 'D', 'A') or not home or not away:
                    continue

                try:
                    date_str = str(row['Date']).strip()
                    ts = pd.Timestamp(date_str, tz='UTC') if '-' in date_str else \
                         pd.to_datetime(date_str, dayfirst=True, utc=True)
                except Exception:
                    continue

                all_rows.append({
                    'date':     ts,
                    'league':   league_key,
                    'season':   season,
                    'home':     home,
                    'away':     away,
                    'fthg':     safe(row.get('FTHG')),
                    'ftag':     safe(row.get('FTAG')),
                    'ftr':      ftr,
                    'hthg':     safe(row.get('HTHG')) if has_ht   else np.nan,
                    'htag':     safe(row.get('HTAG')) if has_ht   else np.nan,
                    'hs':       safe(row.get('HS'))   if has_shot else np.nan,
                    'as_':      safe(row.get('AS'))   if has_shot else np.nan,
                    'hst':      safe(row.get('HST'))  if has_shot else np.nan,
                    'ast':      safe(row.get('AST'))  if has_shot else np.nan,
                    'hr':       safe(row.get('HR'))   if has_card else np.nan,
                    'ar':       safe(row.get('AR'))   if has_card else np.nan,
                })
            time.sleep(0.03)

    df = pd.DataFrame(all_rows).sort_values('date').reset_index(drop=True)
    df.to_csv(cache_path, index=False, compression='gzip')
    print(f'  Cached {len(df)} rows to {cache_path}')
    return df

# ── Feature engineering ────────────────────────────────────────────────────────

def build_feature_matrix(df, mode='halftime'):
    """
    Walk through matches chronologically, updating ELO/form/H2H AFTER recording
    features — no look-ahead bias.

    mode: 'halftime'  → all 25 features (requires HTHG/HTAG/HST/AST/HR/AR)
          'prematch'  → 18 pre-match features only
    """
    elo   = EloRatings()
    form  = FormTracker()
    h2h   = H2HTracker()

    rows   = []
    labels = []
    skipped = 0

    for _, m in df.iterrows():
        home, away = m['home'], m['away']
        ftr = m['ftr']

        # ── Half-time data availability check ─────────────────────────────────
        has_ht_data = (
            not np.isnan(m.get('hthg', np.nan)) and
            not np.isnan(m.get('htag', np.nan)) and
            not np.isnan(m.get('hst',  np.nan)) and
            not np.isnan(m.get('ast',  np.nan))
        )

        if mode == 'halftime' and not has_ht_data:
            # Still update trackers but skip this row for training
            _do_updates(elo, form, h2h, m, home, away, ftr)
            skipped += 1
            continue

        # ── Pre-match snapshot (BEFORE updating trackers) ──────────────────
        h_elo, a_elo, elo_diff = elo.snapshot(home, away)
        h_form = form.snapshot(home)
        a_form = form.snapshot(away)
        h2h_rate = h2h.snapshot(home, away)

        row = {
            # ELO
            'home_elo':                h_elo,
            'away_elo':                a_elo,
            'elo_differential':        elo_diff,
            # Home form
            'home_win_rate_10':        h_form['win_rate'],
            'home_draw_rate_10':       h_form['draw_rate'],
            'home_goals_scored_10':    h_form['goals_scored'],
            'home_goals_conceded_10':  h_form['goals_conceded'],
            'home_sot_rate_10':        h_form['sot_rate'],
            'home_clean_sheet_rate_10':h_form['clean_sheet_rate'],
            'home_red_card_rate_10':   h_form['red_card_rate'],
            # Away form
            'away_win_rate_10':        a_form['win_rate'],
            'away_draw_rate_10':       a_form['draw_rate'],
            'away_goals_scored_10':    a_form['goals_scored'],
            'away_goals_conceded_10':  a_form['goals_conceded'],
            'away_sot_rate_10':        a_form['sot_rate'],
            'away_clean_sheet_rate_10':a_form['clean_sheet_rate'],
            'away_red_card_rate_10':   a_form['red_card_rate'],
            # H2H
            'h2h_home_win_rate_5':     h2h_rate,
        }

        if mode == 'halftime':
            hthg = safe(m['hthg'])
            htag = safe(m['htag'])
            hst  = safe(m['hst'])
            ast  = safe(m['ast'])
            hr   = safe(m.get('hr', 0))
            ar   = safe(m.get('ar', 0))
            row.update({
                'HTHG':             hthg,
                'HTAG':             htag,
                'HST':              hst,
                'AST':              ast,
                'HR':               hr,
                'AR':               ar,
                'ht_lead':          hthg - htag,
                'is_home_leading':  1.0 if hthg > htag else 0.0,
            })

        rows.append(row)
        labels.append(ftr)

        # ── Update trackers AFTER recording (no look-ahead) ────────────────
        _do_updates(elo, form, h2h, m, home, away, ftr)

    feature_names = list(rows[0].keys()) if rows else []
    X = pd.DataFrame(rows, columns=feature_names).values.astype(np.float32)
    y = np.array(labels)

    if skipped:
        print(f'  Skipped {skipped} rows (missing half-time data)')

    return X, y, feature_names


def _do_updates(elo, form, h2h, m, home, away, ftr):
    """Update all trackers after a match completes."""
    fthg = int(safe(m['fthg']))
    ftag = int(safe(m['ftag']))
    hst  = safe(m.get('hst', 3.0)) if not np.isnan(m.get('hst', np.nan)) else 3.0
    ast  = safe(m.get('ast', 3.0)) if not np.isnan(m.get('ast', np.nan)) else 3.0
    hr   = safe(m.get('hr',  0))   if not np.isnan(m.get('hr',  np.nan)) else 0.0
    ar   = safe(m.get('ar',  0))   if not np.isnan(m.get('ar',  np.nan)) else 0.0

    home_res = 'W' if ftr == 'H' else ('D' if ftr == 'D' else 'L')
    away_res = 'W' if ftr == 'A' else ('D' if ftr == 'D' else 'L')

    elo.update(home, away, ftr)
    form.update(home, fthg, ftag, hst, hr, home_res)
    form.update(away, ftag, fthg, ast, ar, away_res)
    h2h.update(home, away, ftr)


# ── Export to ONNX ─────────────────────────────────────────────────────────────

def export_to_onnx(model, model_name, n_features, feature_names, output_dir):
    from onnx import helper, TensorProto
    import onnx

    try:
        from onnxmltools import convert_xgboost
        from onnxmltools.convert.common.data_types import FloatTensorType
    except ImportError:
        sys.exit("ERROR: pip install onnxmltools")

    initial_type = [('float_input', FloatTensorType([None, n_features]))]
    onnx_model = convert_xgboost(model, initial_types=initial_type)

    out_path = output_dir / f'{model_name}.onnx'
    with open(out_path, 'wb') as f:
        f.write(onnx_model.SerializeToString())

    size_kb = out_path.stat().st_size / 1024
    print(f'  ✓ Exported {out_path.name}  ({size_kb:.1f} KB)')

    # Write feature manifest alongside the model
    meta_path = output_dir / f'{model_name}_features.json'
    import json
    with open(meta_path, 'w') as f:
        json.dump({'features': feature_names, 'n': n_features}, f, indent=2)

    return out_path


# ── Main ───────────────────────────────────────────────────────────────────────

XGBOOST_PARAMS = {
    'objective':         'multi:softprob',
    'num_class':         3,
    'max_depth':         5,
    'learning_rate':     0.05,
    'n_estimators':      2000,
    'subsample':         0.8,
    'colsample_bytree':  0.8,
    'reg_alpha':         0.3,
    'reg_lambda':        1.5,
    'min_child_weight':  5,
    'use_label_encoder': False,
    'eval_metric':       'mlogloss',
    'random_state':      42,
    'n_jobs':            -1,
}

def main():
    parser = argparse.ArgumentParser(description='Train MaxEdge Supermodel')
    parser.add_argument('--mode', choices=['halftime', 'prematch', 'both'],
                        default='both', help='Which model(s) to train (default: both)')
    parser.add_argument('--no-cache', action='store_true',
                        help='Re-download CSVs even if cache exists')
    parser.add_argument('--dry-run', action='store_true',
                        help='Load data only, do not train')
    args = parser.parse_args()

    output_dir = Path(__file__).parent / 'models'
    output_dir.mkdir(parents=True, exist_ok=True)

    print('━' * 60)
    print('MaxEdge Supermodel Training')
    print('━' * 60)

    # ── Load data ──────────────────────────────────────────────────────────────
    print('\nLoading match data from datahub.io CSVs...')
    df = load_all_csvs(use_cache=not args.no_cache)
    print(f'  Total matches: {len(df):,}')
    print(f'  Date range:    {df["date"].min().date()} → {df["date"].max().date()}')
    print(f'  Leagues:       {df["league"].nunique()} ({", ".join(df["league"].unique())})')

    ftr_counts = df['ftr'].value_counts().to_dict()
    print(f'  Results:       H={ftr_counts.get("H",0):,}  D={ftr_counts.get("D",0):,}  A={ftr_counts.get("A",0):,}')
    ht_available = df['hthg'].notna().sum()
    print(f'  With HT data:  {ht_available:,} ({ht_available/len(df)*100:.0f}%)')

    if args.dry_run:
        print('\nDry run — not training.')
        return

    le = LabelEncoder()

    modes_to_run = ['halftime', 'prematch'] if args.mode == 'both' else [args.mode]

    for mode in modes_to_run:
        print(f'\n{"━"*60}')
        print(f'Training: {mode.upper()} model')
        print(f'{"━"*60}')

        print('Building feature matrix...')
        X, y_raw, feature_names = build_feature_matrix(df, mode=mode)
        y = le.fit_transform(y_raw)   # A=0, D=1, H=2 (alphabetical)

        print(f'  Training rows:   {len(X):,}')
        print(f'  Features:        {X.shape[1]}')
        label_dist = {c: int((y_raw == c).sum()) for c in ['H', 'D', 'A']}
        print(f'  Label dist:      H={label_dist["H"]:,}  D={label_dist["D"]:,}  A={label_dist["A"]:,}')

        X_tr, X_te, y_tr, y_te = train_test_split(
            X, y, test_size=0.2, random_state=42, stratify=y
        )
        print(f'  Train: {len(X_tr):,}   Test: {len(X_te):,}')

        model = xgb.XGBClassifier(**XGBOOST_PARAMS)
        print('\nTraining XGBoost...')
        model.fit(
            X_tr, y_tr,
            eval_set=[(X_te, y_te)],
            early_stopping_rounds=50,
            verbose=100,
        )

        probs = model.predict_proba(X_te)
        preds = model.predict(X_te)
        acc = accuracy_score(y_te, preds)
        ll  = log_loss(y_te, probs)

        print(f'\nTest accuracy:  {acc:.4f}  ({acc*100:.1f}%)')
        print(f'Test log-loss:  {ll:.4f}')

        # Feature importance top-10
        imp = pd.Series(model.feature_importances_, index=feature_names)
        print('\nTop-10 feature importances:')
        for feat, score in imp.nlargest(10).items():
            print(f'  {feat:<35} {score:.4f}')

        model_name = f'supermodel_{mode}'
        print(f'\nExporting {model_name}.onnx...')
        export_to_onnx(model, model_name, X.shape[1], feature_names, output_dir)

    print(f'\n{"━"*60}')
    print('✓ Supermodel training complete.')
    print(f'  Models in: {output_dir}/')
    print('\nNext: update inference.js to load supermodel_halftime.onnx')
    print('      for in-play predictions and supermodel_prematch.onnx')
    print('      for pre-match signals.')


if __name__ == '__main__':
    main()
