"""
AI inference pipeline for the 7-day typhoon forecasting system.

Two operating modes (chosen automatically at runtime):
------------------------------------------------------
MODE A – ML models present (models/ directory contains the files below):
  LSTM  lstm_path_model.h5 / .keras   →  autoregressive path prediction
  RF    rf_wind_model.pkl             →  vectorised U/V wind field

MODE B – No ML models (files missing):
  Kinematic extrapolation (velocity persistence + beta drift + recurvature)
  Rankine vortex wind model (modified, with empirical Rmax from pressure)

Both modes return the identical JSON schema so the frontend is unaffected.

LSTM contract
-------------
  Input  (1, T, 4)  – T = model's input_shape[1]
  Output (1, 4)  or (1, T, 4)  – last time-step used for seq2seq
  Features: [lat_norm, lon_norm, pressure_norm, wind_speed_norm]
  Normalisation: min-max via _NORM dict, or sklearn scaler if present.

RF contract
-----------
  Input  (400, 8)  – one row per PAR grid point
  Output (400, 2)  – [u m/s, v m/s]
  Columns: grid_lat, grid_lon, storm_lat, storm_lon,
           storm_pressure, storm_wind, dist_deg, bearing_rad
"""

import os
import math
import logging
import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
_ROOT       = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR  = os.path.join(_ROOT, "models")
LSTM_PATH   = os.path.join(MODELS_DIR, "lstm_path_model.h5")
LSTM_PATH_K = os.path.join(MODELS_DIR, "lstm_path_model.keras")
RF_PATH     = os.path.join(MODELS_DIR, "rf_wind_model.pkl")
LSTM_SCALER = os.path.join(MODELS_DIR, "lstm_scaler.pkl")
RF_SCALER   = os.path.join(MODELS_DIR, "rf_scaler.pkl")

# ---------------------------------------------------------------------------
# Grid & forecast constants
# ---------------------------------------------------------------------------
PAR_LAT_MIN, PAR_LAT_MAX = 5.0,   25.0
PAR_LON_MIN, PAR_LON_MAX = 115.0, 135.0
GRID_N         = 20
FORECAST_STEPS = 56      # 56 × 3 h = 168 h
STEP_HOURS     = 3
KM_PER_DEG     = 111.0   # km per degree latitude

# ---------------------------------------------------------------------------
# Default min-max normalisation (ML mode only; must match training)
# ---------------------------------------------------------------------------
_NORM = {
    "lat":        (0.0,   45.0),
    "lon":        (95.0, 185.0),
    "pressure":   (870.0, 1020.0),
    "wind_speed": (0.0,   200.0),
}

# ---------------------------------------------------------------------------
# Lazy ML singletons
# ---------------------------------------------------------------------------
_lstm        = None
_rf          = None
_lstm_scaler = None
_rf_scaler   = None

# ---------------------------------------------------------------------------
# Pre-built PAR meshgrid (at import time)
# ---------------------------------------------------------------------------
_lat_1d          = np.linspace(PAR_LAT_MIN, PAR_LAT_MAX, GRID_N)
_lon_1d          = np.linspace(PAR_LON_MIN, PAR_LON_MAX, GRID_N)
_glon_2d, _glat_2d = np.meshgrid(_lon_1d, _lat_1d)   # (20, 20) each
_glat_f          = _glat_2d.ravel()   # (400,)
_glon_f          = _glon_2d.ravel()   # (400,)


# ---------------------------------------------------------------------------
# ML loaders
# ---------------------------------------------------------------------------
def _ml_available() -> bool:
    return any(os.path.exists(p) for p in (LSTM_PATH, LSTM_PATH_K)) and \
           os.path.exists(RF_PATH)


def _load_lstm():
    global _lstm
    if _lstm is not None:
        return _lstm
    import tensorflow as tf
    for path in (LSTM_PATH, LSTM_PATH_K):
        if os.path.exists(path):
            _lstm = tf.keras.models.load_model(path, compile=False)
            logger.info("LSTM loaded: %s  input_shape=%s", path, _lstm.input_shape)
            return _lstm
    raise RuntimeError(f"LSTM not found in {MODELS_DIR}")


def _load_rf():
    global _rf
    if _rf is not None:
        return _rf
    import joblib
    _rf = joblib.load(RF_PATH)
    logger.info("RF loaded: %s", RF_PATH)
    return _rf


def _load_scalers():
    global _lstm_scaler, _rf_scaler
    try:
        import joblib
        if _lstm_scaler is None and os.path.exists(LSTM_SCALER):
            _lstm_scaler = joblib.load(LSTM_SCALER)
        if _rf_scaler is None and os.path.exists(RF_SCALER):
            _rf_scaler   = joblib.load(RF_SCALER)
    except Exception as exc:
        logger.warning("Scaler load failed, using hardcoded ranges: %s", exc)


# ---------------------------------------------------------------------------
# ML helpers
# ---------------------------------------------------------------------------
def _norm(v, key):
    lo, hi = _NORM[key]
    return (float(v) - lo) / (hi - lo)

def _denorm(v, key):
    lo, hi = _NORM[key]
    return float(v) * (hi - lo) + lo

def _prepare_window(history, expected_len):
    if _lstm_scaler is not None:
        raw    = np.array([[float(p["lat"]), float(p["lon"]),
                            float(p["pressure"]), float(p["wind_speed"])]
                           for p in history], dtype=np.float64)
        normed = _lstm_scaler.transform(raw).astype(np.float32)
    else:
        normed = np.array(
            [[_norm(p["lat"], "lat"), _norm(p["lon"], "lon"),
              _norm(p["pressure"], "pressure"), _norm(p["wind_speed"], "wind_speed")]
             for p in history], dtype=np.float32)
    n = len(normed)
    if n >= expected_len:
        seq = normed[-expected_len:]
    else:
        seq = np.concatenate([np.zeros((expected_len - n, 4), np.float32), normed])
    return seq[np.newaxis]   # (1, T, 4)

def _build_rf_features(s_lat, s_lon, s_pres, s_wind):
    dlat    = _glat_f - s_lat
    dlon    = _glon_f - s_lon
    dist    = np.hypot(dlat, dlon).astype(np.float32)
    bearing = np.arctan2(dlon, dlat).astype(np.float32)
    X = np.empty((GRID_N * GRID_N, 8), dtype=np.float32)
    X[:, 0] = _glat_f;  X[:, 1] = _glon_f
    X[:, 2] = np.float32(s_lat);   X[:, 3] = np.float32(s_lon)
    X[:, 4] = np.float32(s_pres);  X[:, 5] = np.float32(s_wind)
    X[:, 6] = dist;     X[:, 7] = bearing
    return X


# ===========================================================================
# PHYSICS ENGINE (Mode B – no ML models required)
# ===========================================================================

def _smooth_velocity(history, look_back: int = 6):
    """
    Return (dlat, dlon, dpres, dwind) per 3-hour step, computed as the
    linear regression slope over the last `look_back` intervals.
    Falls back to simple finite difference if < 3 points available.
    """
    n = len(history)
    lb = min(look_back, n - 1)
    pts = history[-(lb + 1):]

    lats   = np.array([p["lat"]        for p in pts])
    lons   = np.array([p["lon"]        for p in pts])
    pres   = np.array([p["pressure"]   for p in pts])
    winds  = np.array([p["wind_speed"] for p in pts])
    t      = np.arange(len(pts), dtype=float)

    def _slope(y):
        # Least-squares slope through the series
        if len(y) < 2:
            return 0.0
        A  = np.vstack([t, np.ones(len(t))]).T
        m, _ = np.linalg.lstsq(A, y, rcond=None)[0]
        return float(m)

    return _slope(lats), _slope(lons), _slope(pres), _slope(winds)


def _kinematic_path(history, steps: int) -> list:
    """
    Predict storm centre positions via kinematic persistence + beta drift +
    recurvature tendency.

    Beta drift: typical Western Pacific TCs drift 0.5–1.5° poleward and
    slightly westward per day due to the planetary vorticity gradient.
    Recurvature: above ~20°N the subtropical ridge weakens, environmental
    steering shifts NE → the track curves poleward-eastward.
    """
    dlat, dlon, dpres, dwind = _smooth_velocity(history)

    cur_lat  = float(history[-1]["lat"])
    cur_lon  = float(history[-1]["lon"])
    cur_pres = float(history[-1]["pressure"])
    cur_wind = float(history[-1]["wind_speed"])

    # Beta-drift correction per 3-h step (≈ 0.15° poleward/day ÷ 8)
    BETA_LAT = 0.020    # degrees / 3-h step northward
    BETA_LON = -0.008   # degrees / 3-h step westward

    results = []
    for _ in range(steps):
        # Recurvature factor: ramps from 0 at 18°N to 1 at 28°N
        rf = max(0.0, min(1.0, (cur_lat - 18.0) / 10.0))

        # At recurvature, steering becomes NE: reduce westward drift, add eastward
        step_dlat = dlat + BETA_LAT + rf * 0.04
        step_dlon = dlon + BETA_LON + rf * abs(dlon) * 0.5

        cur_lat  = max(-5.0,  min(55.0,  cur_lat  + step_dlat))
        cur_lon  = max(100.0, min(180.0, cur_lon  + step_dlon))

        # Intensification / weakening with physical caps
        # Land-interaction rough check: if lon < 120 and lat 10-20 → weaken
        over_land = (115.0 < cur_lon < 125.0 and 10.0 < cur_lat < 20.0)
        cur_pres  = float(np.clip(cur_pres + dpres + (0.8 if over_land else 0.0),
                                  870.0, 1015.0))
        cur_wind  = float(np.clip(cur_wind + dwind + (-1.0 if over_land else 0.0),
                                  25.0,   185.0))

        # Natural weakening above 30°N (extratropical transition)
        if cur_lat > 30.0:
            cur_pres = min(1015.0, cur_pres + 0.6)
            cur_wind = max(25.0,   cur_wind - 0.8)

        results.append({
            "lat":        round(cur_lat,  4),
            "lon":        round(cur_lon,  4),
            "pressure":   round(cur_pres, 1),
            "wind_speed": round(cur_wind, 1),
        })

    return results


def _rankine_wind_field(storm_lat: float, storm_lon: float,
                        storm_wind_kt: float, storm_pres: float):
    """
    Compute U/V wind components on the PAR grid using a modified Rankine
    vortex with empirical radius-of-maximum-winds from the pressure deficit.

    Vortex profile:
        V(r) = Vmax · (r / Rmax)    for r ≤ Rmax
        V(r) = Vmax · (Rmax / r)^x  for r > Rmax   (x = 0.5, Holland 1980)

    Cyclonic rotation (CCW in Northern Hemisphere):
        radial vector from storm → grid point = (dx, dy)
        CCW tangential direction = (-dy, dx) / |r|
        u = V · (-dy / |r|)
        v = V · ( dx / |r|)

    Background environmental steering (~3 m/s westward, 1 m/s northward)
    is added to approximate mean tropospheric flow.
    """
    Vmax_ms = storm_wind_kt * 0.514444   # knots → m/s

    # Willoughby & Rahn (2004) empirical Rmax (km)
    dp      = max(0.0, 1013.0 - storm_pres)
    Rmax_km = max(15.0, 46.4 * math.exp(-0.0155 * dp + 0.0169 * storm_lat))

    cos_lat = math.cos(math.radians(storm_lat))

    # Grid-relative displacements in km
    dlat_km = (_glat_f - storm_lat) * KM_PER_DEG
    dlon_km = (_glon_f - storm_lon) * KM_PER_DEG * cos_lat
    dist_km = np.hypot(dlat_km, dlon_km)
    dist_km = np.maximum(dist_km, 0.5)   # avoid singularity at eye

    # Modified Rankine profile (Holland exponent x = 0.5 outside Rmax)
    inside  = dist_km <= Rmax_km
    V = np.where(
        inside,
        Vmax_ms * (dist_km / Rmax_km),
        Vmax_ms * np.sqrt(Rmax_km / dist_km)
    ).astype(np.float32)

    # CCW tangential wind (Northern Hemisphere cyclone)
    dx = dlon_km   # east  component of radial vector
    dy = dlat_km   # north component
    inv_r = 1.0 / dist_km

    u_cyc = V * (-dy * inv_r)   # westward N of storm, eastward S of storm ✓
    v_cyc = V * ( dx * inv_r)   # northward E of storm, southward W of storm ✓

    # Add a simple background environmental steering flow
    u_env = -3.0   # m/s  (mean westward trade-wind steering)
    v_env =  0.8   # m/s  (slight poleward Hadley-cell component)

    u_total = (u_cyc + u_env).reshape(GRID_N, GRID_N).tolist()
    v_total = (v_cyc + v_env).reshape(GRID_N, GRID_N).tolist()
    return u_total, v_total


def _run_physics_forecast(history: list, steps: int) -> dict:
    """Physics-only forecast (no ML). Returns same schema as run_forecast()."""
    logger.info("Using physics-based forecast engine (no ML models found).")
    path = _kinematic_path(history, steps)
    forecast_steps = []
    for i, p in enumerate(path):
        u, v = _rankine_wind_field(p["lat"], p["lon"],
                                   p["wind_speed"], p["pressure"])
        forecast_steps.append({
            "hour":       (i + 1) * STEP_HOURS,
            "lat":        p["lat"],
            "lon":        p["lon"],
            "pressure":   p["pressure"],
            "wind_speed": p["wind_speed"],
            "u":          u,
            "v":          v,
            "method":     "physics",
        })
    return {
        "grid": {
            "lats": _glat_2d.tolist(),
            "lons": _glon_2d.tolist(),
        },
        "forecast_steps": forecast_steps,
        "method": "physics",
    }


# ===========================================================================
# ML FORECAST (Mode A)
# ===========================================================================

def _run_ml_forecast(history: list, steps: int) -> dict:
    """ML-based forecast via LSTM path + RF wind field."""
    _load_scalers()
    lstm = _load_lstm()
    rf   = _load_rf()

    expected_len = lstm.input_shape[1]
    window       = _prepare_window(history, expected_len)   # (1, T, 4)

    forecast_steps = []
    for step in range(steps):
        raw = lstm.predict(window, verbose=0)
        if raw.ndim == 3:
            raw = raw[:, -1, :]
        pred_norm = np.clip(raw[0], 0.0, 1.0).astype(np.float32)

        if _lstm_scaler is not None:
            phys      = _lstm_scaler.inverse_transform(pred_norm.reshape(1, 4))[0]
            pred_lat, pred_lon   = float(phys[0]), float(phys[1])
            pred_pres, pred_wind = float(phys[2]), float(phys[3])
        else:
            pred_lat  = _denorm(pred_norm[0], "lat")
            pred_lon  = _denorm(pred_norm[1], "lon")
            pred_pres = _denorm(pred_norm[2], "pressure")
            pred_wind = _denorm(pred_norm[3], "wind_speed")

        X_rf = _build_rf_features(pred_lat, pred_lon, pred_pres, pred_wind)
        if _rf_scaler is not None:
            X_rf = _rf_scaler.transform(X_rf).astype(np.float32)

        uv = rf.predict(X_rf)
        if uv.ndim == 1:
            u_flat, v_flat = uv.ravel(), np.zeros_like(uv)
        elif uv.shape[1] == 1:
            u_flat, v_flat = uv[:, 0], np.zeros(GRID_N * GRID_N, np.float32)
        else:
            u_flat, v_flat = uv[:, 0], uv[:, 1]

        window = np.concatenate(
            [window[:, 1:, :], pred_norm.reshape(1, 1, 4)], axis=1)

        forecast_steps.append({
            "hour":       (step + 1) * STEP_HOURS,
            "lat":        round(pred_lat,  4),
            "lon":        round(pred_lon,  4),
            "pressure":   round(pred_pres, 1),
            "wind_speed": round(pred_wind, 1),
            "u":          u_flat.reshape(GRID_N, GRID_N).tolist(),
            "v":          v_flat.reshape(GRID_N, GRID_N).tolist(),
            "method":     "ml",
        })

    return {
        "grid": {
            "lats": _glat_2d.tolist(),
            "lons": _glon_2d.tolist(),
        },
        "forecast_steps": forecast_steps,
        "method": "ml",
    }


# ===========================================================================
# PUBLIC API
# ===========================================================================

def run_forecast(track_history: list, steps: int = FORECAST_STEPS) -> dict:
    """
    Run the 7-day typhoon forecast.

    Automatically selects Mode A (ML) when trained model files exist in
    models/, otherwise falls back to Mode B (physics engine).

    Parameters
    ----------
    track_history : list[dict]
        Each dict: lat (°N), lon (°E), pressure (hPa), wind_speed (knots).
        Minimum 2 points; ≥ 8 recommended for stable kinematic extrapolation.
    steps : int
        Number of 3-hour steps (default 56 → 168 h).

    Returns
    -------
    dict
        grid            – fixed PAR meshgrid (lats, lons) – returned once
        forecast_steps  – list of step dicts (hour, lat, lon, pressure,
                          wind_speed, u[20×20], v[20×20], method)
        method          – "ml" or "physics"
    """
    if _ml_available():
        try:
            return _run_ml_forecast(track_history, steps)
        except Exception as exc:
            logger.warning("ML forecast failed (%s); falling back to physics.", exc)

    return _run_physics_forecast(track_history, steps)
