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

# If KAM PDFs has been installed as an app from the website, launch that instead of a
# plain browser window: Windows then uses the app's own high-resolution taskbar icon.
function Find-InstalledWebApp {
  $roots = @(
    @("$env:LOCALAPPDATA\Google\Chrome\User Data",  "$env:ProgramFiles\Google\Chrome\Application\chrome_proxy.exe"),
    @("$env:LOCALAPPDATA\Google\Chrome\User Data",  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome_proxy.exe"),
    @("$env:LOCALAPPDATA\Microsoft\Edge\User Data", "$env:ProgramFiles\Microsoft\Edge\Application\msedge_proxy.exe"),
    @("$env:LOCALAPPDATA\Microsoft\Edge\User Data", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge_proxy.exe")
  )
  foreach ($r in $roots) {
    $dataRoot = $r[0]; $proxy = $r[1]
    if (-not (Test-Path $dataRoot) -or -not (Test-Path $proxy)) { continue }
    foreach ($prof in (Get-ChildItem $dataRoot -Directory -ErrorAction SilentlyContinue)) {
      $webApps = Join-Path $prof.FullName 'Web Applications'
      if (-not (Test-Path $webApps)) { continue }
      foreach ($app in (Get-ChildItem $webApps -Directory -Filter '_crx_*' -ErrorAction SilentlyContinue)) {
        # Browsers name the generated icon after the app title, but not always, so match on the prefix.
        $ico = Get-ChildItem $app.FullName -Filter 'KAM PDFs*' -File -ErrorAction SilentlyContinue |
               Sort-Object Length -Descending | Select-Object -First 1
        if ($ico) {
          return @{ Proxy = $proxy; Profile = $prof.Name; AppId = $app.Name.Substring(5); Icon = $ico.FullName }
        }
      }
    }
  }
  return $null
}

# Otherwise fall back to a Chromium browser in --app mode so it still opens in its own window.
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
$app = Find-InstalledWebApp

$shell = New-Object -ComObject WScript.Shell
foreach ($l in $links) {
  $dir = Split-Path -Parent $l
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $s = $shell.CreateShortcut($l)
  if ($app) {
    $s.TargetPath = $app.Proxy
    $s.Arguments  = "--profile-directory=$($app.Profile) --app-id=$($app.AppId)"
    # Prefer our own icon file: the browser caches its generated copy and is slow to
    # refresh it after an artwork change, so ours is the one that is always current.
    if (Test-Path $icon) { $s.IconLocation = "$icon,0" } else { $s.IconLocation = "$($app.Icon),0" }
    $s.WorkingDirectory = (Split-Path -Parent $app.Proxy)
  } elseif ($browser) {
    $s.TargetPath = $browser
    $s.Arguments  = "--app=`"$url`""
    $s.IconLocation = "$icon,0"
    $s.WorkingDirectory = $root
  } else {
    $s.TargetPath = $index   # falls back to the default browser
    $s.IconLocation = "$icon,0"
    $s.WorkingDirectory = $root
  }
  $s.Description = 'KAM PDFs - free offline PDF editor and scanner'
  $s.Save()
  Write-Host "Created $l"
}

# Tidy up the duplicate the browser makes when it installs the app next to our shortcut.
if ($app) {
  foreach ($dup in (Get-ChildItem $desktop -Filter 'KAM PDFs (*).lnk' -ErrorAction SilentlyContinue)) {
    try {
      $d = $shell.CreateShortcut($dup.FullName)
      if ($d.Arguments -like "*--app-id=$($app.AppId)*") { Remove-Item $dup.FullName -Force; Write-Host "Removed duplicate $($dup.Name)" }
    } catch { }
  }
}

Write-Host ''
if ($app) {
  Write-Host 'KAM PDFs is installed as an app, so the shortcut launches that (sharp taskbar icon).'
} elseif ($browser) {
  Write-Host "KAM PDFs will open in its own window using $browser"
  Write-Host ''
  Write-Host 'Tip: for a sharper taskbar icon, open https://ari-joon.github.io/KAM-PDFs/ in'
  Write-Host 'Chrome or Edge, click "Install app", then run this installer again. Windows takes'
  Write-Host 'the taskbar icon from the page itself otherwise, so it looks soft.'
} else {
  Write-Host 'No Chrome/Edge found; the shortcut opens index.html in your default browser.'
}
Write-Host ''
Write-Host 'All set. Look for the KAM PDFs icon on your Desktop and in the Start Menu.'
