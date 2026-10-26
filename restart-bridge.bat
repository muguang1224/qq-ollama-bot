@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Restart the QQ bridge

rem ============================================================
rem  Safely restart bridge.mjs (kill the old one, start one new).
rem
rem  Why this exists: doing it by hand kept leaving duplicates
rem  behind, because `Stop-Process` inside a pipeline can fail
rem  silently in PowerShell. Five stale bridges once accumulated,
rem  and every QQ message got answered five times.
rem
rem  This script kills with taskkill and then VERIFIES the
rem  process is really gone, retrying up to 3 times.
rem
rem  NOTE: keep this file PURE ASCII and CRLF-terminated.
rem ============================================================

set "DIR=%~dp0"
set "BRIDGE=%DIR%bridge.mjs"
set "LOG=%DIR%bot_run.log"

cd /d "%DIR%"

echo ============================================================
echo   Restarting the QQ bridge
echo ============================================================
echo.

rem --- 1. stop every running bridge -------------------------------------
echo   [1/3] Stopping existing bridge processes...
set "KILLED=0"
for /l %%R in (1,1,3) do (
    for /f "tokens=2 delims=," %%P in ('tasklist /fi "imagename eq node.exe" /fo csv /nh 2^>nul') do (
        set "PID=%%~P"
    )
    rem tasklist cannot filter by command line, so use wmic-free approach:
    rem ask PowerShell to list matching PIDs first
    for /f %%P in ('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" ^| Where-Object { $_.CommandLine -like '*bridge.mjs*' }).ProcessId" 2^>nul') do (
        taskkill /F /PID %%P >nul 2>&1
        set /a KILLED+=1
    )
    timeout /t 2 /nobreak >nul
)

rem verify
set "STILL="
for /f %%C in ('powershell -NoProfile -Command "@((Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" ^| Where-Object { $_.CommandLine -like '*bridge.mjs*' })).Count" 2^>nul') do set "STILL=%%C"

if defined STILL (
    if not "!STILL!"=="0" (
        echo.
        echo   [ERROR] !STILL! bridge process^(es^) still running.
        echo           Close them manually from Task Manager and retry.
        echo.
        pause
        exit /b 1
    )
)
echo         old process^(es^) stopped. OK.

rem --- 2. clear stale lock --------------------------------------------
echo   [2/3] Clearing lock file...
if exist "%DIR%.bridge.lock" del /q "%DIR%.bridge.lock" >nul 2>&1
echo         OK.

rem --- 3. start one fresh bridge ---------------------------------------
echo   [3/3] Starting bridge...
echo.
if not exist "%BRIDGE%" (
    echo   [ERROR] bridge.mjs not found in %DIR%
    pause
    exit /b 1
)

start "QQ Bridge" cmd /c "node bridge.mjs >> bot_run.log 2>&1"

echo   Started. Waiting 30s for it to connect...
timeout /t 30 /nobreak >nul

set "CONN="
for /f %%C in ('powershell -NoProfile -Command "@((Get-NetTCPConnection -LocalPort 3001 -State Established -ErrorAction SilentlyContinue)).Count" 2^>nul') do set "CONN=%%C"

echo.
if defined CONN (
    if not "!CONN!"=="0" (
        echo   [OK] Connected. Exactly !CONN! connection to OneBot.
    ) else (
        echo   [WARN] No connection to port 3001 yet.
        echo          Check that SnowLuma is running, then look at bot_run.log
    )
) else (
    echo   [WARN] Could not check the connection. See bot_run.log
)

echo.
echo   Log: %LOG%
echo.
pause