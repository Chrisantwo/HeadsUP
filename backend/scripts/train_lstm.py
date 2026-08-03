"""
Train the LSTM path model for the HeadsUp 7-day typhoon forecast.

Produces, in backend/models/:
    lstm_path_model.keras   – Keras model (primary; loaded by ai_models.py)
    lstm_path_model.h5      – same model, .h5 fallback path
    lstm_scaler.pkl         – sklearn MinMaxScaler used at train + inference time

The output matches the Mode-A contract in ai_models.py exactly:
    input  (1, T, 4)  features [lat, lon, pressure, wind_speed]
    output (1, 4)     next-step [lat, lon, pressure, wind_speed]

Run once from the backend directory:
    python scripts/train_lstm.py
"""

import os
import re
import json
import math
import numpy as np

# --------------------------------------------------------------------------
# Paths (mirror ai_models.py / backtest.py layout)
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
FEATURES      = ("lat", "lon", "pressure", "wind_speed")
EARTH_R_KM    = 6371.0
EPOCHS        = 80
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
    pts = storm.get("path", [])
    rows = []
    for p in pts:
        lat  = _parse_float(p.get("lat"))
        lon  = _parse_float(p.get("long"))
        pres = _parse_float(p.get("pressure", 1010), 1010.0)
        wind = _parse_float(p.get("speed", 0), 0.0)
        # Skip obviously invalid points
        if lat == 0.0 and lon == 0.0:
            continue
        rows.append([lat, lon, pres, wind])
    return np.array(rows, dtype=np.float64)


def _load_sequences(years):
    """Return a list of (N, 4) storm sequences for the given years."""
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

    # ---- Fit MinMaxScaler on TRAIN features only -------------------------
    from sklearn.preprocessing import MinMaxScaler
    import joblib

    scaler = MinMaxScaler()
    flat_train = X_train_raw.reshape(-1, 4)      # (M*T, 4)
    scaler.fit(flat_train)

    def _scale_X(X):
        return scaler.transform(X.reshape(-1, 4)).reshape(X.shape).astype(np.float32)

    def _scale_y(yv):
        return scaler.transform(yv).astype(np.float32)

    X_train = _scale_X(X_train_raw)
    y_train = _scale_y(y_train_raw)
    X_val   = _scale_X(X_val_raw)   if len(X_val_raw)   else X_train[:0]
    y_val   = _scale_y(y_val_raw)   if len(y_val_raw)   else y_train[:0]

    # ---- Build model -----------------------------------------------------
    # Residual formulation: the LSTM predicts the *displacement* from the last
    # known (normalised) state, and an Add layer reconstructs the absolute
    # next-step state. This keeps the ai_models.py Mode-A contract (model still
    # outputs absolute normalised [lat, lon, pressure, wind]) while giving the
    # network the far easier job of learning a small delta -> it starts at
    # persistence accuracy and improves from there.
    # Cropping1D (not Lambda) extracts the last timestep so the model
    # deserialises cleanly under Keras 3 safe_mode (ai_models.py loads with
    # tf.keras.models.load_model).
    import tensorflow as tf
    tf.random.set_seed(SEED)
    from tensorflow.keras import layers, Model

    inp   = layers.Input(shape=(T, 4))
    last  = layers.Cropping1D(cropping=(T - 1, 0))(inp)   # keep final timestep
    last  = layers.Flatten()(last)                        # (batch, 4)
    x     = layers.LSTM(64)(inp)
    x     = layers.Dropout(0.2)(x)
    x     = layers.Dense(32, activation="relu")(x)
    delta = layers.Dense(4)(x)                            # displacement
    out   = layers.Add()([last, delta])                   # absolute next-step
    model = Model(inp, out)
    model.compile(optimizer="adam", loss="mse", metrics=["mae"])
    model.summary()

    callbacks = [
        tf.keras.callbacks.EarlyStopping(
            monitor="val_loss" if len(X_val) else "loss",
            patience=8, restore_best_weights=True),
    ]

    print("\nTraining...")
    model.fit(
        X_train, y_train,
        validation_data=(X_val, y_val) if len(X_val) else None,
        epochs=EPOCHS, batch_size=BATCH_SIZE,
        callbacks=callbacks, verbose=2,
    )

    # ---- Save artifacts --------------------------------------------------
    keras_path  = os.path.join(MODEL_DIR, "lstm_path_model.keras")
    h5_path     = os.path.join(MODEL_DIR, "lstm_path_model.h5")
    scaler_path = os.path.join(MODEL_DIR, "lstm_scaler.pkl")

    model.save(keras_path)
    model.save(h5_path)
    joblib.dump(scaler, scaler_path)
    print(f"\nSaved:\n  {keras_path}\n  {h5_path}\n  {scaler_path}")

    # ---- Held-out next-step track error (km) -----------------------------
    if len(X_val):
        pred_norm = model.predict(X_val, verbose=0)
        pred = scaler.inverse_transform(pred_norm)          # back to physical
        true = y_val_raw
        km = _haversine_km(true[:, 0], true[:, 1], pred[:, 0], pred[:, 1])
        print("\nHeld-out next-step (3h) track error:")
        print(f"  MAE  : {km.mean():8.2f} km")
        print(f"  RMSE : {math.sqrt((km**2).mean()):8.2f} km")
        print(f"  P50  : {np.percentile(km, 50):8.2f} km")
        print(f"  P90  : {np.percentile(km, 90):8.2f} km")


def _haversine_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    dphi = lat2 - lat1
    dlam = lon2 - lon1
    a = np.sin(dphi/2)**2 + np.cos(lat1)*np.cos(lat2)*np.sin(dlam/2)**2
    return 2 * EARTH_R_KM * np.arcsin(np.sqrt(a))


if __name__ == "__main__":
    main()
