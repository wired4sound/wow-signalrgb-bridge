# Edits one device's placement in SignalRGB's saved settings (registry), in both places
# SignalRGB keeps it: the live endpoint (position/scale/rotation/alias) and the named layout
# (a QSettings "@Variant(" blob holding JSON). SignalRGB must be closed while this runs,
# or it will overwrite the change. Back up first:
#   reg export HKCU\Software\WhirlwindFX\SignalRgb backup.reg
#
#   -Verify        only check that blobs can be rebuilt byte for byte (no writes)
#   -Id <endpoint id> -X -Y -ScaleX -ScaleY -Rotation [-Alias] [-Layout Main]
param(
  [switch]$Verify,
  [string]$Id,
  [int]$X, [int]$Y, [double]$ScaleX, [double]$ScaleY, [int]$Rotation,
  [string]$Alias,
  [string]$Layout = 'Main'
)
$ErrorActionPreference = 'Stop'
$base = 'HKCU:\Software\WhirlwindFX\SignalRgb'
$layoutKey = "$base\layouts\$Layout"

# Blob = UTF-16LE of: "@Variant(" + [0,0,0,0x8F] + 4-byte big-endian length + JSON + ")"
function Build-Blob([string]$json) {
  $n = $json.Length
  $chars = @('@','V','a','r','i','a','n','t','(') + @([char]0, [char]0, [char]0, [char]0x8F) +
    @([char](($n -shr 24) -band 255), [char](($n -shr 16) -band 255), [char](($n -shr 8) -band 255), [char]($n -band 255))
  $s = (-join $chars) + $json + ')'
  return [Text.Encoding]::Unicode.GetBytes($s)
}
function Read-Json([byte[]]$b) {
  $t = [Text.Encoding]::Unicode.GetString($b)
  $i = $t.IndexOf('{')
  return $t.Substring($i, $t.LastIndexOf(')') - $i)
}

$lk = Get-Item $layoutKey
if ($Verify) {
  $ok = 0; $bad = 0
  foreach ($n in $lk.GetValueNames()) {
    if ($lk.GetValueKind($n) -ne 'Binary') { continue }
    $orig = [byte[]]$lk.GetValue($n)
    $rebuilt = Build-Blob (Read-Json $orig)
    if ([Convert]::ToBase64String($orig) -eq [Convert]::ToBase64String($rebuilt)) { $ok++ } else { $bad++; Write-Output "MISMATCH: $n" }
  }
  Write-Output "rebuilt byte for byte: $ok, mismatches: $bad"
  exit ($bad -gt 0)
}

if (Get-Process -Name SignalRgb -ErrorAction SilentlyContinue) { throw 'Close SignalRGB first.' }
$ep = "$base\lighting\endpoint\$Id"
if (-not (Test-Path $ep)) { throw "No endpoint $Id" }
$scale = ('{{"x":{0},"y":{1}}}' -f $ScaleX.ToString([Globalization.CultureInfo]::InvariantCulture), $ScaleY.ToString([Globalization.CultureInfo]::InvariantCulture))

# Live endpoint.
Set-ItemProperty -Path $ep -Name scale -Value $scale -Type String
Set-ItemProperty -Path $ep -Name rotation -Value $Rotation -Type DWord
if ($Alias) { Set-ItemProperty -Path $ep -Name alias -Value $Alias -Type String }
Set-ItemProperty -Path "$ep\position" -Name x -Value $X -Type DWord
Set-ItemProperty -Path "$ep\position" -Name y -Value $Y -Type DWord

# Named layout blob (keeps brightness, clears flips; rotation does the reversing).
$old = Read-Json ([byte[]]$lk.GetValue($Id))
$o = $old | ConvertFrom-Json
$json = ('{{"brightness":{0},"flipped":false,"flippedV":false,"rotation":{1},"scale":{2},"x":{3},"y":{4}}}' -f $o.brightness, $Rotation, $scale, $X, $Y)
Set-ItemProperty -Path $layoutKey -Name $Id -Value (Build-Blob $json) -Type Binary
Write-Output "updated $Id -> $json"
