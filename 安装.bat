@echo off
chcp 65001 >nul
setlocal
title Install

cd /d "%~dp0"

echo ============================================================
echo   QQ Local Model Bot - Installer
echo ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo         Install from https://nodejs.org/ then re-run this file.
    echo.
    pause
    exit /b 1
)

node 安装.mjs

echo.
pause