# KAM PDFs - creates (or removes) Desktop and Start Menu shortcuts.
# Run via "Install KAM PDFs.bat" in the folder above, or:
#   powershell -ExecutionPolicy Bypass -File setup\install.ps1 [-Remove]
param([switch]$Remove)

$root  = Split-Path -Parent $PSScriptRoot
$index = Join-Path $root 'index.html'
$icon  = Join-Path $root 'logo.ico'
$name  = 'KAM PDFs.lnk'
$desktop   = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
$links = @((Join-Path $desktop $name), (Join-Path $startMenu $name))

if ($Remove) {
  foreach ($l in $links) { if (Test-Path $l) { Remove-Item $l -Force; Write-Host "Removed $l" } }
  Write-Host 'Done. The KAM PDFs folder itself was not touched.'
  exit 0
}

if (-not (Test-Path $index)) { Write-Host "index.html not found next to this script. Keep the folder together."; exit 1 }

# Prefer a Chromium browser in --app mode so KAM PDFs opens in its own window (no tabs or address bar).
$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe",
  "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$url = ([uri]$index).AbsoluteUri

$shell = New-Object -ComObject WScript.Shell
foreach ($l in $links) {
  $dir = Split-Path -Parent $l
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $s = $shell.CreateShortcut($l)
  if ($browser) {
    $s.TargetPath = $browser
    $s.Arguments  = "--app=`"$url`""
  } else {
    $s.TargetPath = $index   # falls back to the default browser
  }
  $s.WorkingDirectory = $root
  $s.IconLocation = "$icon,0"
  $s.Description  = 'KAM PDFs - free offline PDF editor'
  $s.Save()
  Write-Host "Created $l"
}
if ($browser) { Write-Host "KAM PDFs will open in its own window using $browser" }
else { Write-Host 'No Chrome/Edge found; the shortcut opens index.html in your default browser.' }
Write-Host ''
Write-Host 'All set. Look for the KAM PDFs icon on your Desktop and in the Start Menu.'
Write-Host ''
Write-Host 'Tip: for the sharpest taskbar icon, open https://ari-joon.github.io/KAM-PDFs/'
Write-Host 'in Chrome or Edge and click "Install app". Windows takes the taskbar icon from'
Write-Host 'the page itself in this shortcut mode, so an installed app looks much better.'
