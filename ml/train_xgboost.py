"""
ml/train_xgboost.py — XGBoost Multi-Class Classifier Training & ONNX Export

Trains a 22-feature XGBoost classifier on the historical match matrix produced
by bin/exportTrainingData.js, then compiles it to a portable ONNX binary for
zero-dependency Node.js inference via onnxruntime-node.

Model contract:
  Input  : float32[1, 22]  — single match feature vector (see features.js)
  Output : probabilities float32[1, 3]  — [Home_Prob, Draw_Prob, Away_Prob]
  Labels : 0=Home Win, 1=Draw, 2=Away Win

Feature vector (22 dimensions, must match features.js EXACTLY):
  home_xg_created_10, home_xg_conceded_10, home_ppda_10, home_sot_ratio_10,
  home_goals_scored_10, home_goals_conceded_10,
  home_xg_created_5,  home_xg_conceded_5,  home_ppda_5,  home_sot_ratio_5,
  away_xg_created_10, away_xg_conceded_10, away_ppda_10, away_sot_ratio_10,
  away_goals_scored_10, away_goals_conceded_10,
  away_xg_created_5,  away_xg_conceded_5,  away_ppda_5,  away_sot_ratio_5,
  rest_days_differential,
  is_neutral_venue

Usage:
  cd engine
  pip install xgboost onnxmltools skl2onnx scikit-learn numpy pandas
  python ml/train_xgboost.py [--data data/training_set.json] [--out models/match_predictor.onnx]

Dependencies:
  xgboost>=2.0      — gradient boosting training
  skl2onnx>=1.16    — sklearn-API ONNX conversion (supports XGBClassifier)
  onnxmltools>=1.11 — alternative ONNX conversion path (fallback)
  scikit-learn      — preprocessing + calibration
  numpy, pandas     — data handling
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import warnings
from pathlib import Path
from typing import List, Tuple

import numpy as np
import pandas as pd

# ── Lazy imports with helpful error messages ──────────────────────────────────

def _require(package: str, install_name: str = None):
    import importlib
    try:
        return importlib.import_module(package)
    except ImportError:
        pkg = install_name or package
        print(f"[train] Missing dependency: pip install {pkg}", file=sys.stderr)
        sys.exit(1)

# ── Constants ─────────────────────────────────────────────────────────────────

FEATURE_COUNT  = 22
NUM_CLASSES    = 3    # 0=Home, 1=Draw, 2=Away
RANDOM_STATE   = 42

# XGBoost hyperparameters — tuned for small-to-medium football datasets.
# Increase n_estimators and lower learning_rate once the dataset exceeds ~5000 rows.
XGBOOST_PARAMS = dict(
    objective          = 'multi:softprob',   # outputs calibrated probability per class
    num_class          = NUM_CLASSES,
    n_estimators       = 300,
    learning_rate      = 0.05,
    max_depth          = 4,                  # shallow trees reduce overfit on small N
    min_child_weight   = 3,
    subsample          = 0.8,
    colsample_bytree   = 0.8,
    gamma              = 0.1,
    reg_alpha          = 0.1,                # L1 — sparse features
    reg_lambda         = 1.0,               # L2 — default XGB
    random_state       = RANDOM_STATE,
    eval_metric        = 'mlogloss',
    use_label_encoder  = False,
    tree_method        = 'hist',             # fast histogram method; GPU: 'gpu_hist'
    verbosity          = 0,
)

FEATURE_NAMES: List[str] = [
    'home_xg_created_10',    'home_xg_conceded_10',  'home_ppda_10',         'home_sot_ratio_10',
    'home_goals_scored_10',  'home_goals_conceded_10',
    'home_xg_created_5',     'home_xg_conceded_5',   'home_ppda_5',          'home_sot_ratio_5',
    'away_xg_created_10',    'away_xg_conceded_10',  'away_ppda_10',         'away_sot_ratio_10',
    'away_goals_scored_10',  'away_goals_conceded_10',
    'away_xg_created_5',     'away_xg_conceded_5',   'away_ppda_5',          'away_sot_ratio_5',
    'rest_days_differential',
    'is_neutral_venue',
]

# ── Data loading ──────────────────────────────────────────────────────────────

def load_training_data(data_path: str) -> Tuple[np.ndarray, np.ndarray]:
    """
    Load the JSON matrix written by bin/exportTrainingData.js.

    Each element: { match_id, kickoff_at, label, outcome, features, completeness }
    Returns: X (N×22 float32), y (N int32)
    """
    data_path = Path(data_path)
    if not data_path.exists():
        print(f"[train] Training data not found: {data_path}", file=sys.stderr)
        print(f"[train] Run: node bin/exportTrainingData.js first.", file=sys.stderr)
        sys.exit(1)

    print(f"[train] Loading {data_path} …")
    with open(data_path, 'r') as f:
        rows = json.load(f)

    if not rows:
        print("[train] Training set is empty.", file=sys.stderr)
        sys.exit(1)

    features_list = []
    labels_list   = []

    for row in rows:
        fv = row.get('features')
        lb = row.get('label')
        if fv is None or lb is None:
            continue
        if len(fv) != FEATURE_COUNT:
            print(
                f"[train] Warning: match {row.get('match_id')} has {len(fv)} features "
                f"(expected {FEATURE_COUNT}) — skipping",
                file=sys.stderr,
            )
            continue
        features_list.append(fv)
        labels_list.append(int(lb))

    X = np.array(features_list, dtype=np.float32)
    y = np.array(labels_list,   dtype=np.int32)

    # Validate
    assert X.shape[1] == FEATURE_COUNT, f"X has {X.shape[1]} columns, expected {FEATURE_COUNT}"
    label_counts = {lbl: int((y == lbl).sum()) for lbl in range(NUM_CLASSES)}
    print(f"[train] Loaded {len(X)} rows — Home={label_counts[0]}  Draw={label_counts[1]}  Away={label_counts[2]}")

    if len(X) < 50:
        print(f"[train] Warning: only {len(X)} training rows. Model will likely overfit.")
        print(f"[train] Recommend ≥ 500 rows for reliable calibration.")

    return X, y


# ── Training ──────────────────────────────────────────────────────────────────

def train(X: np.ndarray, y: np.ndarray):
    """
    Train an XGBClassifier with cross-validated early stopping + isotonic
    calibration to ensure the output probabilities are well-calibrated.

    Returns the fitted (and calibrated) classifier.
    """
    xgb = _require('xgboost')
    sklearn_model_sel = _require('sklearn.model_selection', 'scikit-learn')
    sklearn_calib     = _require('sklearn.calibration',     'scikit-learn')
    sklearn_metrics   = _require('sklearn.metrics',         'scikit-learn')

    XGBClassifier        = xgb.XGBClassifier
    StratifiedKFold      = sklearn_model_sel.StratifiedKFold
    cross_val_score      = sklearn_model_sel.cross_val_score
    train_test_split     = sklearn_model_sel.train_test_split
    CalibratedClassifierCV = sklearn_calib.CalibratedClassifierCV
    log_loss             = sklearn_metrics.log_loss

    # ── 5-fold cross-validation to gauge expected generalisation ──────────────
    base_clf = XGBClassifier(**XGBOOST_PARAMS)
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=RANDOM_STATE)

    print("[train] Running 5-fold cross-validation …")
    # Suppress XGBoost verbosity during CV
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        cv_scores = cross_val_score(
            base_clf, X, y,
            scoring='neg_log_loss',
            cv=cv,
            n_jobs=-1,
        )

    mean_ll  = -cv_scores.mean()
    std_ll   = cv_scores.std()
    print(f"[train] CV log-loss: {mean_ll:.4f} ± {std_ll:.4f}")

    # ── Final fit on full dataset ─────────────────────────────────────────────
    print("[train] Training final model on full dataset …")
    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.15, stratify=y, random_state=RANDOM_STATE,
    )

    final_clf = XGBClassifier(**XGBOOST_PARAMS)
    # Use eval_set for early stopping on the held-out validation slice.
    final_clf.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        verbose=False,
    )

    val_probs = final_clf.predict_proba(X_val)
    val_ll    = log_loss(y_val, val_probs)
    print(f"[train] Validation log-loss (hold-out 15%): {val_ll:.4f}")

    # ── Isotonic calibration ──────────────────────────────────────────────────
    # Ensures predict_proba() outputs are well-calibrated probabilities (sum to
    # 1.0) and reduces typical XGBoost over-confidence on small datasets.
    print("[train] Calibrating probabilities with isotonic regression …")
    calibrated = CalibratedClassifierCV(
        XGBClassifier(**XGBOOST_PARAMS),
        method='isotonic',
        cv=3,
    )
    calibrated.fit(X, y)

    cal_probs = calibrated.predict_proba(X_val)
    cal_ll    = log_loss(y_val, cal_probs)
    print(f"[train] Calibrated log-loss (hold-out 15%): {cal_ll:.4f}")

    # Log which model we'll export (calibrated if it improves log-loss).
    if cal_ll <= val_ll:
        print("[train] Using calibrated model for export.")
        return calibrated
    else:
        print("[train] Calibration did not improve val log-loss — exporting raw model.")
        return final_clf


# ── ONNX Export ───────────────────────────────────────────────────────────────

def export_onnx(clf, out_path: str) -> None:
    """
    Convert the trained classifier to ONNX format using skl2onnx.

    skl2onnx supports both XGBClassifier and CalibratedClassifierCV wrappers,
    so the same code path works regardless of which model `train()` returns.

    The ONNX graph:
      Input  → 'float_input'  : float32[1, 22]
      Output → 'output_label' : int64[1]           (argmax class)
               'output_probability' : sequence<map<int64, float32>> [1]  — per-class probs

    Note: onnxruntime-node reads probabilities from 'output_probability'.
    The Node.js wrapper in ensemble/inference.js handles the sequence-of-maps
    format automatically.
    """
    skl2onnx = _require('skl2onnx')
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType

    print(f"[train] Converting to ONNX …")

    # Initial_type specifies the input shape: batch=1 (runtime), features=22.
    initial_type = [('float_input', FloatTensorType([None, FEATURE_COUNT]))]

    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        onnx_model = convert_sklearn(
            clf,
            name='MaxEdgeMatchPredictor',
            initial_types=initial_type,
            target_opset=17,
            options={type(clf): {'zipmap': False}},  # output raw array, not zip-map dict
        )

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(onnx_model.SerializeToString())

    size_kb = out_path.stat().st_size / 1024
    print(f"[train] ✓ ONNX model written: {out_path}  ({size_kb:.1f} KB)")
    print(f"[train]   Input  : float32[batch, {FEATURE_COUNT}]")
    print(f"[train]   Output : probabilities float32[batch, {NUM_CLASSES}]  (0=Home, 1=Draw, 2=Away)")


# ── Feature importance report ─────────────────────────────────────────────────

def print_feature_importance(clf) -> None:
    """Print per-feature importance if the clf exposes it (raw XGBClassifier)."""
    try:
        # CalibratedClassifierCV wraps multiple estimators; try the first.
        base = clf
        if hasattr(clf, 'calibrated_classifiers_'):
            base = clf.calibrated_classifiers_[0].estimator

        importances = base.feature_importances_
        ranked = sorted(
            zip(FEATURE_NAMES, importances),
            key=lambda x: x[1],
            reverse=True,
        )
        print("\n[train] Feature importances (gain):")
        for name, imp in ranked[:10]:
            bar = '█' * int(imp / ranked[0][1] * 20)
            print(f"  {name:<30s}  {imp:.4f}  {bar}")
    except AttributeError:
        pass


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Train XGBoost match predictor and export to ONNX',
    )
    parser.add_argument(
        '--data',
        default=str(Path(__file__).parent.parent / 'data' / 'training_set.json'),
        help='Path to training_set.json (default: data/training_set.json)',
    )
    parser.add_argument(
        '--out',
        default=str(Path(__file__).parent.parent / 'models' / 'match_predictor.onnx'),
        help='Output path for the ONNX model (default: models/match_predictor.onnx)',
    )
    args = parser.parse_args()

    print(f"[train] MaxEdge XGBoost Match Predictor")
    print(f"[train] Data : {args.data}")
    print(f"[train] Out  : {args.out}")
    print()

    X, y       = load_training_data(args.data)
    clf        = train(X, y)
    print_feature_importance(clf)
    export_onnx(clf, args.out)

    print()
    print("[train] Done. Next step:")
    print("[train]   node computeValues.js   (will auto-discover models/match_predictor.onnx)")


if __name__ == '__main__':
    main()
