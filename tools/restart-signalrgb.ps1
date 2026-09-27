# Quits and relaunches SignalRGB, then waits for its local API. SignalRGB only
# discovers new effect files on startup.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\restart-signalrgb.ps1
$ErrorActionPreference = 'Stop'
$launcher = Get-ChildItem "$env:LOCALAPPDATA\VortxEngine\app-*\SignalRgbLauncher.exe" |
  Sort-Object { [version]($_.Directory.Name -replace '^app-', '') } -Descending |
  Select-Object -First 1
if (-not $launcher) { throw 'SignalRgbLauncher.exe not found under %LOCALAPPDATA%\VortxEngine' }

$old = Get-Process -Name SignalRgb -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id
Get-Process -Name SignalRgb, SignalRgbLauncher -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3
Start-Process $launcher.FullName

$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $p = Get-Process -Name SignalRgb -ErrorAction SilentlyContinue | Where-Object { $old -notcontains $_.Id }
  if (-not $p) { continue }
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:16038/api/v1/lighting' -TimeoutSec 2
    if ($r.status -eq 'ok') { Write-Output "SignalRGB ready (pid $($p.Id))"; exit 0 }
  } catch { }
}
Write-Error 'SignalRGB did not come back within 90s'
exit 1
