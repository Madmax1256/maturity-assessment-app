# Respaldo inmediato de la base y la evidencia en la carpeta configurada (FS_BACKUP_DIR).
# El servidor ya hace uno al día; esto sirve antes de un cambio importante.
$Destino = $PSScriptRoot
foreach ($l in Get-Content (Join-Path $Destino 'config.env') -Encoding UTF8) {
  if ($l -match '^\s*([A-Z_]+)=(.*)$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] }
}
Push-Location (Join-Path $Destino 'app\server')
& (Join-Path $Destino 'app\server\.venv\Scripts\python.exe') -m app.admin_cli respaldo
Pop-Location
if (-not $env:FS_NO_PAUSE) { Read-Host 'Presiona Enter para cerrar' | Out-Null }
