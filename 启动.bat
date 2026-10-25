@echo off
setlocal enabledelayedexpansion
title QQ Bot - One Click Start

rem ============================================================
rem  QQ Bot Launcher  (self-healing, full chain)
rem
rem  What it does, in order:
rem    1. Ollama    - start if port 11434 is not listening
rem    2. SnowLuma  - start if port 3001 is not listening
rem                   (its own launcher handles QQ + injection)
rem    3. Bridge    - run node bridge.mjs in this window
rem
rem  Every step is verified by actually probing the port,
rem  not by assuming the process launched.
rem
rem  NOTE: keep this file PURE ASCII and CRLF-terminated.
rem        Chinese text / LF endings broke cmd parsing before.
rem
rem  SnowLuma replaced NapCat here. Why:
rem    NapCat's OneBot adapter kept dying (port 3001 stopped
rem    listening while its QQ process stayed alive), which showed
rem    up as the bot silently not replying.
rem  Both speak OneBot v11 on port 3001, so the bridge is unchanged.
rem  The OneBot access token differs between the two, and lives in
rem  config.json  ->  onebot.accessToken
rem ============================================================

cd /d "%~dp0"
set "HERE=%~dp0"
set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
set "SNOWLUMA_DIR=%HERE%SnowLuma"
rem GPT-SoVITS lives outside the project (it is a 15GB download and
rem is installed once for the whole machine, not per project).
set "SOVITS_DIR=D:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50"
set "SNOWLUMA_BAT=%SNOWLUMA_DIR%\launcher.bat"

echo ============================================================
echo   QQ BOT - ONE CLICK START
echo ============================================================
echo.
echo   Chain:  Ollama  -^>  SnowLuma  -^>  GPT-SoVITS  -^>  Bridge
echo.
echo   Missing pieces are started automatically.
echo   SnowLuma WebUI:  http://127.0.0.1:5099
echo   Voice API:       http://127.0.0.1:9880  (optional)
echo   If SnowLuma shows a QR code, scan it with your phone QQ.
echo.
echo ============================================================
echo.
pause

rem ============================================================
rem  1/3  Ollama
rem ============================================================
echo [1/3] Ollama (port 11434)
curl -s -m 5 http://127.0.0.1:11434/api/version >nul 2>&1
if not errorlevel 1 (
    echo       OK - already running.
    goto :ollama_ok
)

echo       Not running. Starting...
if not exist "%OLLAMA_EXE%" (
    echo       [ERROR] Not found: %OLLAMA_EXE%
    echo       Install Ollama first:  https://ollama.com/download
    echo.
    pause
    exit /b 1
)
start "" /min "%OLLAMA_EXE%"

set /a n=0
:wait_ollama
rem Use %SystemRoot%\System32\timeout.exe explicitly.
rem A bare "timeout" can be shadowed by another timeout.exe earlier in
rem PATH (Git for Windows, MSYS, Cygwin all ship a Unix timeout) and then
rem cmd reports: invalid time interval '/t'.
"%SystemRoot%\System32\timeout.exe" /t 1 /nobreak >nul 2>&1
curl -s -m 3 http://127.0.0.1:11434/api/version >nul 2>&1
if not errorlevel 1 goto :ollama_ok
set /a n+=1
set /a r5=!n! %% 5
if !r5! equ 0 echo       ... waiting ^(!n!s^)
if !n! lss 40 goto :wait_ollama

echo       [ERROR] Ollama did not respond in 40s.
echo       Open Ollama manually, then run this again.
echo.
pause
exit /b 1

:ollama_ok
echo       OK - Ollama is ready.

rem ============================================================
rem  2/3  SnowLuma
rem ============================================================
echo.
echo [2/3] SnowLuma (OneBot port 3001)
netstat -ano | findstr ":3001" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo       OK - already listening on 3001.
    goto :snowluma_ok
)

echo       Not running. Starting SnowLuma in its own window...

if not exist "%SNOWLUMA_BAT%" (
    echo       [ERROR] Not found: %SNOWLUMA_BAT%
    echo.
    echo       Expected the SnowLuma release to be extracted to:
    echo               %SNOWLUMA_DIR%
    echo       Download it from:
    echo               https://github.com/SnowLuma/SnowLuma/releases
    echo.
    pause
    exit /b 1
)

rem SnowLuma needs the EULA/privacy flags to skip the consent screen,
rem and it must run from its own directory.
rem
rem Do NOT inline this as:  cmd /c "cd /d "%DIR%" && set X=1 && node ..."
rem Nested quotes inside a quoted cmd /c string are fragile on Windows and
rem this project has already been bitten by cmd parsing quirks before.
rem A separate helper .bat keeps the quoting flat and readable.
if not exist "%HERE%start-snowluma.bat" (
    echo       [ERROR] Helper not found: %HERE%start-snowluma.bat
    echo.
    pause
    exit /b 1
)
start "SnowLuma" cmd /c ""%HERE%start-snowluma.bat""

echo.
echo       ------------------------------------------------------
echo        A "SnowLuma" window should be opening now.
echo.
echo        If it shows a QR code, scan it with your phone QQ.
echo        WebUI (login for account/config):  http://127.0.0.1:5099
echo        This window continues by itself once 3001 is up.
echo.
echo        Waiting up to 300s (5 min) ...
echo       ------------------------------------------------------
echo.

set /a n=0
:wait_snowluma
"%SystemRoot%\System32\timeout.exe" /t 2 /nobreak >nul 2>&1
netstat -ano | findstr ":3001" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto :snowluma_ok
set /a n+=1
set /a r15=!n! %% 15
if !r15! equ 0 (
    set /a el=!n!*2
    echo       ... waiting ^(!el!s^) - scan the QR code if shown
)
if !n! lss 150 goto :wait_snowluma

echo.
echo       [WARN] 3001 did not come up in 300s.
echo.
echo       The SnowLuma window is still open - finish scanning there,
echo       then run this launcher again. It will skip to step 3.
echo.
pause
exit /b 1

:snowluma_ok
echo       OK - SnowLuma is ready.

rem Warn if QQ is not actually logged in: 3001 can listen before that.
curl -s -m 3 http://127.0.0.1:5099 >nul 2>&1
if errorlevel 1 (
    echo       NOTE: WebUI 5099 not answering yet. If the bot stays
    echo             silent, open http://127.0.0.1:5099 and check
    echo             that the QQ account shows as online.
)

rem ============================================================
rem  3/4  GPT-SoVITS voice cloning API  (optional)
rem
rem  Only needed when config.json  tts.engine = "sovits".
rem  If it is not running, the bridge still works: voice messages
rem  fall back to edge-tts automatically.
rem
rem  It is started in a separate window because model loading takes
rem  ~60s and we do not want to block the chain on it.
rem  Port 9880 is the API; startup is verified by polling it.
rem ============================================================
echo.
echo [3/4] GPT-SoVITS voice API (port 9880, optional)
netstat -ano | findstr ":9880" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo       OK - already running.
    goto :sovits_ok
)

if not exist "%SOVITS_DIR%\runtime\python.exe" (
    echo       SKIP - GPT-SoVITS not found at:
    echo              %SOVITS_DIR%
    echo       Voice messages will use edge-tts instead.
    goto :sovits_ok
)

echo       Starting... model load takes about 60s.
start "GPT-SoVITS" cmd /c ""%HERE%start-sovits.bat""

set /a n=0
:wait_sovits
"%SystemRoot%\System32\timeout.exe" /t 3 /nobreak >nul 2>&1
netstat -ano | findstr ":9880" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto :sovits_ok
set /a n+=1
set /a r10=!n! %% 10
if !r10! equ 0 (
    set /a el=!n!*3
    echo       ... waiting ^(!el!s^)
)
if !n! lss 40 goto :wait_sovits

echo       [WARN] 9880 did not come up in 120s.
echo       Continuing anyway - voice falls back to edge-tts.

:sovits_ok
echo       OK - voice API step done.

rem ============================================================
rem  4/4  Bridge
rem ============================================================
echo.
echo [4/4] Starting bridge...
echo.

rem ------------------------------------------------------------
rem  Guard: refuse to start a second bridge.
rem
rem  Why this matters: the bridge is identified by the QQ account it
rem  drives, not by a port - two bridges can both connect to 3001 and
rem  the bot then answers every message twice (once per bridge), with
rem  slightly different wording, which looks like the bot repeating
rem  itself. That actually happened once.
rem
rem  Detection: the bridge runs as "node ... bridge.mjs" but that command
rem  line is identical for both copies, so instead check whether an
rem  existing connection to the OneBot port is already ESTABLISHED.
rem  The bridge is a client of 3001, so one established socket means one
rem  bridge is already live.
rem ------------------------------------------------------------
netstat -ano | findstr ":3001" | findstr "ESTABLISHED" >nul 2>&1
if not errorlevel 1 (
    echo       ------------------------------------------------------
    echo        A bridge already looks connected to OneBot 3001.
    echo.
    echo        Starting another one would make the bot reply TWICE
    echo        to every message ^(two bridges, same QQ account^).
    echo.
    echo        If the bot is working, just close this window.
    echo        To force a restart: close the other bridge window,
    echo        wait a few seconds, then run this launcher again.
    echo       ------------------------------------------------------
    echo.
    pause
    exit /b 0
)

where node >nul 2>&1
if errorlevel 1 (
    echo       [ERROR] node not found in PATH.
    echo       Install Node.js:  https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo ============================================================
echo   ALL READY
echo.
echo   Chat with the bot on QQ now.
echo   Logs appear below. Ctrl+C stops the bridge.
echo ============================================================
echo.

node bridge.mjs

echo.
echo Bridge stopped.
pause