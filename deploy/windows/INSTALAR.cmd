@echo off
rem Doble clic para instalar o actualizar. Ejecuta instalar.ps1 sin cambiar la política de PowerShell.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1"
echo.
pause
