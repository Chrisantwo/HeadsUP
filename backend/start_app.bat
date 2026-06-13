@echo off
REM Storm Forecasting - Launcher Script
REM This script ensures the window stays open

REM Change to script directory
cd /d "%~dp0"

REM Run the main script and keep window open
call run.bat

REM This ensures window stays open even if run.bat exits
if errorlevel 1 (
    echo.
    echo Script ended with errors. Check messages above.
) else (
    echo.
    echo Script completed successfully.
)

echo.
echo Press any key to close this window...
pause >nul

