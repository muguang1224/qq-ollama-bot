@echo off
chcp 65001 >nul
setlocal
title QQ Local Model Bot

rem ============================================================
rem  Start the bridge.
rem  Keep this file pure ASCII - Chinese in rem lines breaks
rem  cmd parsing on some systems.
rem ============================================================

cd /d "%~dp0"

echo ============================================================
echo   QQ Local Model Bot
echo ============================================================
echo.

rem ---- check Node ----
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH.
    echo         Install from https://nodejs.org/ then reopen this window.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo [ok] node %%v

rem ---- check Ollama ----
curl -s -m 5 http://127.0.0.1:11434/api/version >nul 2>&1
if errorlevel 1 (
    echo [..] Ollama not running, trying to start it...
    if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (
        start "" /min "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
        for /l %%i in (1,1,25) do (
            timeout /t 1 /nobreak >nul
            curl -s -m 3 http://127.0.0.1:11434/api/version >nul 2>&1 && goto :ollama_ok
        )
        echo [ERROR] Ollama did not start. Start it manually.
        pause
        exit /b 1
    ) else (
        echo [ERROR] Ollama not installed. See https://ollama.com/download
        pause
        exit /b 1
    )
)
:ollama_ok
echo [ok] Ollama ready

rem ---- check config ----
if not exist "config.json" (
    echo [..] No config.json, running installer first...
    node 安装.mjs
)

echo.
echo ============================================================
echo   Bridge starting. Logs appear below.
echo   Press Ctrl+C to stop.
echo.
echo   NOTE: NapCat must be running and logged in first.
echo ============================================================
echo.

node src\bridge.mjs

echo.
echo Bridge exited.
pause