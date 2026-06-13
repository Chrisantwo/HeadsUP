@echo off
setlocal

REM One-click setup + run for Storm Forecasting (Windows)
cd /d "%~dp0"

echo ==============================================
echo Storm Forecasting - Setup and Start (Windows)
echo ==============================================

where py >nul 2>&1
if %errorlevel%==0 (
    set "PY_CMD=py -3"
) else (
    set "PY_CMD=python"
)

if not exist ".venv\Scripts\python.exe" (
    echo [1/4] Creating virtual environment...
    %PY_CMD% -m venv .venv
    if errorlevel 1 (
        echo Failed to create virtual environment.
        pause
        exit /b 1
    )
)

echo [2/4] Activating virtual environment...
call ".venv\Scripts\activate.bat"
if errorlevel 1 (
    echo Failed to activate virtual environment.
    pause
    exit /b 1
)

echo [3/4] Installing Python dependencies...
python -m pip install --upgrade pip
set "REQ_FILE=requirements.txt"
if exist "requirements_web.txt" set "REQ_FILE=requirements_web.txt"
echo Using %REQ_FILE%
python -m pip install -r "%REQ_FILE%"
if errorlevel 1 (
    echo Dependency installation failed.
    echo.
    echo Tip: This project web app works with requirements_web.txt
    echo and avoids desktop/manim packages incompatible with Python 3.13.
    pause
    exit /b 1
)

echo [4/4] Starting Flask app...
echo Open: http://localhost:5000
start "" "http://localhost:5000"
python app.py

echo App exited.
pause
