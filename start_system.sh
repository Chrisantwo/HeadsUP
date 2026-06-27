#!/usr/bin/env bash
set -euo pipefail

# One-click setup + run for Storm Forecasting (Linux/macOS/Git Bash)
cd "$(dirname "$0")"

echo "=============================================="
echo "Storm Forecasting - Setup and Start (Unix)"
echo "=============================================="

if command -v python3 >/dev/null 2>&1; then
  PY_CMD="python3"
elif command -v python >/dev/null 2>&1; then
  PY_CMD="python"
else
  echo "Python not found. Please install Python 3."
  exit 1
fi

if [[ ! -f ".venv/bin/python" ]]; then
  echo "[1/4] Creating virtual environment..."
  "$PY_CMD" -m venv .venv
fi

echo "[2/4] Activating virtual environment..."
# shellcheck disable=SC1091
source ".venv/bin/activate"

echo "[3/4] Installing Python dependencies..."
python -m pip install --upgrade pip
if [[ -f "requirements_web.txt" ]]; then
  echo "Using requirements_web.txt (web-only compatible set)..."
  python -m pip install -r requirements_web.txt
else
  python -m pip install -r requirements.txt
fi

echo "[4/4] Starting Flask app..."
echo "Open: http://localhost:5000"
python app.py
