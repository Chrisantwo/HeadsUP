@echo off
REM Storm Forecasting - Main Launcher
REM This ensures the command window stays open

REM Change to the script's directory
cd /d "%~dp0"

REM Run the script in a new window that stays open using /k (keep open)
REM The /k flag keeps the command prompt open after the script finishes
start "Storm Forecasting" cmd /k "cd /d %~dp0 && run.bat"

REM Exit this launcher (the new window will stay open)
exit

