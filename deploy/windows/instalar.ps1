# Instalador del Diagnóstico de Fatiga y Somnolencia (modo local) para Windows 10/11 de 64 bits.
#
# Deja todo en la carpeta del usuario (por omisión %LOCALAPPDATA%\FS-Diagnostico) sin pedir
# permisos de administrador, salvo para abrir el puerto en el firewall:
#   herramientas\  uv (instala Python) y PostgreSQL 16 (binarios oficiales de EDB)
#   app\           servidor, portal y catálogo del modelo
#   datos\         base de datos y evidencia
#   logs\          registros del servidor y de PostgreSQL
#   config.env     configuración (incluye la clave interna de la base; no se comparte)
# Registra una tarea que inicia el servidor al entrar a Windows y crea un acceso directo al portal.
# Se puede volver a ejecutar para actualizar: conserva datos, configuración y usuarios.

[CmdletBinding()]
param(
  [string]$Destino = (Join-Path $env:LOCALAPPDATA 'FS-Diagnostico'),
  [int]$Puerto = 8000,
  [string]$Usuario,
  [string]$Nombre,
  [string]$CarpetaRespaldo,
  [switch]$NoInteractivo,
  [switch]$SinTareaProgramada,
  [switch]$SinFirewall,
  [switch]$SinAccesoDirecto
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$UV_VERSION = '0.5.11'
$UV_URL = "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-pc-windows-msvc.zip"
$PG_VERSION = '16.6-1'
$PG_URL = "https://get.enterprisedb.com/postgresql/postgresql-$PG_VERSION-windows-x64-binaries.zip"
$PG_PORT = 5544
$PYTHON_VERSION = '3.13'
$TAREA = 'FS Diagnostico - servidor'

$Origen = $PSScriptRoot
function Paso($texto) { Write-Host ''; Write-Host "==> $texto" -ForegroundColor Cyan }
function Aviso($texto) { Write-Host "    $texto" -ForegroundColor Yellow }
function Falla($texto) { Write-Host ''; Write-Host "No se pudo completar la instalación: $texto" -ForegroundColor Red; exit 1 }
function Ejecutar([string]$exe, [string[]]$argumentos, [string]$que) {
  & $exe @argumentos
  if ($LASTEXITCODE -ne 0) { Falla "$que (código $LASTEXITCODE)" }
}
function Descargar([string]$url, [string]$archivo) {
  for ($i = 1; $i -le 3; $i++) {
    try { Invoke-WebRequest -Uri $url -OutFile $archivo -UseBasicParsing; return }
    catch { if ($i -eq 3) { Falla "no se pudo descargar $url. Revisa la conexión a internet. ($($_.Exception.Message))" }; Start-Sleep -Seconds (2 * $i) }
  }
}
function ClaveAleatoria([int]$largo) {
  $abc = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $b = New-Object byte[] $largo
  $rng.GetBytes($b)
  -join ($b | ForEach-Object { $abc[$_ % $abc.Length] })
}
function TextoPlano([Security.SecureString]$s) {
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}

if (-not [Environment]::Is64BitOperatingSystem) { Falla 'se necesita Windows de 64 bits.' }
if (-not (Test-Path (Join-Path $Origen 'app\server\app\main.py'))) { Falla "no encuentro la carpeta app junto a este script ($Origen). Descomprime el zip completo." }

Write-Host 'Diagnóstico de Fatiga y Somnolencia: instalación en este computador' -ForegroundColor Green
Write-Host "Carpeta: $Destino"

$herr = Join-Path $Destino 'herramientas'
$datos = Join-Path $Destino 'datos'
$logs = Join-Path $Destino 'logs'
foreach ($d in @($Destino, $herr, $datos, $logs, (Join-Path $datos 'evidencia'))) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# Si el servidor ya estaba corriendo (actualización), se detiene antes de reemplazar archivos.
$detener = Join-Path $Destino 'detener.ps1'
if (Test-Path $detener) { Paso 'Deteniendo la versión instalada'; & $detener -Silencioso }

Paso 'Copiando la aplicación'
$app = Join-Path $Destino 'app'
if (Test-Path $app) {
  # Se conserva el entorno de Python ya creado; el resto se reemplaza por la versión nueva.
  Get-ChildItem $app | Where-Object { $_.Name -ne 'server' } | Remove-Item -Recurse -Force
  Get-ChildItem (Join-Path $app 'server') -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '.venv' } | Remove-Item -Recurse -Force
}
Copy-Item -Path (Join-Path $Origen 'app\*') -Destination $app -Recurse -Force
foreach ($f in @('iniciar.ps1', 'detener.ps1', 'respaldar.ps1', 'LEEME.txt')) { Copy-Item (Join-Path $Origen $f) $Destino -Force }
Get-ChildItem $Destino -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

Paso 'Preparando Python'
$uv = Join-Path $herr 'uv.exe'
if (-not (Test-Path $uv)) {
  $zip = Join-Path $env:TEMP "uv-$UV_VERSION.zip"
  Descargar $UV_URL $zip
  Expand-Archive -Path $zip -DestinationPath $herr -Force
  Remove-Item $zip -Force
}
$env:UV_PYTHON_INSTALL_DIR = Join-Path $herr 'python'
$env:UV_CACHE_DIR = Join-Path $herr 'cache-uv'
$venv = Join-Path $app 'server\.venv'
$py = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $py)) { Ejecutar $uv @('venv', $venv, '--python', $PYTHON_VERSION, '--python-preference', 'only-managed') 'crear el entorno de Python' }
Ejecutar $uv @('pip', 'install', '--python', $py, '-r', (Join-Path $app 'server\requirements.txt')) 'instalar las dependencias del servidor'

Paso 'Preparando PostgreSQL'
$pgbin = Join-Path $herr 'pgsql\bin'
if (-not (Test-Path (Join-Path $pgbin 'pg_ctl.exe'))) {
  Aviso 'Descargando PostgreSQL 16 (unos 300 MB, solo la primera vez).'
  $zip = Join-Path $env:TEMP "postgresql-$PG_VERSION.zip"
  Descargar $PG_URL $zip
  Expand-Archive -Path $zip -DestinationPath $herr -Force
  Remove-Item $zip -Force
  # Lo que no usa el servidor (pgAdmin, documentación) se elimina para ahorrar espacio.
  foreach ($x in @('pgAdmin 4', 'doc', 'StackBuilder', 'symbols')) { Remove-Item (Join-Path $herr "pgsql\$x") -Recurse -Force -ErrorAction SilentlyContinue }
}

$config = Join-Path $Destino 'config.env'
$pgdata = Join-Path $datos 'pg'
if (-not (Test-Path (Join-Path $pgdata 'PG_VERSION'))) {
  $pgPass = ClaveAleatoria 32
  $pwfile = Join-Path $env:TEMP ('fs-pg-' + [guid]::NewGuid().ToString() + '.txt')
  [IO.File]::WriteAllText($pwfile, $pgPass)
  try { Ejecutar (Join-Path $pgbin 'initdb.exe') @('-D', $pgdata, '-U', 'postgres', '-A', 'scram-sha-256', "--pwfile=$pwfile", '-E', 'UTF8', '--locale=C') 'crear la base de datos' }
  finally { Remove-Item $pwfile -Force -ErrorAction SilentlyContinue }
  Add-Content -Path (Join-Path $pgdata 'postgresql.conf') -Value "`nport = $PG_PORT`nlisten_addresses = 'localhost'`n" -Encoding ASCII
} elseif (Test-Path $config) {
  $pgPass = (Get-Content $config -Encoding UTF8 | Where-Object { $_ -like 'FS_PG_PASSWORD=*' }) -replace '^FS_PG_PASSWORD=', ''
} else {
  Falla "existe una base en $pgdata pero falta config.env. Restaura config.env o borra la carpeta datos\pg para empezar de cero."
}

if (-not $CarpetaRespaldo) {
  $base = if ($env:OneDrive) { $env:OneDrive } else { [Environment]::GetFolderPath('MyDocuments') }
  $CarpetaRespaldo = Join-Path $base 'Respaldos FS-Diagnostico'
  if (Test-Path $config) {
    $prev = (Get-Content $config -Encoding UTF8 | Where-Object { $_ -like 'FS_BACKUP_DIR=*' }) -replace '^FS_BACKUP_DIR=', ''
    if ($prev) { $CarpetaRespaldo = $prev }
  }
  if (-not $NoInteractivo) {
    Write-Host ''
    Write-Host "Respaldos diarios en: $CarpetaRespaldo"
    $r = Read-Host 'Presiona Enter para aceptar o escribe otra carpeta'
    if ($r.Trim()) { $CarpetaRespaldo = $r.Trim().Trim('"') }
  }
}
New-Item -ItemType Directory -Force -Path $CarpetaRespaldo | Out-Null

$lineas = @(
  '# Configuración del servidor. La genera instalar.ps1; no compartas este archivo.',
  'FS_AUTH_MODE=local',
  "FS_PG_PASSWORD=$pgPass",
  "FS_DATABASE_URL=postgresql://postgres:$pgPass@localhost:$PG_PORT/fs",
  "FS_PORT=$Puerto",
  "FS_BLOB_DIR=$(Join-Path $datos 'evidencia')",
  "FS_PORTAL_DIR=$(Join-Path $app 'portal')",
  "FS_CATALOG_DIR=$(Join-Path $app 'packages\model\catalog')",
  "FS_BACKUP_DIR=$CarpetaRespaldo",
  "FS_PG_BIN=$pgbin"
)
[IO.File]::WriteAllLines($config, $lineas, (New-Object Text.UTF8Encoding($false)))

Paso 'Iniciando la base de datos'
$env:PGPASSWORD = $pgPass
& (Join-Path $pgbin 'pg_ctl.exe') status -D $pgdata | Out-Null
if ($LASTEXITCODE -ne 0) { Ejecutar (Join-Path $pgbin 'pg_ctl.exe') @('start', '-w', '-D', $pgdata, '-l', (Join-Path $logs 'postgresql.log')) 'iniciar PostgreSQL' }
$existe = & (Join-Path $pgbin 'psql.exe') -h localhost -p $PG_PORT -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'fs'"
if ($LASTEXITCODE -ne 0) { Falla 'no se pudo conectar con PostgreSQL.' }
if ("$existe".Trim() -ne '1') { Ejecutar (Join-Path $pgbin 'createdb.exe') @('-h', 'localhost', '-p', "$PG_PORT", '-U', 'postgres', 'fs') 'crear la base fs' }

$env:FS_DATABASE_URL = "postgresql://postgres:$pgPass@localhost:$PG_PORT/fs"
$env:FS_AUTH_MODE = 'local'
Push-Location (Join-Path $app 'server')
try {
  & $py -m app.admin_cli hay-admin
  $hayAdmin = ($LASTEXITCODE -eq 0)
  if (-not $hayAdmin -or $Usuario) {
    Paso 'Cuenta de administrador'
    if (-not $Usuario) {
      if ($NoInteractivo) { Falla 'falta -Usuario para crear el administrador.' }
      $Usuario = Read-Host 'Usuario para entrar al portal (por ejemplo, max)'
    }
    if (-not $Nombre) { $Nombre = if ($NoInteractivo) { $Usuario } else { Read-Host 'Tu nombre' } }
    if ($env:FS_ADMIN_PASSWORD) {
      $clave = $env:FS_ADMIN_PASSWORD
    } else {
      if ($NoInteractivo) { Falla 'falta la clave del administrador en FS_ADMIN_PASSWORD.' }
      while ($true) {
        $c1 = TextoPlano (Read-Host 'Clave (mínimo 10 caracteres)' -AsSecureString)
        $c2 = TextoPlano (Read-Host 'Repite la clave' -AsSecureString)
        if ($c1 -ne $c2) { Aviso 'Las claves no coinciden.'; continue }
        if ($c1.Length -lt 10) { Aviso 'La clave debe tener al menos 10 caracteres.'; continue }
        $clave = $c1; break
      }
    }
    $env:FS_ADMIN_PASSWORD = $clave
    Ejecutar $py @('-m', 'app.admin_cli', 'crear-admin', '--usuario', $Usuario, '--nombre', $Nombre) 'crear el administrador'
    Remove-Item Env:FS_ADMIN_PASSWORD -ErrorAction SilentlyContinue
    $clave = $null; $c1 = $null; $c2 = $null
  } else {
    Aviso 'Ya hay un administrador; se conservan los usuarios.'
  }
} finally { Pop-Location }
# Desde aquí la base la maneja iniciar.ps1, para que no dependa de esta ventana.
& (Join-Path $pgbin 'pg_ctl.exe') stop -w -m fast -D $pgdata | Out-Null
Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue

if (-not $SinFirewall) {
  Paso 'Permitiendo que las tablets se conecten (firewall de Windows)'
  $regla = 'FS Diagnostico - tablets'
  $cmd = "if (-not (Get-NetFirewallRule -DisplayName '$regla' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName '$regla' -Direction Inbound -Protocol TCP -LocalPort $Puerto -Profile Private,Domain -Action Allow | Out-Null }"
  try {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($admin) { Invoke-Expression $cmd }
    else {
      Aviso 'Windows pedirá permiso de administrador una sola vez para abrir el puerto.'
      Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', $cmd)
    }
  } catch {
    Aviso "No se abrió el puerto $Puerto en el firewall. Las tablets no podrán sincronizar hasta abrirlo (ver LEEME.txt)."
  }
}

$iniciar = Join-Path $Destino 'iniciar.ps1'
if (-not $SinTareaProgramada) {
  Paso 'Configurando el inicio automático'
  $accion = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$iniciar`""
  $disparo = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TAREA -Action $accion -Trigger $disparo -Settings $ajustes -Force `
    -Description 'Servidor del Diagnóstico de Fatiga y Somnolencia (portal y sincronización de tablets).' | Out-Null
  Start-ScheduledTask -TaskName $TAREA
} else {
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $iniciar)
}

Paso 'Esperando a que el servidor responda'
$ok = $false
for ($i = 0; $i -lt 90; $i++) {
  try { if ((Invoke-WebRequest -Uri "http://localhost:$Puerto/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $ok = $true; break } } catch { }
  Start-Sleep -Seconds 1
}
if (-not $ok) { Falla "el servidor no respondió. Revisa $(Join-Path $logs 'servidor.log')." }

if (-not $SinAccesoDirecto) {
  $escritorio = [Environment]::GetFolderPath('Desktop')
  [IO.File]::WriteAllLines((Join-Path $escritorio 'Portal FS Diagnostico.url'), @('[InternetShortcut]', "URL=http://localhost:$Puerto/"))
}

$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -ExpandProperty IPAddress
Write-Host ''
Write-Host 'Listo. El servidor quedó funcionando y se inicia solo al entrar a Windows.' -ForegroundColor Green
Write-Host "Portal en este computador: http://localhost:$Puerto/  (acceso directo en el escritorio)"
foreach ($ip in $ips) { Write-Host "Dirección para las tablets: ${ip}:$Puerto" }
Write-Host "Respaldos diarios en: $CarpetaRespaldo"
