"""
backtest.py  –  Heads Up Forecasting Engine Backtester
=======================================================
Runs the LSTM path model (Mode A) or kinematic persistence
fallback (Mode B) against held-out IBTrACS storms and
produces all accuracy metrics the panel expects.

Usage
-----
    cd backend/
    python scripts/backtest.py

Outputs
-------
  results/backtest_summary.txt   -- plain-text metric table
  results/backtest_metrics.json  -- machine-readable JSON
  results/confusion_matrix.png   -- intensity class heatmap
  results/track_error_plot.png   -- RMSE / MAE by lead time

Requirements
------------
    pip install numpy pandas scikit-learn matplotlib seaborn
    (tensorflow optional -- falls back to physics if absent)
"""

import os
import sys
import json
import math
import random
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ── optional tensorflow ───────────────────────────────────────
try:
    import tensorflow as tf
    TF_AVAILABLE = True
except ImportError:
    TF_AVAILABLE = False

# ── optional sklearn ──────────────────────────────────────────
try:
    from sklearn.metrics import (
        accuracy_score, f1_score, confusion_matrix,
        classification_report
    )
    from sklearn.ensemble import RandomForestClassifier
    import joblib
    SK_AVAILABLE = True
except ImportError:
    SK_AVAILABLE = False

# ── paths ─────────────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR   = os.path.join(BASE_DIR, "data")
MODEL_DIR  = os.path.join(BASE_DIR, "models")
RESULT_DIR = os.path.join(BASE_DIR, "results")
os.makedirs(RESULT_DIR, exist_ok=True)

# ── constants ─────────────────────────────────────────────────
EARTH_R_KM    = 6371.0
LEAD_TIMES_H  = [6, 12, 24, 48, 72, 120, 168]   # hours to evaluate
SEED_HOURS    = 48          # hours of history fed as "known"
STEP_H        = 3           # IBTrACS 3-hour resolution
TRAIN_YEARS   = list(range(2013, 2023))   # 80%  →  2013-2022
TEST_YEARS    = list(range(2023, 2027))   # 20%  →  2023-2026

# ── intensity category thresholds (km/h) ─────────────────────
# Class 0 TD | 1 TS | 2 TY | 3 SevTY-3 | 4 SevTY-4 | 5 STY
WIND_BINS  = [0, 63, 88, 118, 150, 185, 9999]
CLASS_NAMES = ["TD", "TS", "TY", "SevTY-3", "SevTY-4", "STY"]


# =============================================================
#  UTILITIES
# =============================================================

def haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance in km."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi       = math.radians(lat2 - lat1)
    dlam       = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return 2 * EARTH_R_KM * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def wind_to_class(wind_kmh):
    """Map wind speed (km/h) to 0-5 intensity class."""
    for i, (lo, hi) in enumerate(zip(WIND_BINS[:-1], WIND_BINS[1:])):
        if lo <= wind_kmh < hi:
            return i
    return 5


def load_year(year):
    """Load wp_YYYY_data.json; return list of storm dicts."""
    path = os.path.join(DATA_DIR, f"wp_{year}_data.json")
    if not os.path.exists(path):
        print(f"  [skip] {path} not found")
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_all_storms(years):
    """Load storms for a list of years."""
    storms = []
    for yr in years:
        for s in load_year(yr):
            path_pts = s.get("path", [])
            # Need at least SEED + 1 valid point
            if len(path_pts) > (SEED_HOURS // STEP_H) + 1:
                storms.append(s)
    return storms


def _parse_float(val, default=0.0):
    """Parse a value that may be a string like '< 35' or '>=64' to float."""
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        import re
        m = re.search(r"[\d.]+", str(val))
        return float(m.group()) if m else default


def path_to_arrays(storm):
    """
    Convert a storm's path list to numpy arrays.
    Returns (lats, lons, winds, pressures, classes) all same length.
    """
    pts = storm["path"]
    lats      = np.array([p["lat"]                        for p in pts], dtype=float)
    lons      = np.array([p["long"]                       for p in pts], dtype=float)
    winds     = np.array([_parse_float(p.get("speed", 0)) for p in pts], dtype=float)
    pressures = np.array([_parse_float(p.get("pressure", 1010)) for p in pts], dtype=float)
    classes   = np.array([int(p.get("class",
                  wind_to_class(_parse_float(p.get("speed", 0))))) for p in pts], dtype=int)
    return lats, lons, winds, pressures, classes


# =============================================================
#  MODE B  –  PHYSICS FALLBACK
#  (kinematic persistence with exponential decay)
# =============================================================

def physics_forecast(seed_lats, seed_lons, n_steps):
    """
    Weighted kinematic persistence.
    Returns arrays of predicted (lat, lon) for n_steps ahead.
    """
    # Compute recent displacement vectors
    dlats = np.diff(seed_lats)
    dlons = np.diff(seed_lons)

    # Exponential decay weights (most recent = highest weight)
    weights = np.exp(np.linspace(0, 2, len(dlats)))
    weights /= weights.sum()

    v_lat = float(np.dot(weights, dlats))
    v_lon = float(np.dot(weights, dlons))

    pred_lats = [seed_lats[-1]]
    pred_lons = [seed_lons[-1]]
    for _ in range(n_steps):
        pred_lats.append(pred_lats[-1] + v_lat)
        pred_lons.append(pred_lons[-1] + v_lon)

    return np.array(pred_lats[1:]), np.array(pred_lons[1:])


# =============================================================
#  MODE A  –  LSTM PATH MODEL  (if available)
# =============================================================

def load_lstm_model():
    """Load LSTM model if available."""
    if not TF_AVAILABLE:
        return None
    for fname in ["typhoon_lstm_model.keras", "typhoon_lstm_model.h5"]:
        path = os.path.join(MODEL_DIR, fname)
        if os.path.exists(path):
            print(f"  [LSTM] Loading {fname}")
            return tf.keras.models.load_model(path)
    print("  [LSTM] No trained model found — using physics engine")
    return None


def normalise_features(seq, scaler_params=None):
    """
    Z-score normalise a feature sequence.
    seq shape: (T, 4)  ->  (lat, lon, pressure, wind)
    Returns normalised seq and scaler params dict.
    """
    if scaler_params is None:
        mean = seq.mean(axis=0)
        std  = seq.std(axis=0) + 1e-8
        scaler_params = {"mean": mean, "std": std}
    else:
        mean = scaler_params["mean"]
        std  = scaler_params["std"]
    return (seq - mean) / std, scaler_params


def lstm_forecast(model, seed_lats, seed_lons,
                  seed_winds, seed_pressures, n_steps,
                  scaler_params=None):
    """
    Autoregressive LSTM rollout for n_steps at 3-hour intervals.
    Input feature order: (lat, lon, pressure, wind).
    """
    T = len(seed_lats)
    seq = np.column_stack([seed_lats, seed_lons,
                           seed_pressures, seed_winds]).astype(float)
    seq_norm, scaler_params = normalise_features(seq, scaler_params)

    pred_lats, pred_lons = [], []
    window = seq_norm.copy()

    for _ in range(n_steps):
        x = window[-T:].reshape(1, T, 4)
        pred_norm = model.predict(x, verbose=0)[0]   # shape (4,) or (2,)

        # Denormalise
        pred = pred_norm * scaler_params["std"] + scaler_params["mean"]

        # Extract lat/lon (first two outputs by convention)
        next_lat = float(pred[0])
        next_lon = float(pred[1])
        pred_lats.append(next_lat)
        pred_lons.append(next_lon)

        # Slide window forward
        new_row = np.array(pred_norm).reshape(1, -1)
        if new_row.shape[1] < 4:
            # Pad missing features with last known values
            padding = window[-1:, new_row.shape[1]:]
            new_row = np.hstack([new_row, padding])
        window = np.vstack([window[1:], new_row])

    return np.array(pred_lats), np.array(pred_lons)


# =============================================================
#  TRACK ERROR EVALUATION
# =============================================================

def evaluate_track(storm, lstm_model, mode_label):
    """
    For one storm, run forecast from the seed window and
    compute position error at each target lead time.
    Returns dict: {lead_h: error_km} or None if insufficient data.
    """
    lats, lons, winds, pressures, classes = path_to_arrays(storm)
    n_pts = len(lats)
    seed_steps = SEED_HOURS // STEP_H        # e.g. 48h / 3h = 16

    if n_pts <= seed_steps + 1:
        return None

    seed_lat = lats[:seed_steps]
    seed_lon = lons[:seed_steps]
    seed_wind = winds[:seed_steps]
    seed_pres = pressures[:seed_steps]

    # Maximum forecast steps we can verify
    max_steps = min(n_pts - seed_steps, max(LEAD_TIMES_H) // STEP_H)
    if max_steps < 2:
        return None

    # Run forecast
    if lstm_model is not None and mode_label == "LSTM":
        try:
            pred_lats, pred_lons = lstm_forecast(
                lstm_model, seed_lat, seed_lon,
                seed_wind, seed_pres, max_steps)
        except Exception as e:
            print(f"    [LSTM error] {e} — falling back to physics")
            pred_lats, pred_lons = physics_forecast(
                seed_lat, seed_lon, max_steps)
    else:
        pred_lats, pred_lons = physics_forecast(
            seed_lat, seed_lon, max_steps)

    errors = {}
    for lead_h in LEAD_TIMES_H:
        step_idx = (lead_h // STEP_H) - 1
        actual_idx = seed_steps + step_idx
        if step_idx >= len(pred_lats) or actual_idx >= n_pts:
            continue
        err = haversine_km(
            pred_lats[step_idx], pred_lons[step_idx],
            lats[actual_idx],    lons[actual_idx]
        )
        errors[lead_h] = err

    return errors


# =============================================================
#  INTENSITY CLASSIFICATION EVALUATION
# =============================================================

def build_classification_dataset(storms):
    """
    Build a flat dataset for intensity classification evaluation.
    For each 3-hourly point (with at least 4 preceding points),
    use the preceding 4 points to predict the current class.

    Features per sample:
        lat, lon, wind, pressure,
        prev_class, delta_wind, delta_pressure, speed_kmh
    """
    X, y = [], []
    for storm in storms:
        lats, lons, winds, pressures, classes = path_to_arrays(storm)
        n = len(lats)
        for i in range(4, n):
            dlat  = lats[i-1]   - lats[i-2]
            dlon  = lons[i-1]   - lons[i-2]
            speed = haversine_km(lats[i-1], lons[i-1],
                                 lats[i-2], lons[i-2]) / (STEP_H)

            features = [
                lats[i-1],
                lons[i-1],
                winds[i-1],
                pressures[i-1],
                float(classes[i-1]),
                winds[i-1]     - winds[i-4],      # 12-h wind trend
                pressures[i-1] - pressures[i-4],   # 12-h pressure trend
                speed,
                float(math.sin(math.radians(((i-1) % 12) / 12 * 360))),  # time-of-day cycle
            ]
            X.append(features)
            y.append(int(classes[i]))

    return np.array(X, dtype=float), np.array(y, dtype=int)


def evaluate_classification(train_storms, test_storms):
    """
    Train a Random Forest intensity classifier on train_storms,
    evaluate on test_storms.
    Returns (y_true, y_pred, report_str).
    """
    if not SK_AVAILABLE:
        print("  [skip] scikit-learn not available")
        return None, None, None

    print("  Building classification dataset...")
    X_train, y_train = build_classification_dataset(train_storms)
    X_test,  y_test  = build_classification_dataset(test_storms)

    if len(X_train) == 0 or len(X_test) == 0:
        print("  [warn] Empty dataset — check JSON files")
        return None, None, None

    print(f"  Train samples: {len(X_train)} | Test samples: {len(X_test)}")

    # Check if pre-trained RF exists
    rf_path = os.path.join(MODEL_DIR, "typhoon_rf_wind_model.pkl")
    if SK_AVAILABLE and os.path.exists(rf_path):
        print(f"  Loading pre-trained RF from {rf_path}")
        clf = joblib.load(rf_path)
    else:
        print("  Training Random Forest classifier (n_estimators=200)...")
        clf = RandomForestClassifier(
            n_estimators=200,
            max_depth=20,
            class_weight="balanced",
            n_jobs=-1,
            random_state=42
        )
        clf.fit(X_train, y_train)
        # Save for reuse
        os.makedirs(MODEL_DIR, exist_ok=True)
        joblib.dump(clf, rf_path.replace("wind_model", "intensity_classifier"))

    y_pred = clf.predict(X_test)
    report = classification_report(
        y_test, y_pred,
        target_names=CLASS_NAMES[:len(set(y_test))],
        zero_division=0
    )
    return y_test, y_pred, report


# =============================================================
#  PLOTTING
# =============================================================

def plot_track_errors(results_ml, results_phys):
    """Bar chart of RMSE and MAE per lead time, both modes."""
    lead_h = sorted({h for r in results_ml + results_phys for h in r.keys()})

    def agg(results, lead):
        vals = [r[lead] for r in results if lead in r]
        if not vals:
            return float("nan"), float("nan")
        arr = np.array(vals)
        return float(np.sqrt(np.mean(arr**2))), float(np.mean(arr))

    rmse_ml   = [agg(results_ml,   h)[0] for h in lead_h]
    mae_ml    = [agg(results_ml,   h)[1] for h in lead_h]
    rmse_phys = [agg(results_phys, h)[0] for h in lead_h]
    mae_phys  = [agg(results_phys, h)[1] for h in lead_h]

    x = np.arange(len(lead_h))
    w = 0.2

    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    fig.suptitle("Track Displacement Error by Lead Time", fontsize=13)

    for ax, (ml_vals, phys_vals, ylabel, title) in zip(
        axes,
        [(rmse_ml, rmse_phys, "RMSE (km)", "Root Mean Square Error"),
         (mae_ml,  mae_phys,  "MAE (km)",  "Mean Absolute Error")]
    ):
        bars1 = ax.bar(x - w, ml_vals,    width=w*1.8, label="LSTM / ML",
                       color="#378ADD", alpha=0.85)
        bars2 = ax.bar(x + w, phys_vals,  width=w*1.8, label="Physics (baseline)",
                       color="#888780", alpha=0.75)
        ax.set_xticks(x)
        ax.set_xticklabels([f"{h}h" for h in lead_h])
        ax.set_xlabel("Forecast lead time")
        ax.set_ylabel(ylabel)
        ax.set_title(title)
        ax.legend()

        # Label bars
        for bar in bars1:
            h_val = bar.get_height()
            if not math.isnan(h_val):
                ax.text(bar.get_x() + bar.get_width()/2, h_val + 2,
                        f"{h_val:.0f}", ha="center", va="bottom", fontsize=8)
        for bar in bars2:
            h_val = bar.get_height()
            if not math.isnan(h_val):
                ax.text(bar.get_x() + bar.get_width()/2, h_val + 2,
                        f"{h_val:.0f}", ha="center", va="bottom", fontsize=8)

    plt.tight_layout()
    out = os.path.join(RESULT_DIR, "track_error_plot.png")
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Saved: {out}")


def plot_confusion_matrix(y_true, y_pred):
    """Heatmap confusion matrix for intensity classification."""
    try:
        import seaborn as sns
    except ImportError:
        sns = None

    labels_present = sorted(set(y_true) | set(y_pred))
    names = [CLASS_NAMES[i] for i in labels_present if i < len(CLASS_NAMES)]
    cm = confusion_matrix(y_true, y_pred, labels=labels_present)
    cm_norm = cm.astype(float) / cm.sum(axis=1, keepdims=True).clip(min=1)

    fig, ax = plt.subplots(figsize=(7, 6))
    if sns:
        sns.heatmap(cm_norm, annot=True, fmt=".2f", cmap="Blues",
                    xticklabels=names, yticklabels=names, ax=ax)
    else:
        im = ax.imshow(cm_norm, cmap="Blues", vmin=0, vmax=1)
        plt.colorbar(im, ax=ax)
        ax.set_xticks(range(len(names)))
        ax.set_yticks(range(len(names)))
        ax.set_xticklabels(names, rotation=45)
        ax.set_yticklabels(names)
        for i in range(len(names)):
            for j in range(len(names)):
                ax.text(j, i, f"{cm_norm[i,j]:.2f}",
                        ha="center", va="center", fontsize=9,
                        color="white" if cm_norm[i,j] > 0.6 else "black")

    ax.set_xlabel("Predicted class")
    ax.set_ylabel("True class")
    ax.set_title("Intensity Classification — Confusion Matrix (normalised)")
    plt.tight_layout()
    out = os.path.join(RESULT_DIR, "confusion_matrix.png")
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Saved: {out}")


# =============================================================
#  SKILL SCORE
# =============================================================

def compute_skill_scores(results_ml, results_phys):
    """
    SS = 1 - RMSE_model / RMSE_baseline
    Positive SS means model beats persistence.
    """
    lead_h = sorted({h for r in results_ml + results_phys for h in r.keys()})
    skills = {}
    for h in lead_h:
        ml_errs   = [r[h] for r in results_ml   if h in r]
        phys_errs = [r[h] for r in results_phys if h in r]
        if not ml_errs or not phys_errs:
            continue
        rmse_ml   = math.sqrt(sum(e**2 for e in ml_errs)   / len(ml_errs))
        rmse_phys = math.sqrt(sum(e**2 for e in phys_errs) / len(phys_errs))
        skills[h] = round(1 - rmse_ml / rmse_phys, 4) if rmse_phys > 0 else 0.0
    return skills


# =============================================================
#  MAIN
# =============================================================

def main():
    print("=" * 60)
    print("  Heads Up — Forecasting Engine Backtester")
    print("=" * 60)

    # 1. Load data
    print("\n[1] Loading IBTrACS JSON files...")
    train_storms = load_all_storms(TRAIN_YEARS)
    test_storms  = load_all_storms(TEST_YEARS)
    print(f"  Train storms: {len(train_storms)}  "
          f"(years {TRAIN_YEARS[0]}-{TRAIN_YEARS[-1]})")
    print(f"  Test  storms: {len(test_storms)}  "
          f"(years {TEST_YEARS[0]}-{TEST_YEARS[-1]})")

    if not test_storms:
        print("\n  [ERROR] No test storms found. "
              "Check that data/wp_2023_data.json etc. exist.")
        sys.exit(1)

    # 2. Load LSTM model if available
    print("\n[2] Checking for trained LSTM model...")
    lstm_model = load_lstm_model()
    mode_label = "LSTM" if lstm_model else "Physics"

    # 3. Track evaluation
    print(f"\n[3] Evaluating track errors ({mode_label} mode)...")
    results_ml, results_phys = [], []
    for i, storm in enumerate(test_storms):
        name = storm.get("name", f"Storm_{i}")
        # ML / primary mode
        err_ml = evaluate_track(storm, lstm_model, mode_label)
        if err_ml:
            results_ml.append(err_ml)
        # Physics baseline (always run for skill score)
        err_phys = evaluate_track(storm, None, "Physics")
        if err_phys:
            results_phys.append(err_phys)

        if (i + 1) % 5 == 0:
            print(f"  Processed {i+1}/{len(test_storms)} storms...")

    print(f"  Valid evaluations: {len(results_ml)} storms")

    # 4. Aggregate track metrics
    print("\n[4] Computing track metrics...")
    lead_h = sorted({h for r in results_ml for h in r.keys()})
    track_metrics = {}
    for h in lead_h:
        ml_errs = [r[h] for r in results_ml if h in r]
        if not ml_errs:
            continue
        arr = np.array(ml_errs)
        track_metrics[h] = {
            "n":    len(arr),
            "rmse": round(float(np.sqrt(np.mean(arr**2))), 2),
            "mae":  round(float(np.mean(arr)), 2),
            "std":  round(float(np.std(arr)), 2),
            "p50":  round(float(np.percentile(arr, 50)), 2),
            "p90":  round(float(np.percentile(arr, 90)), 2),
        }

    # 5. Skill scores
    skill_scores = compute_skill_scores(results_ml, results_phys)

    # 6. Intensity classification
    print("\n[5] Running intensity classification evaluation...")
    y_true, y_pred, clf_report = evaluate_classification(
        train_storms, test_storms)

    # 7. Plots
    print("\n[6] Generating plots...")
    if results_ml and results_phys:
        plot_track_errors(results_ml, results_phys)
    if y_true is not None and y_pred is not None:
        plot_confusion_matrix(y_true, y_pred)

    # 8. Build summary
    print("\n[7] Writing results...")

    summary_lines = []
    summary_lines.append("=" * 60)
    summary_lines.append("  HEADS UP — BACKTEST RESULTS SUMMARY")
    summary_lines.append(f"  Mode: {mode_label}")
    summary_lines.append(f"  Train years: {TRAIN_YEARS[0]}–{TRAIN_YEARS[-1]}")
    summary_lines.append(f"  Test  years: {TEST_YEARS[0]}–{TEST_YEARS[-1]}")
    summary_lines.append(f"  Test storms evaluated: {len(results_ml)}")
    summary_lines.append("=" * 60)
    summary_lines.append("")

    summary_lines.append("TRACK DISPLACEMENT ERROR")
    summary_lines.append("-" * 60)
    header = f"{'Lead':>6}  {'N':>5}  {'RMSE (km)':>10}  "
    header += f"{'MAE (km)':>9}  {'P50 (km)':>9}  {'P90 (km)':>9}  {'Skill':>7}"
    summary_lines.append(header)
    summary_lines.append("-" * 60)
    for h in lead_h:
        if h not in track_metrics:
            continue
        m = track_metrics[h]
        ss = skill_scores.get(h, float("nan"))
        summary_lines.append(
            f"{str(h)+'h':>6}  {m['n']:>5}  {m['rmse']:>10.2f}  "
            f"{m['mae']:>9.2f}  {m['p50']:>9.2f}  {m['p90']:>9.2f}  "
            f"{ss:>7.4f}"
        )
    summary_lines.append("")

    if clf_report:
        summary_lines.append("INTENSITY CLASSIFICATION (Random Forest)")
        summary_lines.append("-" * 60)
        if SK_AVAILABLE and y_true is not None:
            acc = accuracy_score(y_true, y_pred)
            f1  = f1_score(y_true, y_pred, average="macro", zero_division=0)
            summary_lines.append(f"  Overall accuracy : {acc*100:.2f}%")
            summary_lines.append(f"  Macro F1-score   : {f1:.4f}")
        summary_lines.append("")
        summary_lines.append(clf_report)

    summary_lines.append("")
    summary_lines.append("NOTE: Fill these values into the LaTeX")
    summary_lines.append("      Tables 2, 3, 4 (track_perf, wind_perf,")
    summary_lines.append("      class_perf) and replace all [f] placeholders.")
    summary_lines.append("=" * 60)

    summary_text = "\n".join(summary_lines)
    print("\n" + summary_text)

    # Write text file
    txt_path = os.path.join(RESULT_DIR, "backtest_summary.txt")
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(summary_text)
    print(f"\n  Saved summary: {txt_path}")

    # Write JSON
    output_json = {
        "mode":          mode_label,
        "train_years":   TRAIN_YEARS,
        "test_years":    TEST_YEARS,
        "n_test_storms": len(results_ml),
        "track_metrics": track_metrics,
        "skill_scores":  skill_scores,
    }
    if SK_AVAILABLE and y_true is not None:
        output_json["classification"] = {
            "accuracy":  round(float(accuracy_score(y_true, y_pred)), 4),
            "macro_f1":  round(float(f1_score(y_true, y_pred,
                               average="macro", zero_division=0)), 4),
        }

    json_path = os.path.join(RESULT_DIR, "backtest_metrics.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(output_json, f, indent=2)
    print(f"  Saved JSON:    {json_path}")

    print("\n  Done. Copy the numbers from backtest_summary.txt")
    print("  into your LaTeX [f] placeholders.")
    print("=" * 60)


if __name__ == "__main__":
    main()
