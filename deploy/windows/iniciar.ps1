# Inicia PostgreSQL y el servidor, y los mantiene funcionando. Lo ejecuta la tarea programada
# "FS Diagnostico - servidor" al entrar a Windows; también se puede ejecutar a mano.
$ErrorActionPreference = 'Continue'
$Destino = $PSScriptRoot
$logs = Join-Path $Destino 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$log = Join-Path $logs 'servidor.log'
function Registrar($t) { Add-Content -Path $log -Value ("[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $t) -Encoding UTF8 }

# Una sola copia a la vez.
$creado = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\FSDiagnosticoServidor', [ref]$creado)
if (-not $creado) { exit 0 }

foreach ($l in Get-Content (Join-Path $Destino 'config.env') -Encoding UTF8) {
  if ($l -match '^\s*([A-Z_]+)=(.*)$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] }
}
$env:PGPASSWORD = $env:FS_PG_PASSWORD
$pgctl = Join-Path $env:FS_PG_BIN 'pg_ctl.exe'
$pgdata = Join-Path $Destino 'datos\pg'
$py = Join-Path $Destino 'app\server\.venv\Scripts\python.exe'

if ((Test-Path $log) -and (Get-Item $log).Length -gt 20MB) { Move-Item $log "$log.anterior" -Force }

while ($true) {
  & $pgctl status -D $pgdata | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Registrar 'Iniciando PostgreSQL'
    # Sin tubería: PostgreSQL hereda la salida y una tubería quedaría abierta para siempre.
    & $pgctl start -w -D $pgdata -l (Join-Path $logs 'postgresql.log')
    if ($LASTEXITCODE -ne 0) { Registrar 'PostgreSQL no inició; reintento en 30 segundos'; Start-Sleep -Seconds 30; continue }
  }
  Registrar "Iniciando el servidor en el puerto $env:FS_PORT"
  Push-Location (Join-Path $Destino 'app\server')
  cmd /c "`"$py`" -m uvicorn app.main:create_app --factory --host 0.0.0.0 --port $env:FS_PORT >> `"$log`" 2>&1"
  Pop-Location
  Registrar "El servidor se detuvo (código $LASTEXITCODE); se reinicia en 5 segundos"
  Start-Sleep -Seconds 5
}
