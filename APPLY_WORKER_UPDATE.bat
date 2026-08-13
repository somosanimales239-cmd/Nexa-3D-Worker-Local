@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 apply_worker_update.py
) else (
  python apply_worker_update.py
)
if errorlevel 1 (
  echo.
  echo UPDATE FAILED. Nothing should be built until the error above is fixed.
  pause
  exit /b 1
)
echo.
echo Worker source update completed.
echo Run: npm run validate
pause
