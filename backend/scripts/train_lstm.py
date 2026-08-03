"""
Train the LSTM path model for the HeadsUp 7-day typhoon forecast.

HYBRID design — "LSTM corrects physics" (residual-over-physics):
    next_state = persistence_step(window) + LSTM_correction(window)

The LSTM is trained to predict the *residual* that the exponentially-weighted
persistence baseline leaves behind, NOT the absolute next position. At inference
(ai_models.py) the same persistence_step carries the trajectory and the LSTM
only nudges it, so the autoregressive rollout cannot drift far worse than
persistence — which fixes the compounding-error problem of a plain LSTM.

Produces, in backend/models/:
    lstm_path_model.keras    – maps normalised (1,T,4) window -> normalised (4,) residual
    lstm_path_model.h5       – same model, .h5 fallback path
    lstm_scaler.pkl          – MinMaxScaler for the INPUT features
    lstm_resid_scaler.pkl    – StandardScaler for the residual target
    lstm_meta.json           – {"mode": "residual_over_physics", "T": ...}

persistence_step() is imported from ai_models so training and inference use the
IDENTICAL physics baseline. Run once from the backend directory:
    python scripts/train_lstm.py
"""

import os
import re
import json
import math
import numpy as np

# ai_models lives beside this script; import it for the shared persistence step.
import ai_models

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------
BASE_DIR  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR  = os.path.join(BASE_DIR, "data")
MODEL_DIR = os.path.join(BASE_DIR, "models")
os.makedirs(MODEL_DIR, exist_ok=True)

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
T             = 8                       # input steps (8 x 3h = 24h of history)
TRAIN_YEARS   = list(range(2013, 2023)) # 2013-2022
VAL_YEARS     = list(range(2023, 2026)) # 2023-2025 (held out)
EARTH_R_KM    = 6371.0
EPOCHS        = 120
BATCH_SIZE    = 128
SEED          = 42


# --------------------------------------------------------------------------
# Data parsing (same semantics as backtest.py: 'speed' can be '< 35' etc.)
# --------------------------------------------------------------------------
def _parse_float(val, default=0.0):
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        m = re.search(r"[\d.]+", str(val))
        return float(m.group()) if m else default


def _load_year(year):
    path = os.path.join(DATA_DIR, f"wp_{year}_data.json")
    if not os.path.exists(path):
        print(f"  [skip] {path} not found")
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _storm_to_seq(storm):
    """Convert one storm's path to an (N, 4) array [lat, lon, pressure, wind]."""
    rows = []
    for p in storm.get("path", []):
        lat  = _parse_float(p.get("lat"))
        lon  = _parse_float(p.get("long"))
        pres = _parse_float(p.get("pressure", 1010), 1010.0)
        wind = _parse_float(p.get("speed", 0), 0.0)
        if lat == 0.0 and lon == 0.0:
            continue
        rows.append([lat, lon, pres, wind])
    return np.array(rows, dtype=np.float64)


def _load_sequences(years):
    seqs = []
    for yr in years:
        for storm in _load_year(yr):
            seq = _storm_to_seq(storm)
            if len(seq) >= T + 1:
                seqs.append(seq)
    return seqs


def _make_windows(seqs):
    """Slice storm sequences into (X, y): X (M, T, 4), y (M, 4) next-step."""
    X, y = [], []
    for seq in seqs:
        for i in range(len(seq) - T):
            X.append(seq[i:i + T])
            y.append(seq[i + T])
    return np.asarray(X, dtype=np.float64), np.asarray(y, dtype=np.float64)


def _persistence_batch(X):
    """persistence_step applied to every window in X -> (M, 4) baseline preds."""
    return np.array([ai_models.persistence_step(w) for w in X], dtype=np.float64)


def _haversine_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    dphi = lat2 - lat1
    dlam = lon2 - lon1
    a = np.sin(dphi/2)**2 + np.cos(lat1)*np.cos(lat2)*np.sin(dlam/2)**2
    return 2 * EARTH_R_KM * np.arcsin(np.sqrt(a))


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main():
    np.random.seed(SEED)

    print("Loading storm sequences...")
    train_seqs = _load_sequences(TRAIN_YEARS)
    val_seqs   = _load_sequences(VAL_YEARS)
    print(f"  train storms: {len(train_seqs)} | val storms: {len(val_seqs)}")

    X_train_raw, y_train_raw = _make_windows(train_seqs)
    X_val_raw,   y_val_raw   = _make_windows(val_seqs)
    print(f"  train windows: {len(X_train_raw)} | val windows: {len(X_val_raw)}")
    if len(X_train_raw) == 0:
        raise SystemExit("No training windows produced — check data files.")

    # ---- Physics baseline + residual targets -----------------------------
    phys_train = _persistence_batch(X_train_raw)          # (M, 4)
    phys_val   = _persistence_batch(X_val_raw) if len(X_val_raw) else phys_train[:0]
    resid_train = y_train_raw - phys_train                # LSTM learns this
    resid_val   = (y_val_raw - phys_val) if len(X_val_raw) else resid_train[:0]

    # ---- Scalers: MinMax for inputs, Standard for residual target --------
    from sklearn.preprocessing import MinMaxScaler, StandardScaler
    import joblib

    in_scaler = MinMaxScaler().fit(X_train_raw.reshape(-1, 4))
    rs_scaler = StandardScaler().fit(resid_train)

    def _scale_X(X):
        return in_scaler.transform(X.reshape(-1, 4)).reshape(X.shape).astype(np.float32)

    X_train = _scale_X(X_train_raw)
    y_train = rs_scaler.transform(resid_train).astype(np.float32)
    X_val   = _scale_X(X_val_raw)                if len(X_val_raw) else X_train[:0]
    y_val   = rs_scaler.transform(resid_val).astype(np.float32) if len(X_val_raw) else y_train[:0]

    # ---- Model: window -> normalised residual ----------------------------
    import tensorflow as tf
    tf.random.set_seed(SEED)
    from tensorflow.keras import layers, models

    model = models.Sequential([
        layers.Input(shape=(T, 4)),
        layers.LSTM(64),
        layers.Dropout(0.2),
        layers.Dense(32, activation="relu"),
        layers.Dense(4),               # normalised residual [dlat, dlon, dpres, dwind]
    ])
    model.compile(optimizer="adam", loss="mse", metrics=["mae"])
    model.summary()

    callbacks = [
        tf.keras.callbacks.EarlyStopping(
            monitor="val_loss" if len(X_val) else "loss",
            patience=10, restore_best_weights=True),
    ]

    print("\nTraining (residual-over-physics)...")
    model.fit(
        X_train, y_train,
        validation_data=(X_val, y_val) if len(X_val) else None,
        epochs=EPOCHS, batch_size=BATCH_SIZE,
        callbacks=callbacks, verbose=2,
    )

    # ---- Save artifacts --------------------------------------------------
    keras_path  = os.path.join(MODEL_DIR, "lstm_path_model.keras")
    h5_path     = os.path.join(MODEL_DIR, "lstm_path_model.h5")
    in_path     = os.path.join(MODEL_DIR, "lstm_scaler.pkl")
    rs_path     = os.path.join(MODEL_DIR, "lstm_resid_scaler.pkl")
    meta_path   = os.path.join(MODEL_DIR, "lstm_meta.json")

    model.save(keras_path)
    model.save(h5_path)
    joblib.dump(in_scaler, in_path)
    joblib.dump(rs_scaler, rs_path)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump({
            "mode":               "residual_over_physics",
            "T":                  T,
            "features":           ["lat", "lon", "pressure", "wind_speed"],
            "persist_weight_span": ai_models.PERSIST_WEIGHT_SPAN,
            "train_years":        [TRAIN_YEARS[0], TRAIN_YEARS[-1]],
            "val_years":          [VAL_YEARS[0], VAL_YEARS[-1]],
        }, f, indent=2)
    print(f"\nSaved:\n  {keras_path}\n  {h5_path}\n  {in_path}\n  {rs_path}\n  {meta_path}")

    # ---- Held-out next-step track error ----------------------------------
    if len(X_val):
        resid_pred = rs_scaler.inverse_transform(model.predict(X_val, verbose=0))
        hybrid = phys_val + resid_pred                    # physics + correction
        km_hybrid = _haversine_km(y_val_raw[:, 0], y_val_raw[:, 1],
                                  hybrid[:, 0],     hybrid[:, 1])
        km_phys   = _haversine_km(y_val_raw[:, 0], y_val_raw[:, 1],
                                  phys_val[:, 0],   phys_val[:, 1])
        print("\nHeld-out next-step (3h) track error:")
        print(f"  Persistence : MAE {km_phys.mean():7.2f} km | RMSE {math.sqrt((km_phys**2).mean()):7.2f}")
        print(f"  Hybrid LSTM : MAE {km_hybrid.mean():7.2f} km | RMSE {math.sqrt((km_hybrid**2).mean()):7.2f}"
              f" | P50 {np.percentile(km_hybrid,50):.2f} | P90 {np.percentile(km_hybrid,90):.2f}")
        skill = 1 - math.sqrt((km_hybrid**2).mean()) / math.sqrt((km_phys**2).mean())
        print(f"  Single-step skill vs persistence: {skill:+.4f}  "
              f"({'LSTM wins' if skill > 0 else 'persistence wins'})")


if __name__ == "__main__":
    main()
