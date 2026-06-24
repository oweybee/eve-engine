"""
ml/train_xgboost.py — XGBoost Multi-Class Classifier Training & ONNX Export
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Trains a regularised, calibrated 22-feature XGBoost classifier on the
historical match matrix produced by bin/exportTrainingData.js, then compiles
the fully calibrated model to a portable ONNX binary for zero-dependency
Node.js inference via onnxruntime-node.

DESIGN PHILOSOPHY
─────────────────
Football match prediction is fundamentally noisy.  A home win result for one
match is not fully explained by the feature vector — referee decisions, injury
news, weather, and squad morale are invisible to us.  An overfit model will
drive sharp, over-confident probabilities that mimic training noise, causing
our edge-detection layer to flag phantom value.

This script counters that in three ways:

  1. Structural regularisation — shallow trees (max_depth=3), row/column
     subsampling (subsample=0.75, colsample_bytree=0.70), and aggressive L1/L2
     penalties (reg_alpha=0.5, reg_lambda=3.0) prevent any single tree from
     memorising a handful of unusual matches.

  2. Slow shrinkage — a low learning_rate (0.02) with more estimators (600)
     produces a smoother ensemble that generalises better than a fast-learning
     shallow forest.

  3. Isotonic calibration — CalibratedClassifierCV with method='isotonic'
     maps raw XGBoost leaf scores to empirical probabilities via a
     non-parametric isotonic regression fitted on each held-out CV fold.  This
     guarantees that "40% draw probability" is actually close to the true
     observed draw rate, which is essential for an EV formula that divides by
     probability.

MODEL CONTRACT (must not change — Node.js inference.js depends on this)
────────────────────────────────────────────────────────────────────────
  Input  : float32[1, 22]  — single match feature vector (see features.js)
  Output : probabilities float32[1, 3]  — [Home_Prob, Draw_Prob, Away_Prob]
  Labels : 0=Home Win, 1=Draw, 2=Away Win

Feature vector (22 dims, must match features.js EXACTLY):
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
  pip install xgboost skl2onnx scikit-learn numpy
  python ml/train_xgboost.py [--data data/training_set.json] [--out models/match_predictor.onnx]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import warnings
from pathlib import Path
from typing import List, Tuple

import numpy as np


# ── Lazy imports with actionable error messages ───────────────────────────────

def _require(package: str, install_name: str | None = None):
    import importlib
    try:
        return importlib.import_module(package)
    except ImportError:
        pkg = install_name or package
        print(f"[train] Missing dependency: pip install {pkg}", file=sys.stderr)
        sys.exit(1)


# ── Constants ─────────────────────────────────────────────────────────────────

FEATURE_COUNT = 22
NUM_CLASSES   = 3      # 0=Home Win, 1=Draw, 2=Away Win
RANDOM_STATE  = 42
N_CV_FOLDS    = 5

LABEL_NAMES = {0: 'Home Win', 1: 'Draw', 2: 'Away Win'}

FEATURE_NAMES: List[str] = [
    'home_xg_created_10',    'home_xg_conceded_10',   'home_ppda_10',         'home_sot_ratio_10',
    'home_goals_scored_10',  'home_goals_conceded_10',
    'home_xg_created_5',     'home_xg_conceded_5',    'home_ppda_5',          'home_sot_ratio_5',
    'away_xg_created_10',    'away_xg_conceded_10',   'away_ppda_10',         'away_sot_ratio_10',
    'away_goals_scored_10',  'away_goals_conceded_10',
    'away_xg_created_5',     'away_xg_conceded_5',    'away_ppda_5',          'away_sot_ratio_5',
    'rest_days_differential',
    'is_neutral_venue',
]

assert len(FEATURE_NAMES) == FEATURE_COUNT, \
    f"FEATURE_NAMES has {len(FEATURE_NAMES)} entries, expected {FEATURE_COUNT}"

# ── Defensive hyperparameter suite ────────────────────────────────────────────
#
#   max_depth=3
#     Shallow trees cannot memorise specific match sequences. Depth-3 captures
#     first/second-order feature interactions (e.g. home xG × away PPDA) without
#     building full lookup tables for individual matches.
#
#   learning_rate=0.02
#     Slow shrinkage forces the ensemble to converge via many small corrections
#     rather than a few large jumps. Combined with n_estimators=600 this yields a
#     smoother probability surface.
#
#   subsample=0.75
#     Each tree trains on 75% of matches sampled without replacement (stochastic
#     gradient boosting). Reduces variance and exposes rare outcomes (draw, away
#     win) more evenly across the forest.
#
#   colsample_bytree=0.70
#     Each tree selects from a random 70% of the 22 features, preventing the
#     strongest features from dominating every split and suppressing signal from
#     less-correlated features.
#
#   min_child_weight=5
#     A leaf node must represent at least 5 sum-of-Hessian units. Prevents tiny
#     leaf nodes that fit to 1-2 data points.
#
#   gamma=0.3
#     Minimum loss reduction required to split a node. Acts as a pruning
#     threshold: borderline splits are rejected.
#
#   reg_lambda=3.0
#     L2 penalty on leaf weights — smoother probability surfaces, less
#     sensitivity to single outlier matches.
#
#   reg_alpha=0.5
#     L1 penalty that drives weights of uninformative features toward zero.
#
XGBOOST_PARAMS = dict(
    objective         = 'multi:softprob',
    num_class         = NUM_CLASSES,
    eval_metric       = 'mlogloss',
    n_estimators      = 600,
    learning_rate     = 0.02,
    max_depth         = 3,
    subsample         = 0.75,
    colsample_bytree  = 0.70,
    min_child_weight  = 5,
    gamma             = 0.3,
    reg_lambda        = 3.0,
    reg_alpha         = 0.5,
    tree_method       = 'hist',   # fast histogram splits; change to 'gpu_hist' for CUDA
    random_state      = RANDOM_STATE,
    verbosity         = 0,
    use_label_encoder = False,
)


# ── Data loading ──────────────────────────────────────────────────────────────

def load_training_data(data_path: str) -> Tuple[np.ndarray, np.ndarray]:
    """
    Load the JSON matrix written by bin/exportTrainingData.js.

    Each element: { match_id, kickoff_at, label, outcome, features, completeness }
    Returns: X (N×22 float32), y (N int32)
    """
    p = Path(data_path)
    if not p.exists():
        print(f"[train] Training data not found: {p}", file=sys.stderr)
        print(f"[train] Run: node bin/exportTrainingData.js first.", file=sys.stderr)
        sys.exit(1)

    print(f"[train] Loading {p} …")
    with open(p, 'r') as f:
        rows = json.load(f)

    if not rows:
        print("[train] Training set is empty.", file=sys.stderr)
        sys.exit(1)

    features_list: list = []
    labels_list:   list = []
    skipped = 0

    for row in rows:
        fv = row.get('features')
        lb = row.get('label')
        if fv is None or lb is None:
            skipped += 1
            continue
        if len(fv) != FEATURE_COUNT:
            print(
                f"[train] Warning: match {row.get('match_id')} has {len(fv)} features "
                f"(expected {FEATURE_COUNT}) — skipping",
                file=sys.stderr,
            )
            skipped += 1
            continue
        features_list.append(fv)
        labels_list.append(int(lb))

    if skipped:
        print(f"[train] Skipped {skipped} malformed rows.")

    X = np.array(features_list, dtype=np.float32)
    y = np.array(labels_list,   dtype=np.int32)

    assert X.shape[1] == FEATURE_COUNT, f"X has {X.shape[1]} columns, expected {FEATURE_COUNT}"

    label_counts = {LABEL_NAMES[i]: int((y == i).sum()) for i in range(NUM_CLASSES)}
    print(f"[train] Loaded {len(X)} rows — " + "  ".join(f"{k}={v}" for k, v in label_counts.items()))

    if len(X) < 50:
        print(f"[train] ⚠  Only {len(X)} training rows — model will almost certainly overfit.")
        print(f"[train]    Recommend ≥ 500 rows for reliable calibration.")
    elif len(X) < 200:
        print(f"[train] ⚠  {len(X)} rows is marginal — treat probabilities as directional only.")

    # Validate that all three classes are present (required for StratifiedKFold)
    missing = [LABEL_NAMES[i] for i in range(NUM_CLASSES) if (y == i).sum() == 0]
    if missing:
        print(f"[train] ERROR: missing classes in training set: {missing}", file=sys.stderr)
        print(f"[train] Each of Home Win / Draw / Away Win must have ≥ 1 sample.", file=sys.stderr)
        sys.exit(1)

    return X, y


# ── Cross-validated calibration diagnostics ───────────────────────────────────

def _brier_score_multiclass(y_true: np.ndarray, y_prob: np.ndarray, n_classes: int) -> float:
    """
    Multi-class Brier score (mean squared error over one-hot encodings).
    Range [0, 2].  Lower is better.  A perfectly calibrated model on balanced
    3-class data scores ≈ 0.44.  Random guessing scores ≈ 0.67.
    """
    n = len(y_true)
    one_hot = np.zeros((n, n_classes), dtype=np.float32)
    one_hot[np.arange(n), y_true] = 1.0
    return float(np.mean(np.sum((y_prob - one_hot) ** 2, axis=1)))


def run_cv_diagnostics(X: np.ndarray, y: np.ndarray) -> None:
    """
    Run N_CV_FOLDS stratified k-fold CV on the BASE (uncalibrated) XGBoost
    model and print log-loss + Brier score per fold and overall mean.

    This gives a reliable estimate of the raw model's discrimination ability
    BEFORE isotonic calibration so we can verify calibration is actually
    helping (calibrated Brier score should be ≤ uncalibrated Brier score).
    """
    xgb            = _require('xgboost')
    sklearn_ms      = _require('sklearn.model_selection', 'scikit-learn')
    sklearn_metrics = _require('sklearn.metrics',         'scikit-learn')

    StratifiedKFold = sklearn_ms.StratifiedKFold
    log_loss        = sklearn_metrics.log_loss

    cv = StratifiedKFold(n_splits=N_CV_FOLDS, shuffle=True, random_state=RANDOM_STATE)

    ll_scores:    list = []
    brier_scores: list = []

    print(f"[train] ── Cross-Validation Diagnostics ({N_CV_FOLDS}-fold Stratified, uncalibrated) ──")
    print(f"[train]  {'Fold':<6}  {'Log-Loss':<12}  {'Brier Score':<14}  {'N-Val'}")
    print(f"[train]  {'─'*52}")

    for fold_idx, (train_idx, val_idx) in enumerate(cv.split(X, y), start=1):
        X_tr, X_val = X[train_idx], X[val_idx]
        y_tr, y_val = y[train_idx], y[val_idx]

        clf = xgb.XGBClassifier(**XGBOOST_PARAMS)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            clf.fit(X_tr, y_tr, eval_set=[(X_val, y_val)], verbose=False)

        probs = clf.predict_proba(X_val)   # shape (N_val, 3)
        ll    = log_loss(y_val, probs, labels=[0, 1, 2])
        bs    = _brier_score_multiclass(y_val, probs, NUM_CLASSES)

        ll_scores.append(ll)
        brier_scores.append(bs)
        print(f"[train]  {fold_idx:<6}  {ll:<12.4f}  {bs:<14.4f}  {len(val_idx)}")

    mean_ll = float(np.mean(ll_scores))
    std_ll  = float(np.std(ll_scores))
    mean_bs = float(np.mean(brier_scores))
    std_bs  = float(np.std(brier_scores))

    print(f"[train]  {'─'*52}")
    print(f"[train]  {'Mean':<6}  {mean_ll:<12.4f}  {mean_bs:<14.4f}")
    print(f"[train]  {'Std':<6}  {std_ll:<12.4f}  {std_bs:<14.4f}")

    # Calibration quality guidance
    print()
    print(f"[train] Calibration notes (uncalibrated scores — isotonic will improve these):")
    if mean_ll < 0.90:
        print(f"[train]   Log-loss {mean_ll:.4f} — good discrimination (< 0.90 for balanced 3-class).")
    elif mean_ll < 1.05:
        print(f"[train]   Log-loss {mean_ll:.4f} — marginal (0.90–1.05); more data will help.")
    else:
        print(f"[train]   Log-loss {mean_ll:.4f} — at or below random chance (≈ 1.099); check data quality.")

    if mean_bs < 0.55:
        print(f"[train]   Brier score {mean_bs:.4f} — good calibration (< 0.55 for balanced 3-class).")
    elif mean_bs < 0.67:
        print(f"[train]   Brier score {mean_bs:.4f} — above balanced baseline; isotonic calibration will help.")
    else:
        print(f"[train]   Brier score {mean_bs:.4f} — at random-guess level; dataset may be too small or too noisy.")

    print()


# ── Training + isotonic calibration ──────────────────────────────────────────

def train(X: np.ndarray, y: np.ndarray):
    """
    Fit the final calibrated classifier.

    Steps:
      1. Run CV diagnostics to emit log-loss / Brier score telemetry.
      2. Wrap the configured XGBClassifier in CalibratedClassifierCV(
           method='isotonic', cv=StratifiedKFold(5)) and fit on the full
           dataset. Internally this trains N_CV_FOLDS XGBoost models on
           held-out folds and fits an isotonic regression per class per fold
           to map raw leaf scores to empirical probabilities. At inference
           time each fold's calibrated predictions are averaged.
      3. Run in-sample sanity checks (sum-to-1, range).
      4. Return the fitted CalibratedClassifierCV.
    """
    xgb           = _require('xgboost')
    sklearn_calib  = _require('sklearn.calibration',     'scikit-learn')
    sklearn_ms     = _require('sklearn.model_selection', 'scikit-learn')
    sklearn_met    = _require('sklearn.metrics',         'scikit-learn')

    CalibratedClassifierCV = sklearn_calib.CalibratedClassifierCV
    StratifiedKFold        = sklearn_ms.StratifiedKFold
    log_loss               = sklearn_met.log_loss

    # Step 1: CV diagnostics on the uncalibrated base model
    run_cv_diagnostics(X, y)

    # Step 2: Final calibrated fit on the full dataset
    print(f"[train] ── Fitting CalibratedClassifierCV(method='isotonic', cv={N_CV_FOLDS}-fold) ──")
    t0 = time.time()

    base_clf = xgb.XGBClassifier(**XGBOOST_PARAMS)
    cv       = StratifiedKFold(n_splits=N_CV_FOLDS, shuffle=True, random_state=RANDOM_STATE)

    calibrated = CalibratedClassifierCV(
        estimator = base_clf,
        method    = 'isotonic',  # non-parametric; handles the S-shaped score distortion
        cv        = cv,          # StratifiedKFold guarantees balanced class slices per fold
    )

    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        calibrated.fit(X, y)

    elapsed = time.time() - t0
    print(f"[train] Calibrated fit complete in {elapsed:.1f}s.")

    # Step 3: In-sample sanity checks
    print(f"\n[train] ── Post-calibration in-sample checks ──")
    cal_probs = calibrated.predict_proba(X)   # shape (N, 3)
    cal_ll    = log_loss(y, cal_probs, labels=[0, 1, 2])
    cal_bs    = _brier_score_multiclass(y, cal_probs, NUM_CLASSES)
    print(f"[train] In-sample log-loss : {cal_ll:.4f}")
    print(f"[train] In-sample Brier    : {cal_bs:.4f}")
    print(f"[train] (In-sample scores are optimistic vs CV — use CV scores for external reporting.)")

    # Probability sum-to-1 check
    prob_sums   = cal_probs.sum(axis=1)
    max_dev     = float(np.abs(prob_sums - 1.0).max())
    if max_dev > 1e-4:
        print(f"[train] ⚠  Probabilities not summing to 1 (max deviation {max_dev:.6f}).")
    else:
        print(f"[train] ✓ sum-to-1 check passed (max deviation {max_dev:.2e}).")

    # Probability range check
    p_min, p_max = float(cal_probs.min()), float(cal_probs.max())
    if p_min < 0 or p_max > 1:
        print(f"[train] ⚠  Probabilities outside [0, 1]: [{p_min:.6f}, {p_max:.6f}].")
    else:
        print(f"[train] ✓ range check passed: [{p_min:.4f}, {p_max:.4f}].")

    print()
    return calibrated


# ── Feature importance report ─────────────────────────────────────────────────

def print_feature_importance(calibrated) -> None:
    """
    Extract per-feature gain importance from the calibrated ensemble.

    CalibratedClassifierCV wraps N_CV_FOLDS sub-estimators. We average their
    feature importances to get a stable estimate less sensitive to any one fold.
    """
    try:
        importances_per_fold = []
        for cc in calibrated.calibrated_classifiers_:
            base = cc.estimator
            importances_per_fold.append(base.feature_importances_)

        importances = np.mean(importances_per_fold, axis=0)
        ranked = sorted(zip(FEATURE_NAMES, importances), key=lambda x: x[1], reverse=True)
        top_imp = ranked[0][1] if ranked[0][1] > 0 else 1.0

        print(f"[train] ── Feature Importance (avg gain across {len(importances_per_fold)} folds) ──")
        print(f"[train]  {'Feature':<32}  {'Importance':<12}  Bar")
        print(f"[train]  {'─'*65}")
        for name, imp in ranked:
            bar = '█' * max(1, int(imp / top_imp * 30)) if imp > 0 else '·'
            print(f"[train]  {name:<32}  {imp:<12.4f}  {bar}")
        print()

        # Flag near-zero importance features — candidates for removal if data is sparse
        zero_features = [name for name, imp in ranked if imp < 0.001]
        if zero_features:
            print(f"[train] Low-importance features (consider removing when N < 500):")
            for f in zero_features:
                print(f"[train]   · {f}")
            print()

    except AttributeError as e:
        print(f"[train] Could not extract feature importances: {e}")


# ── ONNX export ───────────────────────────────────────────────────────────────

def export_onnx(calibrated, out_path: str) -> None:
    """
    Serialise the calibrated classifier to ONNX using skl2onnx.

    skl2onnx supports CalibratedClassifierCV wrapping an XGBClassifier natively
    as of version 1.16.  The exported graph is:

      Input  → 'float_input'        : float32[batch, 22]
      Output → 'output_label'       : int64[batch]           (argmax class)
               'output_probability' : float32[batch, 3]       (when zipmap=False)

    inference.js reads from 'output_probability' (or whichever output name
    contains 'prob').  We set zipmap=False to get a flat float32 array instead
    of a sequence-of-maps — both faster and simpler to parse.  If the skl2onnx
    version in use doesn't support zipmap=False on CalibratedClassifierCV, we
    fall back to zipmap=True; inference.js handles both formats.
    """
    _require('skl2onnx')
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
    import xgboost as xgb_mod

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    initial_type = [('float_input', FloatTensorType([None, FEATURE_COUNT]))]

    print(f"[train] ── ONNX Export ──")
    print(f"[train] Converting CalibratedClassifierCV → ONNX (opset 17, zipmap=False) …")

    # The options key must be the leaf estimator type inside the pipeline
    options = {xgb_mod.XGBClassifier: {'zipmap': False}}

    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            onnx_model = convert_sklearn(
                calibrated,
                name          = 'MaxEdgeMatchPredictor',
                initial_types = initial_type,
                target_opset  = 17,
                options       = options,
            )
    except Exception as e_zipmap:
        print(f"[train] zipmap=False failed ({e_zipmap}); retrying with zipmap=True …")
        print(f"[train] inference.js handles the sequence-of-maps format automatically.")
        options_fallback = {xgb_mod.XGBClassifier: {'zipmap': True}}
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            onnx_model = convert_sklearn(
                calibrated,
                name          = 'MaxEdgeMatchPredictor',
                initial_types = initial_type,
                target_opset  = 17,
                options       = options_fallback,
            )

    out.write_bytes(onnx_model.SerializeToString())
    size_kb = out.stat().st_size / 1024

    print(f"[train] ✓ Written: {out}  ({size_kb:.1f} KB)")
    print(f"[train]   Input  : float32[batch, {FEATURE_COUNT}]  ('float_input')")
    print(f"[train]   Output : float32[batch, {NUM_CLASSES}]    ('output_probability')  — [Home, Draw, Away]")
    print()

    _onnx_smoke_test(out)


def _onnx_smoke_test(model_path: Path) -> None:
    """
    Load the exported ONNX model with onnxruntime and run a single inference
    on a zero vector to verify the output shape and probability contract.
    Skipped gracefully when onnxruntime is not installed.
    """
    try:
        import onnxruntime as ort
    except ImportError:
        print(f"[train] onnxruntime not installed — skipping smoke test.")
        print(f"[train]   (onnxruntime-node handles inference at engine runtime)")
        return

    try:
        sess  = ort.InferenceSession(str(model_path), providers=['CPUExecutionProvider'])
        dummy = np.zeros((1, FEATURE_COUNT), dtype=np.float32)
        outs  = sess.run(None, {sess.get_inputs()[0].name: dummy})

        # Find the probability output — contains 'prob' in its name or has 3 columns
        prob_out = None
        for i, meta in enumerate(sess.get_outputs()):
            if 'prob' in meta.name.lower():
                prob_out = outs[i]
                break
        if prob_out is None:
            for out in outs:
                arr = np.array(out) if not isinstance(out, np.ndarray) else out
                if arr.ndim == 2 and arr.shape[1] == NUM_CLASSES:
                    prob_out = arr
                    break

        if prob_out is not None:
            probs    = np.array(prob_out, dtype=np.float32).reshape(-1)[:NUM_CLASSES]
            prob_sum = float(probs.sum())
            print(f"[train] ONNX smoke test:")
            print(f"[train]   dummy input → probs {probs.round(4).tolist()}  (sum={prob_sum:.4f})")
            if abs(prob_sum - 1.0) < 0.01:
                print(f"[train]   ✓ Contract verified — probabilities sum to 1.")
            else:
                print(f"[train]   ⚠ Probabilities do not sum to 1 ({prob_sum:.4f}) — investigate.")
        else:
            print(f"[train] ONNX smoke test: could not locate probability output tensor.")

    except Exception as e:
        print(f"[train] ONNX smoke test failed: {e}")

    print()


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Train regularised + calibrated XGBoost match predictor and export to ONNX',
    )
    parser.add_argument(
        '--data',
        default=str(Path(__file__).parent.parent / 'data' / 'training_set.json'),
        help='Path to training_set.json produced by bin/exportTrainingData.js '
             '(default: data/training_set.json)',
    )
    parser.add_argument(
        '--out',
        default=str(Path(__file__).parent.parent / 'models' / 'match_predictor.onnx'),
        help='Output path for the ONNX model (default: models/match_predictor.onnx)',
    )
    args = parser.parse_args()

    wall_start = time.time()

    print()
    print(f"[train] ╔══════════════════════════════════════════════════╗")
    print(f"[train] ║  MaxEdge XGBoost Match Predictor — Training Run  ║")
    print(f"[train] ╚══════════════════════════════════════════════════╝")
    print(f"[train]  Data path  : {args.data}")
    print(f"[train]  Model out  : {args.out}")
    print(f"[train]  Params     : max_depth={XGBOOST_PARAMS['max_depth']}  "
          f"lr={XGBOOST_PARAMS['learning_rate']}  "
          f"n_est={XGBOOST_PARAMS['n_estimators']}  "
          f"subsample={XGBOOST_PARAMS['subsample']}  "
          f"colsample={XGBOOST_PARAMS['colsample_bytree']}")
    print(f"[train]  Reg        : λ={XGBOOST_PARAMS['reg_lambda']}  "
          f"α={XGBOOST_PARAMS['reg_alpha']}  "
          f"γ={XGBOOST_PARAMS['gamma']}  "
          f"min_child_weight={XGBOOST_PARAMS['min_child_weight']}")
    print(f"[train]  CV         : StratifiedKFold(n_splits={N_CV_FOLDS}, shuffle=True, random_state={RANDOM_STATE})")
    print(f"[train]  Calibration: CalibratedClassifierCV(method='isotonic', cv={N_CV_FOLDS}-fold)")
    print()

    X, y       = load_training_data(args.data)
    calibrated = train(X, y)
    print_feature_importance(calibrated)
    export_onnx(calibrated, args.out)

    elapsed = time.time() - wall_start
    print(f"[train] ── Complete ──")
    print(f"[train] Total wall time: {elapsed:.1f}s")
    print()
    print(f"[train] Next steps:")
    print(f"[train]   1. Commit the ONNX binary:")
    print(f"[train]        git add models/match_predictor.onnx")
    print(f"[train]        git commit -m 'model: retrain match_predictor (regularised + calibrated)'")
    print(f"[train]   2. Push to trigger engine deployment:")
    print(f"[train]        git push origin main")
    print(f"[train]   3. Engine auto-discovers models/match_predictor.onnx on next run.")
    print(f"[train]      Dixon-Coles [DEPRECATED] path will not be reached.")
    print()


if __name__ == '__main__':
    main()
