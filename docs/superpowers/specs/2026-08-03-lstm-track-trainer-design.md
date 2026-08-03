# LSTM Track-Prediction Trainer — Design

**Date:** 2026-08-03
**Status:** Approved

## Goal

Train a real LSTM path model so the HeadsUp forecast runtime switches from the
physics fallback (Mode B) to the ML engine (Mode A). The output must match the
exact contract `backend/scripts/ai_models.py` already expects, so **no runtime
code changes** are required — dropping the model files into `backend/models/`
flips `run_forecast()` from `"method": "physics"` to `"method": "ml"`.

## Contract (from ai_models.py, Mode A)

- Model file: `backend/models/lstm_path_model.keras` (and `.h5` for the fallback path).
- Optional scaler: `backend/models/lstm_scaler.pkl` (sklearn scaler). If present,
  `_prepare_window` / inference use it via `transform` / `inverse_transform`.
- Input shape: `(1, T, 4)`, features ordered `[lat, lon, pressure, wind_speed]`.
- Output shape: `(1, 4)` — next-step `[lat, lon, pressure, wind_speed]`.
- `T` is read at runtime from `model.input_shape[1]`, so the trainer chooses `T`.

## New file

`backend/scripts/train_lstm.py` — standalone, run once.

## Data pipeline

- Source: `backend/data/wp_YYYY_data.json`, each a list of storms with a `path`
  of 3-hourly points (`lat`, `long`, `pressure`, `speed`, `class`).
- Reuse backtest.py's parsing semantics: `speed` may be a string like `'< 35'`
  and `pressure` may be a string; parse with the same regex-based float parser.
- Split (mirrors the RF backtest for a consistent thesis story):
  - Train: `wp_2013`–`wp_2022`
  - Held-out validation: `wp_2023`–`wp_2025`
- Windowing: for each storm sequence of `[lat, lon, pressure, wind]`, build
  sliding windows of `T=8` input steps (24 h of history) → target = the next
  step's 4 features. Drop storms with fewer than `T+1` valid points.

## Normalization

- Fit a single sklearn `MinMaxScaler` on **training** features only.
- Save as `lstm_scaler.pkl`. This guarantees train/inference consistency and
  overrides the hardcoded `_NORM` min-max ranges in ai_models.py.

## Model

- `Input(T, 4)` → `LSTM(64)` → `Dropout(0.2)` → `Dense(32, relu)` → `Dense(4)`
- Loss: MSE. Optimizer: Adam. `EarlyStopping` on validation loss.
- Small enough to train on CPU in minutes.

## Outputs & verification

- Write `lstm_path_model.keras`, `lstm_path_model.h5`, and `lstm_scaler.pkl`
  into `backend/models/`.
- Report held-out next-step track error (mean km via haversine) for the paper.
- After training, call `ai_models.run_forecast(...)` on a sample track and
  confirm it returns `"method": "ml"`.

## Scope / honesty notes

- This LSTM predicts the **track + intensity state** (lat, lon, pressure, wind).
- The existing `typhoon_rf_intensity_classifier.pkl` remains the **intensity
  classifier** (Random Forest). After this change both claims hold:
  **LSTM = track, Random Forest = intensity.**
- `rf_wind_model.pkl` (per-grid wind field) is still absent, so the wind-field
  rendering continues to use the Rankine-vortex physics. Describe it as such;
  do not claim RF produces the wind field.

## Out of scope

- Training a per-grid RF wind-field model.
- Any change to the frontend or Flask routes.
- Hyperparameter search beyond sensible defaults.
