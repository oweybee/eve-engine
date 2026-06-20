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
    'n_estimators':    1000,   # high ceiling — early_stopping_rounds will cut this down
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
    'n_estimators':    1000,   # early_stopping_rounds cuts this down
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

def load_training_data(supabase_url: str, supabase_key: str) -> pd.DataFrame:
    """
    Pull completed fixtures with their pre-match rolling stats from Supabase.
    Joins matches (results) ← team_stats_cache (features) for both teams.
    """
    client = create_client(supabase_url, supabase_key)

    print("Fetching completed fixtures with results...")
    FIELDS = (
        "id, kickoff_at, result, goals_home, goals_away, "
        "xg_home, xg_away, "
        "home_team_id, away_team_id, "
        "home_team:teams!matches_home_team_id_fkey(name), "
        "away_team:teams!matches_away_team_id_fkey(name)"
    )
    count_resp = (
        client.table("matches")
        .select("id", count="exact")
        .filter("result", "not.is", "null")
        .execute()
    )
    total = count_resp.count or len(count_resp.data or [])
    PAGE = 500
    matches = []
    for start in range(0, total, PAGE):
        end = min(start + PAGE - 1, total - 1)
        batch = (
            client.table("matches")
            .select(FIELDS)
            .filter("result", "not.is", "null")
            .order("kickoff_at", desc=False)
            .range(start, end)
            .execute()
        )
        matches.extend(batch.data or [])
    print(f"Found {len(matches)} completed fixtures")

    if not matches:
        return pd.DataFrame()

    # Fetch all team_stats_cache rows in one call to avoid N+1
    all_team_ids = list(set(
        [m['home_team_id'] for m in matches] +
        [m['away_team_id'] for m in matches]
    ))

    print("Fetching team rolling stats...")
    stats_resp = (
        client.table("team_stats_cache")
        .select("*")
        .in_("team_id", all_team_ids)
        .execute()
    )

    # Index: (team_id, roll_window, as_of) → stats row
    stats_index = {}
    for row in (stats_resp.data or []):
        key = (row['team_id'], row['roll_window'])
        if key not in stats_index or row['as_of'] > stats_index[key]['as_of']:
            stats_index[key] = row

    rows = []
    for m in matches:
        h_id = m['home_team_id']
        a_id = m['away_team_id']
        h10 = stats_index.get((h_id, 10), {})
        h5  = stats_index.get((h_id, 5),  {})
        a10 = stats_index.get((a_id, 10), {})
        a5  = stats_index.get((a_id, 5),  {})

        def g(d, key):
            v = d.get(key)
            return float(v) if v is not None else None

        row = {
            'match_id':               m['id'],
            'kickoff_at':             m['kickoff_at'],
            'result':                 m['result'],           # 'home'|'draw'|'away'
            'btts_result':            1 if (m.get('goals_home', 0) or 0) >= 1
                                        and (m.get('goals_away', 0) or 0) >= 1 else 0,
            'over_result':            1 if ((m.get('goals_home', 0) or 0) +
                                            (m.get('goals_away', 0) or 0)) > 2.5 else 0,
            'is_neutral_venue':       0,  # not in matches schema; WC matches are neutral but model learns from context
            'home_xg_created_10':     g(h10, 'xg_created')     or BASELINES['xg_created'],
            'home_xg_conceded_10':    g(h10, 'xg_conceded')    or BASELINES['xg_conceded'],
            'home_ppda_10':           g(h10, 'ppda_index')      or BASELINES['ppda_index'],
            'home_sot_ratio_10':      g(h10, 'sot_ratio')       or BASELINES['sot_ratio'],
            'home_goals_scored_10':   g(h10, 'goals_scored')    or BASELINES['goals_scored'],
            'home_goals_conceded_10': g(h10, 'goals_conceded')  or BASELINES['goals_conceded'],
            'home_xg_created_5':      g(h5,  'xg_created')     or BASELINES['xg_created'],
            'home_xg_conceded_5':     g(h5,  'xg_conceded')    or BASELINES['xg_conceded'],
            'home_ppda_5':            g(h5,  'ppda_index')      or BASELINES['ppda_index'],
            'home_sot_ratio_5':       g(h5,  'sot_ratio')       or BASELINES['sot_ratio'],
            'away_xg_created_10':     g(a10, 'xg_created')     or BASELINES['xg_created'],
            'away_xg_conceded_10':    g(a10, 'xg_conceded')    or BASELINES['xg_conceded'],
            'away_ppda_10':           g(a10, 'ppda_index')      or BASELINES['ppda_index'],
            'away_sot_ratio_10':      g(a10, 'sot_ratio')       or BASELINES['sot_ratio'],
            'away_goals_scored_10':   g(a10, 'goals_scored')    or BASELINES['goals_scored'],
            'away_goals_conceded_10': g(a10, 'goals_conceded')  or BASELINES['goals_conceded'],
            'away_xg_created_5':      g(a5,  'xg_created')     or BASELINES['xg_created'],
            'away_xg_conceded_5':     g(a5,  'xg_conceded')    or BASELINES['xg_conceded'],
            'away_ppda_5':            g(a5,  'ppda_index')      or BASELINES['ppda_index'],
            'away_sot_ratio_5':       g(a5,  'sot_ratio')       or BASELINES['sot_ratio'],
            'rest_days_differential': 0,   # placeholder — computed from kickoff_at diffs
        }
        rows.append(row)

    return pd.DataFrame(rows)


# ── Export to ONNX ─────────────────────────────────────────────────────────────

def export_to_onnx(model, model_name: str, n_features: int, output_dir: Path):
    """Convert model to ONNX and write to disk.
    Uses onnxmltools for XGBoost (skl2onnx lacks a native XGB converter).
    """
    import onnx as onnx_lib
    out_path = output_dir / f"{model_name}.onnx"

    model_type = type(model).__name__

    if 'XGB' in model_type:
        try:
            from onnxmltools import convert_xgboost
            from onnxmltools.convert.common.data_types import FloatTensorType as OMLFloatTensorType
        except ImportError:
            sys.exit("ERROR: onnxmltools not installed. Run: pip install onnxmltools")
        initial_type = [('float_input', OMLFloatTensorType([None, n_features]))]
        onnx_model = convert_xgboost(model, initial_types=initial_type)
    else:
        try:
            from skl2onnx import to_onnx
            from skl2onnx.common.data_types import FloatTensorType
        except ImportError:
            sys.exit("ERROR: skl2onnx not installed. Run: pip install skl2onnx onnx")
        initial_type = [('float_input', FloatTensorType([None, n_features]))]
        onnx_model = to_onnx(model, initial_types=initial_type, target_opset=15)

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
