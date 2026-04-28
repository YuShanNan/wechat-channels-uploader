@echo off
setlocal enabledelayedexpansion
title Video Uploader

echo ==============================================
echo    Video Uploader v1.0
echo ==============================================
echo.
echo Checking environment...
echo.

cd /d "%~dp0"

call :check_node   || goto :die
call :check_deps   || goto :die
call :check_chrome
call :check_ffprobe
call :check_dirs
call :check_port   || goto :die

echo.
echo ==============================================
echo    All checks passed, starting...
echo ==============================================
echo.

if defined CHROME_PATH (
    start "" "!CHROME_PATH!" "http://localhost:3000"
) else (
    start "" "http://localhost:3000"
)

echo Access: http://localhost:3000
echo Press Ctrl+C to stop
echo.

node server.js

echo.
echo Server stopped.
pause
exit /b 0

:die
echo.
echo ==============================================
echo    Startup failed!
echo    Fix the issues above and retry.
echo ==============================================
pause
exit /b 1

rem --------------------------------------------------
rem  Node.js check
rem --------------------------------------------------
:check_node
echo [....] Checking Node.js...

where node >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Node.js not found.
    echo.
    echo   Please install Node.js 18 or later:
    echo   https://nodejs.org/
    echo.
    exit /b 1
)

for /f %%a in ('node -e "console.log(process.versions.node.split('.')[0])" 2^>nul') do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR (
    echo [FAIL] Cannot determine Node.js version.
    exit /b 1
)

if !NODE_MAJOR! LSS 18 (
    echo [FAIL] Detected Node.js v!NODE_MAJOR!, need v18 or later.
    echo   Download LTS: https://nodejs.org/
    exit /b 1
)

echo [ OK ] Node.js v!NODE_MAJOR!
goto :eof

rem --------------------------------------------------
rem  npm dependencies check
rem --------------------------------------------------
:check_deps
echo [....] Checking npm dependencies...

for %%p in (express playwright ws csv-parse) do (
    if not exist "node_modules\%%p\package.json" (
        echo [INFO] Dependencies missing, installing...
        goto :install_deps
    )
)

for %%a in ("%~dp0package.json") do set "PKG_DT=%%~ta"
for %%a in ("%~dp0node_modules\express\package.json") do set "DEP_DT=%%~ta"
if "!PKG_DT!" gtr "!DEP_DT!" (
    echo [INFO] package.json updated, reinstalling...
    goto :install_deps
)

echo [ OK ] npm dependencies
goto :eof

:install_deps
echo [INFO] Running npm install...
call npm install
if errorlevel 1 (
    echo [FAIL] npm install failed.
    echo   Check network and try: npm install
    exit /b 1
)
echo [ OK ] npm install complete
goto :eof

rem --------------------------------------------------
rem  Google Chrome check
rem --------------------------------------------------
:check_chrome
echo [....] Checking Google Chrome...
set "CHROME_PATH="

where chrome.exe >nul 2>&1
if not errorlevel 1 (
    for /f "delims=" %%a in ('where chrome.exe 2^>nul') do (
        if exist "%%a" set "CHROME_PATH=%%a"
    )
    if defined CHROME_PATH goto :chrome_ok
)

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    goto :chrome_ok
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    goto :chrome_ok
)
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe"
    goto :chrome_ok
)

for /f "skip=2 tokens=2,*" %%a in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul') do (
    if exist "%%b" set "CHROME_PATH=%%b"
)
if defined CHROME_PATH goto :chrome_ok

for /f "skip=2 tokens=2,*" %%a in ('reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul') do (
    if exist "%%b" set "CHROME_PATH=%%b"
)
if defined CHROME_PATH goto :chrome_ok

echo [WARN] Google Chrome not found (optional)
echo   Upload needs Chrome browser.
echo   Download: https://www.google.com/chrome/
echo.
goto :eof

:chrome_ok
echo [ OK ] Chrome installed
goto :eof

rem --------------------------------------------------
rem  ffprobe check
rem --------------------------------------------------
:check_ffprobe
echo [....] Checking ffprobe...

ffprobe -version >nul 2>&1
if errorlevel 1 (
    echo [WARN] ffprobe not found (optional)
    echo   Video pre-check will be limited.
    echo   Download FFmpeg: https://ffmpeg.org/download.html
    echo.
) else (
    echo [ OK ] ffprobe installed
)
goto :eof

rem --------------------------------------------------
rem  Directory check
rem --------------------------------------------------
:check_dirs
echo [....] Checking directories...

if not exist "uploads\"         (mkdir "uploads"         && echo        Created uploads/)
if not exist "screenshots\"     (mkdir "screenshots"     && echo        Created screenshots/)
if not exist "browser-profile\" (mkdir "browser-profile" && echo        Created browser-profile/)

echo [ OK ] Directories ready
goto :eof

rem --------------------------------------------------
rem  Port check
rem --------------------------------------------------
:check_port
echo [....] Checking port 3000...

netstat -ano 2>nul | findstr ":3000 " >nul 2>&1
if errorlevel 1 (
    echo [ OK ] Port 3000 available
    goto :eof
)

echo [WARN] Port 3000 is in use.
set /p "CONTINUE=    Continue anyway? [y/N]: "
if /i "!CONTINUE!" neq "y" (
    echo   Please free port 3000 and try again.
    exit /b 1
)
goto :eof
