@echo off
setlocal
title GPT-SoVITS Voice API

rem ============================================================
rem  GPT-SoVITS API launcher (helper for the main one-click launcher)
rem
rem  Starts the voice-cloning HTTP API on 127.0.0.1:9880.
rem  The bridge posts text to /tts and gets back cloned speech.
rem
rem  Model load takes about 60 seconds; that is normal.
rem  Needs a GPU with CUDA - it runs on the bundled torch (cu128).
rem
rem  NOTE: keep this file PURE ASCII and CRLF-terminated.
rem ============================================================

set "SOVITS_DIR=D:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50"

if not exist "%SOVITS_DIR%\runtime\python.exe" (
    echo [ERROR] GPT-SoVITS not found:
    echo         %SOVITS_DIR%
    echo.
    echo Download the package and extract it there:
    echo   https://github.com/RVC-Boss/GPT-SoVITS/releases
    pause
    exit /b 1
)

cd /d "%SOVITS_DIR%"

echo ============================================================
echo   GPT-SoVITS Voice API
echo ============================================================
echo.
echo   Directory : %CD%
echo   API       : http://127.0.0.1:9880
echo   Model     : v2Pro
echo.
echo   Loading models, this takes about 60 seconds.
echo   Ctrl+C stops it.
echo.
echo ============================================================
echo.

rem -c picks the config section; tts_infer.yaml "custom" is set to v2Pro.
runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml

echo.
echo GPT-SoVITS API stopped.
pause