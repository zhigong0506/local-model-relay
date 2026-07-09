@echo off
title Stop Local Model Relay
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:25818/api/process/exit' -Method Post -TimeoutSec 3 | Out-Null; Write-Host '[OK] Local Model Relay is stopping.' } catch { Write-Host '[i] Local Model Relay is not responding on http://127.0.0.1:25818.' }"
echo.
pause
