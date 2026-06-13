@echo off
REM Storm Forecasting - Simple Launcher
REM This opens a new command window that will stay open

cd /d "%~dp0"
start "Storm Forecasting" cmd /k "cd /d %~dp0 && python -m pip install -r requirements.txt && python app.py && pause"

