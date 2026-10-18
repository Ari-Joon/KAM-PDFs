# KAM PDFs - creates (or removes) Desktop and Start Menu shortcuts, and puts KAM PDFs in the
# "Open with" list for PDF files.
# Run via "Install KAM PDFs.bat" in the folder above, or:
#   powershell -ExecutionPolicy Bypass -File setup\install.ps1 [-Remove]
# Everything it writes is for your Windows account only (no administrator rights), and -Remove
# takes all of it away again.
param([switch]$Remove)

$root  = Split-Path -Parent $PSScriptRoot
$index = Join-Path $root 'index.html'
$icon  = Join-Path $root 'logo.ico'
$name  = 'KAM PDFs.lnk'
$desktop   = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
$links = @((Join-Path $desktop $name), (Join-Path $startMenu $name))

# "Open with > KAM PDFs" for a copy that runs from this folder. (KAM PDFs installed from the
# website does not need this: the browser lists it there by itself.)
$progId = 'KAMPDFs.Document'
$hkcu = [Microsoft.Win32.Registry]::CurrentUser
function Register-OpenWith([string]$browser) {
  $launcher = Join-Path $PSScriptRoot 'open-pdf.ps1'
  $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
  $ps = Join-Path $PSHOME 'powershell.exe'
  $run = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`" -Browser `"$browser`" -File `"%1`""
  # conhost --headless runs the launcher without a console window flashing up (Windows 10 1809+)
  $cmd = if ([Environment]::OSVersion.Version.Build -ge 17763 -and (Test-Path $conhost)) { "`"$conhost`" --headless `"$ps`" $run" } else { "`"$ps`" -WindowStyle Hidden $run" }
  $k = $hkcu.CreateSubKey("Software\Classes\$progId")
  $k.SetValue('', 'PDF document'); $k.SetValue('FriendlyTypeName', 'PDF document')
  $k.CreateSubKey('DefaultIcon').SetValue('', "`"$icon`",0")
  $a = $k.CreateSubKey('Application')
  $a.SetValue('ApplicationName', 'KAM PDFs'); $a.SetValue('ApplicationIcon', "`"$icon`",0")
  $a.SetValue('ApplicationCompany', 'KAM'); $a.SetValue('ApplicationDescription', 'Free offline PDF editor and scanner')
  $k.CreateSubKey('shell\open').SetValue('FriendlyAppName', 'KAM PDFs')
  $k.CreateSubKey('shell\open\command').SetValue('', $cmd)
  $hkcu.CreateSubKey('Software\Classes\.pdf\OpenWithProgids').SetValue($progId, [byte[]]@(), [Microsoft.Win32.RegistryValueKind]::None)
  # and in Settings > Apps > Default apps, where it can be made the app for PDFs
  $c = $hkcu.CreateSubKey('Software\KAM PDFs\Capabilities')
  $c.SetValue('ApplicationName', 'KAM PDFs'); $c.SetValue('ApplicationDescription', 'Free offline PDF editor and scanner'); $c.SetValue('ApplicationIcon', "`"$icon`",0")
  $c.CreateSubKey('FileAssociations').SetValue('.pdf', $progId)
  $hkcu.CreateSubKey('Software\RegisteredApplications').SetValue('KAM PDFs', 'Software\KAM PDFs\Capabilities')
}
function Unregister-OpenWith {
  $had = $false
  if ($hkcu.OpenSubKey("Software\Classes\$progId")) { $hkcu.DeleteSubKeyTree("Software\Classes\$progId", $false); $had = $true }
  $ow = $hkcu.OpenSubKey('Software\Classes\.pdf\OpenWithProgids', $true)
  if ($ow -and ($ow.GetValueNames() -contains $progId)) { $ow.DeleteValue($progId, $false) }
  if ($hkcu.OpenSubKey('Software\KAM PDFs')) { $hkcu.DeleteSubKeyTree('Software\KAM PDFs', $false) }
  $ra = $hkcu.OpenSubKey('Software\RegisteredApplications', $true)
  if ($ra -and ($ra.GetValueNames() -contains 'KAM PDFs')) { $ra.DeleteValue('KAM PDFs', $false) }
  return $had
}

if ($Remove) {
  foreach ($l in $links) { if (Test-Path $l) { Remove-Item $l -Force; Write-Host "Removed $l" } }
  if (Unregister-OpenWith) { Write-Host 'Removed KAM PDFs from "Open with" for PDF files' }
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

# Opening PDFs from Windows. The app installed from the website registers itself for that,
# so a folder registration from an earlier install would only be a second, confusing entry.
if ($app) {
  if (Unregister-OpenWith) { Write-Host 'Removed the folder copy from "Open with": the installed app is listed there itself.' }
} elseif ($browser) {
  Register-OpenWith $browser
  Write-Host 'Added KAM PDFs to "Open with" for PDF files.'
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
Write-Host 'To open a PDF with it, right-click the file and choose Open with > KAM PDFs. To make it'
Write-Host 'your PDF app, choose Open with > Choose another app, pick KAM PDFs and tick "Always".'
