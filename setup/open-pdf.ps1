# KAM PDFs - opens a PDF from Windows ("Open with > KAM PDFs", or a double-click once KAM PDFs
# is your PDF app) in a copy of KAM PDFs that runs from a folder. setup\install.ps1 registers it.
#
# A page opened from a folder cannot read other files on the computer, and it should not be able
# to. So this hands it the one file you opened: the PDF is written, as text, into a short-lived
# script in your local app data (never in a synced folder such as OneDrive), the KAM PDFs window
# opens and reads it, and the copy is deleted a minute later. Nothing is sent anywhere.
param(
  [Parameter(Mandatory = $true)][string]$Browser,
  [Parameter(Mandatory = $true)][string]$File,
  [int]$KeepSeconds = 60
)
$ErrorActionPreference = 'Stop'

function Say([string]$msg) {
  try { (New-Object -ComObject WScript.Shell).Popup($msg, 0, 'KAM PDFs', 48) | Out-Null } catch { }
}

$app = Split-Path -Parent $PSScriptRoot
$index = Join-Path $app 'index.html'
if (-not (Test-Path -LiteralPath $index)) { Say "KAM PDFs is not in $app any more. Run 'Install KAM PDFs.bat' from where it is now."; exit 1 }
if (-not (Test-Path -LiteralPath $File)) { Say "Could not find $File"; exit 1 }

$dir = Join-Path $env:LOCALAPPDATA 'KAM PDFs\open'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# copies left by earlier openings: the window read them long ago
Get-ChildItem -LiteralPath $dir -Filter '*.js' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-2) } |
  Remove-Item -Force -ErrorAction SilentlyContinue

try { $bytes = [IO.File]::ReadAllBytes($File) }
catch { Say "Could not read $File. It may be open in another program, or you may not have access to it."; exit 1 }

# the file name as a JavaScript string, with everything outside plain ASCII escaped
$name = [IO.Path]::GetFileName($File)
$sb = New-Object System.Text.StringBuilder
foreach ($c in $name.ToCharArray()) {
  $n = [int]$c
  if ($n -lt 32 -or $n -gt 126 -or $c -eq '"' -or $c -eq '\') { [void]$sb.AppendFormat('\u{0:x4}', $n) } else { [void]$sb.Append($c) }
}
$id = [guid]::NewGuid().ToString('N')
$js = Join-Path $dir "$id.js"
$data = [Convert]::ToBase64String($bytes)
[IO.File]::WriteAllText($js, "window.KAM_OPEN = { name: `"$($sb.ToString())`", data: `"$data`" };`n", [Text.Encoding]::ASCII)

$url = ([uri]$index).AbsoluteUri + '?open=' + [uri]::EscapeDataString(([uri]$js).AbsoluteUri)
Start-Process -FilePath $Browser -ArgumentList "--app=`"$url`""

Start-Sleep -Seconds $KeepSeconds
Remove-Item -LiteralPath $js -Force -ErrorAction SilentlyContinue
