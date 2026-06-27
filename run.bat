@echo off
REM Storm Forecasting - Automatic Installation and Run Script (Windows)
REM This script installs requirements and starts the web application

REM Keep window open on errors
setlocal enabledelayedexpansion

REM Change to the directory where this batch file is located
cd /d "%~dp0"

echo.
echo ================================================
echo   Storm Forecasting - Installation and Startup
echo ================================================
echo Current directory: %CD%
echo.

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH
    echo Please install Python 3.7 or higher from https://www.python.org/
    echo.
    echo Press any key to exit...
    pause
    exit /b 1
)

echo [OK] Python found
python --version
echo.

REM Check if pip is installed
python -m pip --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] pip is not installed
    echo Please install pip first
    echo.
    echo Press any key to exit...
    pause
    exit /b 1
)

echo [OK] pip found
echo.

REM Install requirements
echo [INFO] Installing requirements...
echo This may take a few minutes...
echo.

python -m pip install -r requirements.txt

if errorlevel 1 (
    echo.
    echo [ERROR] Failed to install requirements
    echo Please check the error messages above
    echo.
    echo Press any key to exit...
    pause
    exit /b 1
)

echo.
echo [OK] Requirements installed successfully!
echo.

REM Check if map exists
if not exist "resources\western_pacific_detailed_map.png" (
    echo [WARNING] Map file not found!
    echo Generating map (this may take a few minutes)...
    echo.
    
    python scripts\map_maker.py
    
    if errorlevel 1 (
        echo.
        echo [ERROR] Failed to generate map
        echo Please run 'python scripts\map_maker.py' manually
        echo.
        echo Press any key to exit...
        pause
        exit /b 1
    )
    
    echo.
    echo [OK] Map generated successfully!
    echo.
)

REM Start the Flask application
echo [INFO] Starting Storm Forecasting web application...
echo.
echo The application will be available at: http://localhost:5000
echo Press Ctrl+C to stop the server
echo.
echo ================================================
echo.

REM Run Flask app
echo Starting Flask application...
python app.py

REM Always pause before closing - this is critical
REM Use errorlevel check instead of variable to avoid syntax issues
echo.
echo ================================================
if errorlevel 1 (
    echo [ERROR] Application encountered an error.
) else (
    echo [INFO] Application has stopped normally.
)
echo ================================================
echo.
echo IMPORTANT: This window will stay open.
echo Press any key to close this window...
pause

