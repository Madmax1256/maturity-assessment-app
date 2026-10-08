# Detiene el servidor y PostgreSQL. Para volver a iniciarlos: reinicia Windows o ejecuta iniciar.ps1.
param([switch]$Silencioso)
$ErrorActionPreference = 'Continue'
$Destino = $PSScriptRoot
Stop-ScheduledTask -TaskName 'FS Diagnostico - servidor' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Destino*" -and ($_.CommandLine -like '*iniciar.ps1*' -or $_.CommandLine -like '*uvicorn*') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Destino*" } | Stop-Process -Force -ErrorAction SilentlyContinue
$pgctl = Join-Path $Destino 'herramientas\pgsql\bin\pg_ctl.exe'
$pgdata = Join-Path $Destino 'datos\pg'
if ((Test-Path $pgctl) -and (Test-Path $pgdata)) {
  & $pgctl status -D $pgdata | Out-Null
  if ($LASTEXITCODE -eq 0) { & $pgctl stop -w -m fast -D $pgdata | Out-Null }
}
if (-not $Silencioso) { Write-Host 'Servidor detenido.' }
