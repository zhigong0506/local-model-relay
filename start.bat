@echo off
title Local Model Relay
cd /d "%~dp0"
echo ============================================
echo   Local Model Relay
echo   Admin: http://127.0.0.1:25818/admin
echo   API:   http://127.0.0.1:25818/v1
echo ============================================
echo.
node src\server.mjs
pause
