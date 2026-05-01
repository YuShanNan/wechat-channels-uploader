@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 视频号上传工具

echo ==============================================
echo    视频号上传工具 v1.0
echo ==============================================
echo.
echo 正在检查环境...
echo.

cd /d "%~dp0"

call :check_node      || goto :die
call :check_deps      || goto :die
call :check_chrome
call :check_playwright
call :check_ffprobe
call :check_dirs
call :check_port      || goto :die

echo.
echo ==============================================
echo    所有检查已通过，正在启动...
echo ==============================================
echo.

echo 正在启动服务器...
start /B "" node server.js

echo 等待服务器就绪...
set "WAIT_COUNT=0"
:wait_port
timeout /t 1 /nobreak >nul
netstat -ano 2>nul | findstr ":3123 " >nul 2>&1
if errorlevel 1 (
    set /a WAIT_COUNT+=1
    if !WAIT_COUNT! GEQ 30 (
        echo.
        echo [FAIL] 服务器启动超时，请检查日志
        echo.
        taskkill /F /IM node.exe >nul 2>&1
        goto :die
    )
    goto :wait_port
)

echo 服务器已就绪
start http://localhost:3123

echo 访问地址: http://localhost:3123
echo 关闭网页后服务器将自动停止

powershell -NoProfile -ExecutionPolicy Bypass -File "hide-console.ps1"

:wait_exit
timeout /t 3 /nobreak >nul
netstat -ano 2>nul | findstr ":3123 " >nul 2>&1
if not errorlevel 1 goto :wait_exit
exit /b 0

:die
echo.
echo ==============================================
echo    启动失败！
echo    请修复上述问题后重试。
echo ==============================================
pause
exit /b 1

rem --------------------------------------------------
rem  Node.js check
rem --------------------------------------------------
:check_node
echo [....] 正在检查 Node.js...

where node >nul 2>&1
if errorlevel 1 (
    echo [FAIL] 未找到 Node.js
    echo.
    echo   请安装 Node.js 18 或更新版本：
    echo   https://nodejs.org/
    echo.
    exit /b 1
)

for /f %%a in ('node -e "console.log(process.versions.node.split('.')[0])" 2^>nul') do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR (
    echo [FAIL] 无法确定 Node.js 版本
    exit /b 1
)

if !NODE_MAJOR! LSS 18 (
    echo [FAIL] 检测到 Node.js v!NODE_MAJOR!，需要 v18 或更新版本
    echo   下载 LTS 版本：https://nodejs.org/
    exit /b 1
)

echo [ OK ] Node.js v!NODE_MAJOR!
goto :eof

rem --------------------------------------------------
rem  npm dependencies check
rem --------------------------------------------------
:check_deps
echo [....] 正在检查 npm 依赖...

for %%p in (express playwright ws csv-parse) do (
    if not exist "node_modules\%%p\package.json" (
        echo [INFO] 依赖缺失，正在安装...
        goto :install_deps
    )
)

for %%a in ("%~dp0package.json") do set "PKG_DT=%%~ta"
for %%a in ("%~dp0node_modules\express\package.json") do set "DEP_DT=%%~ta"
if "!PKG_DT!" gtr "!DEP_DT!" (
    echo [INFO] package.json 已更新，重新安装...
    goto :install_deps
)

echo [ OK ] npm 依赖

node -e "require('express');require('playwright');require('ws');require('csv-parse/sync');require('./batch-upload');require('./accounts')" >nul 2>&1
if errorlevel 1 (
    echo [WARN] 模块无法正常加载，重新安装...
    goto :install_deps
)

goto :eof

:install_deps
echo [INFO] 正在运行 npm install...
call npm install
if errorlevel 1 (
    echo [FAIL] npm install 失败
    echo   请检查网络后重试：npm install
    exit /b 1
)
echo [ OK ] npm install 完成
goto :eof

rem --------------------------------------------------
rem  Google Chrome check
rem --------------------------------------------------
:check_chrome
echo [....] 正在检查 Google Chrome...
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

echo [WARN] 未找到 Google Chrome（可选）
echo   上传需要 Chrome 浏览器
echo   下载：https://www.google.com/chrome/
echo.
goto :eof

:chrome_ok
echo [ OK ] Chrome 已安装
goto :eof

rem --------------------------------------------------
rem  Playwright browser check
rem --------------------------------------------------
:check_playwright
echo [....] 正在检查 Playwright 浏览器...

if not exist "%LocalAppData%\ms-playwright\" (
    echo [WARN] Playwright 浏览器未安装
    echo   上传功能需要浏览器二进制文件
    echo   请运行：npx playwright install chrome
    echo.
    goto :eof
)

dir /ad /b "%LocalAppData%\ms-playwright\*" 2>nul | findstr /i "chromium chrome" >nul 2>&1
if not errorlevel 1 (
    echo [ OK ] Playwright 浏览器已安装
    goto :eof
)

echo [WARN] Playwright 浏览器未安装
echo   上传功能需要浏览器二进制文件
echo   请运行：npx playwright install chrome
echo.
goto :eof

rem --------------------------------------------------
rem  ffprobe check
rem --------------------------------------------------
:check_ffprobe
echo [....] 正在检查 ffprobe...

ffprobe -version >nul 2>&1
if errorlevel 1 (
    echo [WARN] 未找到 ffprobe（可选）
    echo   视频预检功能将受限
    echo   下载 FFmpeg：https://ffmpeg.org/download.html
    echo.
) else (
    echo [ OK ] ffprobe 已安装
)
goto :eof

rem --------------------------------------------------
rem  Directory check
rem --------------------------------------------------
:check_dirs
echo [....] 正在检查目录...

if not exist "uploads\"         (mkdir "uploads"         && echo        已创建 uploads/)
if not exist "screenshots\"     (mkdir "screenshots"     && echo        已创建 screenshots/)
if not exist "browser-profile\" (mkdir "browser-profile" && echo        已创建 browser-profile/)

echo [ OK ] 目录已就绪
goto :eof

rem --------------------------------------------------
rem  Port check
rem --------------------------------------------------
:check_port
echo [....] 正在检查端口 3123...

netstat -ano 2>nul | findstr ":3123 " >nul 2>&1
if not errorlevel 1 (
    echo [WARN] 端口 3123 已被占用
    set /p "CONTINUE=    是否仍然继续？[y/N]："
    if /i "!CONTINUE!" neq "y" (
        echo   请释放端口 3123 后重试
        exit /b 1
    )
    exit /b 0
)

echo [ OK ] 端口 3123 可用
exit /b 0
