#!/usr/bin/env python3
"""
ensemble/train.py — ML Ensemble Training Pipeline
MaxEdge Value Detection Engine

Trains three specialized tabular classifiers:
  1. XGBoost  — Match Odds  (3-class: home / draw / away)
  2. LightGBM — BTTS        (binary: yes / no)
  3. LightGBM — Over/Under  (binary: over 2.5 / under 2.5)

All models are exported to ONNX format so inference.js can load them without
a Python runtime dependency on the production server.

DATA REQUIREMENTS:
  - Minimum ~300 completed fixtures with xG data per league to avoid overfit
  - Populated team_stats_cache rows (rolling 5 and 10-match windows)
  - Supabase credentials in environment

USAGE:
  python3 ensemble/train.py
  python3 ensemble/train.py --min-samples 500 --output-dir ensemble/models

ENVIRONMENT VARIABLES (same as engine runtime):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# ── Optional imports with clear error messages ────────────────────────────────
try:
    import xgboost as xgb
except ImportError:
    xgb = None

try:
    import lightgbm as lgb
except (ImportError, OSError):
    lgb = None

try:
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import log_loss, roc_auc_score, accuracy_score
    from sklearn.preprocessing import LabelEncoder
except ImportError:
    sys.exit("ERROR: scikit-learn not installed. Run: pip install scikit-learn")

try:
    from supabase import create_client
except ImportError:
    sys.exit("ERROR: supabase not installed. Run: pip install supabase")


# ── Constants ──────────────────────────────────────────────────────────────────

FEATURE_NAMES = [
    'home_xg_created_10', 'home_xg_conceded_10', 'home_ppda_10', 'home_sot_ratio_10',
    'home_goals_scored_10', 'home_goals_conceded_10',
    'home_xg_created_5',  'home_xg_conceded_5',  'home_ppda_5',  'home_sot_ratio_5',
    'away_xg_created_10', 'away_xg_conceded_10', 'away_ppda_10', 'away_sot_ratio_10',
    'away_goals_scored_10', 'away_goals_conceded_10',
    'away_xg_created_5',  'away_xg_conceded_5',  'away_ppda_5',  'away_sot_ratio_5',
    'rest_days_differential',
    'is_neutral_venue',
]

# League-wide baselines (mirrors features.js — kept in sync manually)
BASELINES = {
    'xg_created': 1.30, 'xg_conceded': 1.30, 'ppda_index': 9.50,
    'sot_ratio': 0.38, 'goals_scored': 1.35, 'goals_conceded': 1.35,
}

# XGBoost regularisation — tuned for short (<3 season) league histories
XGBOOST_PARAMS = {
    'objective':       'multi:softprob',
    'num_class':       3,
    'max_depth':       4,
    'learning_rate':   0.05,
    'n_estimators':    1000,
    'subsample':       0.7,
    'colsample_bytree': 0.7,
    'reg_alpha':       0.5,
    'reg_lambda':      2.0,
    'use_label_encoder': False,
    'eval_metric':     'mlogloss',
    'random_state':    42,
    'n_jobs':          -1,
}

LIGHTGBM_PARAMS = {
    'objective':      'binary',
    'max_depth':      5,
    'learning_rate':  0.05,
    'n_estimators':   500,
    'num_leaves':     31,
    'subsample':      0.8,
    'colsample_bytree': 0.8,
    'reg_alpha':      0.1,
    'reg_lambda':     1.0,
    'random_state':   42,
    'n_jobs':         -1,
    'verbose':        -1,
}

# XGBoost binary classifier used when LightGBM isn't available (e.g. libomp missing)
XGB_BINARY_PARAMS = {
    'objective':       'binary:logistic',
    'max_depth':       4,
    'learning_rate':   0.05,
    'n_estimators':    1000,
    'subsample':       0.7,
    'colsample_bytree': 0.7,
    'reg_alpha':       0.5,
    'reg_lambda':      2.0,
    'use_label_encoder': False,
    'eval_metric':     'logloss',
    'random_state':    42,
    'n_jobs':          -1,
}


def make_binary_classifier():
    """Return LGBMClassifier if available, else XGBClassifier with binary objective."""
    if lgb is not None:
        return lgb.LGBMClassifier(**LIGHTGBM_PARAMS), 'LightGBM'
    return xgb.XGBClassifier(**XGB_BINARY_PARAMS), 'XGBoost'


# ── Data loading ───────────────────────────────────────────────────────────────

NAME_MAP = {
    'United States': 'USA', 'Korea Republic': 'South Korea',
    "Côte d'Ivoire": 'Ivory Coast', "Cote d'Ivoire": 'Ivory Coast',
    'IR Iran': 'Iran', 'Bosnia and Herzegovina': 'Bosnia & Herzegovina',
    'Türkiye': 'Turkey', 'Czechia': 'Czech Republic',
}


def _normalise(name):
    return NAME_MAP.get(name, name)


def _load_all_pages(client, table, select_fields, filters=None, page=500):
    """Paginate through a Supabase table, returning all rows."""
    count_q = client.table(table).select("id", count="exact")
    if filters:
        for col, op, val in filters:
            count_q = count_q.filter(col, op, val)
    total = (count_q.execute().count or 0)
    rows = []
    for start in range(0, max(total, 1), page):
        end = min(start + page - 1, total - 1)
        q = client.table(table).select(select_fields).order("kickoff_at", desc=False).range(start, end)
        if filters:
            for col, op, val in filters:
                q = q.filter(col, op, val)
        rows.extend(q.execute().data or [])
    return rows


def _rolling_stats(games: pd.DataFrame, before: pd.Timestamp, window: int) -> dict:
    """Return rolling window stats for a team from games played strictly before `before`."""
    past = games[games['kickoff_at'] < before].tail(window)
    if past.empty:
        return {}
    avgs = past[['xg_created', 'xg_conceded', 'ppda_index',
                  'goals_scored', 'goals_conceded']].mean()
    return {
        'xg_created':    float(avgs['xg_created']),
        'xg_conceded':   float(avgs['xg_conceded']),
        'ppda_index':    float(avgs['ppda_index']),
        'sot_ratio':     0.38,   # no shot data in fixture_predictions
        'goals_scored':  float(avgs['goals_scored']),
        'goals_conceded': float(avgs['goals_conceded']),
        'games':         len(past),
    }


def load_training_data(supabase_url: str, supabase_key: str) -> pd.DataFrame:
    """
    Build a point-in-time feature matrix from fixture_predictions + matches.

    For every completed match, rolling stats are computed from games each team
    played BEFORE that match date — no look-ahead bias. This gives BTTS and
    Over/Under models the temporal signal they need.
    """
    client = create_client(supabase_url, supabase_key)

    # ── 1. Load game log from fixture_predictions ──────────────────────────────
    print("Loading game log from fixture_predictions...")
    count_resp = client.table("fixture_predictions").select("fixture_id", count="exact").execute()
    total_fp = count_resp.count or 0
    fp_rows = []
    for start in range(0, max(total_fp, 1), 500):
        end = min(start + 499, total_fp - 1)
        resp = (client.table("fixture_predictions")
                .select("home_team_name, away_team_name, match_kickoff_at, "
                        "home_goals_scored, away_goals_scored, "
                        "xg_created, xg_conceded, ppda_intensity_index")
                .order("match_kickoff_at", desc=False)
                .range(start, end).execute())
        fp_rows.extend(resp.data or [])
    print(f"  {len(fp_rows)} fixture_predictions rows loaded")

    fp = pd.DataFrame(fp_rows)
    fp['kickoff_at'] = pd.to_datetime(fp['match_kickoff_at'], utc=True)
    for col in ['xg_created', 'xg_conceded', 'ppda_intensity_index',
                'home_goals_scored', 'away_goals_scored']:
        fp[col] = pd.to_numeric(fp[col], errors='coerce').fillna(0.0)

    # Build per-team game log (home perspective + away perspective)
    ppda_away = (30.0 - fp['ppda_intensity_index']).clip(7.5, 15.5)
    home_log = pd.DataFrame({
        'team':           fp['home_team_name'].apply(_normalise),
        'kickoff_at':     fp['kickoff_at'],
        'xg_created':     fp['xg_created'],
        'xg_conceded':    fp['xg_conceded'],
        'ppda_index':     fp['ppda_intensity_index'],
        'goals_scored':   fp['home_goals_scored'],
        'goals_conceded': fp['away_goals_scored'],
    })
    away_log = pd.DataFrame({
        'team':           fp['away_team_name'].apply(_normalise),
        'kickoff_at':     fp['kickoff_at'],
        'xg_created':     fp['xg_conceded'],
        'xg_conceded':    fp['xg_created'],
        'ppda_index':     ppda_away,
        'goals_scored':   fp['away_goals_scored'],
        'goals_conceded': fp['home_goals_scored'],
    })
    game_log = pd.concat([home_log, away_log], ignore_index=True).sort_values('kickoff_at')

    # Index: team name (normalised) → sorted DataFrame of their games
    team_games = {name: grp.sort_values('kickoff_at')
                  for name, grp in game_log.groupby('team')}
    print(f"  {len(team_games)} unique teams in game log")

    # ── 2. Load completed matches with results ─────────────────────────────────
    print("Fetching completed matches with results...")
    FIELDS = (
        "id, kickoff_at, result, goals_home, goals_away, "
        "home_team_id, away_team_id, "
        "home_team:teams!matches_home_team_id_fkey(name), "
        "away_team:teams!matches_away_team_id_fkey(name)"
    )
    matches = _load_all_pages(client, "matches", FIELDS,
                              filters=[("result", "not.is", "null")])
    print(f"  {len(matches)} completed matches")
    if not matches:
        return pd.DataFrame()

    # ── 3. Build feature rows with point-in-time rolling stats ────────────────
    print("Computing point-in-time features...")
    B = BASELINES

    def feat(stats, key):
        v = stats.get(key)
        return float(v) if v is not None else B.get(key, 0.0)

    rows = []
    skipped = 0
    for m in matches:
        home_name = _normalise(m['home_team'].get('name', '') if isinstance(m.get('home_team'), dict) else '')
        away_name = _normalise(m['away_team'].get('name', '') if isinstance(m.get('away_team'), dict) else '')
        if not home_name or not away_name:
            skipped += 1
            continue

        match_ts = pd.Timestamp(m['kickoff_at'])
        if match_ts.tzinfo is None:
            match_ts = match_ts.tz_localize('UTC')

        h_games = team_games.get(home_name, pd.DataFrame())
        a_games = team_games.get(away_name, pd.DataFrame())

        h10 = _rolling_stats(h_games, match_ts, 10) if not h_games.empty else {}
        h5  = _rolling_stats(h_games, match_ts, 5)  if not h_games.empty else {}
        a10 = _rolling_stats(a_games, match_ts, 10) if not a_games.empty else {}
        a5  = _rolling_stats(a_games, match_ts, 5)  if not a_games.empty else {}

        # Only include matches where at least one team has prior game history
        if not h10 and not a10:
            skipped += 1
            continue

        hg = m.get('goals_home') or 0
        ag = m.get('goals_away') or 0

        rows.append({
            'match_id':               m['id'],
            'kickoff_at':             m['kickoff_at'],
            'result':                 m['result'],
            'btts_result':            1 if hg >= 1 and ag >= 1 else 0,
            'over_result':            1 if (hg + ag) > 2.5 else 0,
            'is_neutral_venue':       0,
            'home_xg_created_10':     feat(h10, 'xg_created'),
            'home_xg_conceded_10':    feat(h10, 'xg_conceded'),
            'home_ppda_10':           feat(h10, 'ppda_index'),
            'home_sot_ratio_10':      feat(h10, 'sot_ratio'),
            'home_goals_scored_10':   feat(h10, 'goals_scored'),
            'home_goals_conceded_10': feat(h10, 'goals_conceded'),
            'home_xg_created_5':      feat(h5,  'xg_created'),
            'home_xg_conceded_5':     feat(h5,  'xg_conceded'),
            'home_ppda_5':            feat(h5,  'ppda_index'),
            'home_sot_ratio_5':       feat(h5,  'sot_ratio'),
            'away_xg_created_10':     feat(a10, 'xg_created'),
            'away_xg_conceded_10':    feat(a10, 'xg_conceded'),
            'away_ppda_10':           feat(a10, 'ppda_index'),
            'away_sot_ratio_10':      feat(a10, 'sot_ratio'),
            'away_goals_scored_10':   feat(a10, 'goals_scored'),
            'away_goals_conceded_10': feat(a10, 'goals_conceded'),
            'away_xg_created_5':      feat(a5,  'xg_created'),
            'away_xg_conceded_5':     feat(a5,  'xg_conceded'),
            'away_ppda_5':            feat(a5,  'ppda_index'),
            'away_sot_ratio_5':       feat(a5,  'sot_ratio'),
            'rest_days_differential': 0,
        })

    if skipped:
        print(f"  Skipped {skipped} matches (no team name or no prior game history)")

    return pd.DataFrame(rows)


# ── Export to ONNX ─────────────────────────────────────────────────────────────

def export_to_onnx(model, model_name: str, n_features: int, output_dir: Path):
    """Convert model to ONNX and write to disk.
    Uses onnxmltools for both XGBoost and LightGBM (skl2onnx lacks converters for both).
    """
    import onnx as onnx_lib
    out_path = output_dir / f"{model_name}.onnx"

    model_type = type(model).__name__

    try:
        from onnxmltools.convert.common.data_types import FloatTensorType as OMLFloatTensorType
    except ImportError:
        sys.exit("ERROR: onnxmltools not installed. Run: pip install onnxmltools")

    initial_type = [('float_input', OMLFloatTensorType([None, n_features]))]

    if 'XGB' in model_type:
        from onnxmltools import convert_xgboost
        onnx_model = convert_xgboost(model, initial_types=initial_type)
    elif 'LGBM' in model_type:
        from onnxmltools import convert_lightgbm
        onnx_model = convert_lightgbm(model, initial_types=initial_type)
    else:
        sys.exit(f"ERROR: No ONNX converter registered for model type '{model_type}'")

    with open(out_path, 'wb') as f:
        f.write(onnx_model.SerializeToString())
    size_kb = out_path.stat().st_size / 1024
    print(f"  ✓ Exported {out_path.name}  ({size_kb:.1f} KB)")
    return out_path


# ── Evaluation helpers ─────────────────────────────────────────────────────────

def eval_binary(model, X_test, y_test, name: str):
    probs = model.predict_proba(X_test)[:, 1]
    ll  = log_loss(y_test, probs)
    auc = roc_auc_score(y_test, probs)
    acc = accuracy_score(y_test, model.predict(X_test))
    print(f"  {name}: log-loss={ll:.4f}  AUC={auc:.4f}  acc={acc:.3f}")

def eval_multiclass(model, X_test, y_test, name: str):
    probs = model.predict_proba(X_test)
    ll  = log_loss(y_test, probs)
    acc = accuracy_score(y_test, model.predict(X_test))
    print(f"  {name}: log-loss={ll:.4f}  acc={acc:.3f}")


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Train MaxEdge ML Ensemble')
    parser.add_argument('--min-samples', type=int, default=300,
                        help='Minimum completed fixtures required to train (default: 300)')
    parser.add_argument('--output-dir', type=str, default='ensemble/models',
                        help='Directory to write .onnx files (default: ensemble/models)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Load and validate data only — do not train')
    args = parser.parse_args()

    supabase_url = os.environ.get('SUPABASE_URL')
    supabase_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not supabase_url or not supabase_key:
        sys.exit("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── Load data ──────────────────────────────────────────────────────────────
    df = load_training_data(supabase_url, supabase_key)

    if df.empty:
        print("No training data found. Populate matches.result and team_stats_cache first.")
        return

    print(f"\nDataset: {len(df)} rows, {df['result'].value_counts().to_dict()}")
    btts_rate = df['btts_result'].mean()
    over_rate = df['over_result'].mean()
    print(f"  BTTS yes rate: {btts_rate:.2%}   Over 2.5 rate: {over_rate:.2%}")

    if len(df) < args.min_samples:
        print(f"\nINSUFFICIENT DATA: {len(df)} fixtures < {args.min_samples} minimum.")
        print("Dixon-Coles will remain active until this threshold is met.")
        print("Continue collecting match data and re-run when threshold is reached.")
        return

    if args.dry_run:
        print("\nDry run complete — data validated, no models trained.")
        return

    if xgb is None:
        sys.exit("ERROR: xgboost not installed. Run: pip install xgboost")
    if lgb is None:
        print("NOTE: LightGBM not available (libomp missing?) — using XGBoost for BTTS/O-U models")

    # ── Feature matrix ────────────────────────────────────────────────────────
    X = df[FEATURE_NAMES].values.astype(np.float32)

    le = LabelEncoder()
    y_match  = le.fit_transform(df['result'])        # home=0, draw=1, away=2 (sorted)
    y_btts   = df['btts_result'].values
    y_over   = df['over_result'].values

    X_tr, X_te, ym_tr, ym_te = train_test_split(X, y_match, test_size=0.2, random_state=42, stratify=y_match)
    _, _, yb_tr, yb_te        = train_test_split(X, y_btts,  test_size=0.2, random_state=42, stratify=y_btts)
    _, _, yo_tr, yo_te        = train_test_split(X, y_over,  test_size=0.2, random_state=42, stratify=y_over)

    print(f"\nTrain: {len(X_tr)}  Test: {len(X_te)}")

    # ── Train Match Odds XGBoost ──────────────────────────────────────────────
    print("\n[1/3] Training Match Odds XGBoost classifier...")
    match_model = xgb.XGBClassifier(**XGBOOST_PARAMS)
    match_model.fit(
        X_tr, ym_tr,
        eval_set=[(X_te, ym_te)],
        early_stopping_rounds=30,
        verbose=50,
    )
    eval_multiclass(match_model, X_te, ym_te, "Match Odds")
    export_to_onnx(match_model, 'match_odds', X.shape[1], output_dir)

    # ── Train BTTS classifier (LightGBM if available, else XGBoost) ──────────
    btts_clf, btts_lib = make_binary_classifier()
    print(f"\n[2/3] Training BTTS {btts_lib} classifier...")
    if lgb is not None and btts_lib == 'LightGBM':
        btts_clf.fit(X_tr, yb_tr, eval_set=[(X_te, yb_te)],
                     callbacks=[lgb.log_evaluation(50), lgb.early_stopping(30)])
    else:
        btts_clf.fit(X_tr, yb_tr, eval_set=[(X_te, yb_te)],
                     early_stopping_rounds=30, verbose=50)
    eval_binary(btts_clf, X_te, yb_te, "BTTS")
    export_to_onnx(btts_clf, 'btts', X.shape[1], output_dir)

    # ── Train Over/Under classifier ───────────────────────────────────────────
    ou_clf, ou_lib = make_binary_classifier()
    print(f"\n[3/3] Training Over/Under 2.5 {ou_lib} classifier...")
    if lgb is not None and ou_lib == 'LightGBM':
        ou_clf.fit(X_tr, yo_tr, eval_set=[(X_te, yo_te)],
                   callbacks=[lgb.log_evaluation(50), lgb.early_stopping(30)])
    else:
        ou_clf.fit(X_tr, yo_tr, eval_set=[(X_te, yo_te)],
                   early_stopping_rounds=30, verbose=50)
    eval_binary(ou_clf, X_te, yo_te, "Over/Under")
    export_to_onnx(ou_clf, 'over_under', X.shape[1], output_dir)

    # ── Write metadata ────────────────────────────────────────────────────────
    meta = {
        'trained_at':    pd.Timestamp.now().isoformat(),
        'n_samples':     len(df),
        'feature_names': FEATURE_NAMES,
        'label_classes': list(le.classes_),
        'btts_base_rate': float(btts_rate),
        'over_base_rate': float(over_rate),
        'models': ['match_odds.onnx', 'btts.onnx', 'over_under.onnx'],
    }
    meta_path = output_dir / 'metadata.json'
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=2)
    print(f"\n✓ Training complete. Models written to {output_dir}/")
    print(f"  Metadata: {meta_path}")
    print("\nNext step: commit the .onnx files and re-deploy — inference.js will")
    print("auto-detect them and switch the engine to ML_ENSEMBLE architecture.")


if __name__ == '__main__':
    main()
