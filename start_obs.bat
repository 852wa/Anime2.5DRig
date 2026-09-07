@echo off
setlocal
cd /d "%~dp0"
if defined ANIME25D_PYTHON (
  "%ANIME25D_PYTHON%" -c "import sys; assert sys.version_info.major == 3" >nul 2>nul
  if not errorlevel 1 (
    start "Anime2.5DRig OBS Server" /min "%ANIME25D_PYTHON%" obs_server.py --open-browser --camera
    goto started
  )
)
py -3 -c "import sys" >nul 2>nul
if not errorlevel 1 (
  start "Anime2.5DRig OBS Server" /min py -3 obs_server.py --open-browser --camera
  goto started
)
python -c "import sys; assert sys.version_info.major == 3" >nul 2>nul
if not errorlevel 1 (
  start "Anime2.5DRig OBS Server" /min python obs_server.py --open-browser --camera
  goto started
)
echo Python 3 was not found. Install Python 3 from https://www.python.org/
echo Or set ANIME25D_PYTHON to the full path of an existing python.exe.
pause
exit /b 1
:started
echo OBS Browser Source URL: http://127.0.0.1:8000/?obs=1^&cam=1
echo Allow camera access in the opened browser window and keep it open.
echo Keep the server window running while OBS is using the avatar.
pause
