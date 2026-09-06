# Installs Luma Agent by creating a Chrome shortcut that auto-loads the extension.
# Usage:  .\install.ps1          (create shortcut + try to open Chrome)
#         .\install.ps1 -Launch   (also launch Chrome now)

param(
    [switch]$Launch
)

$ErrorActionPreference = "Stop"
$ExtensionDir = $PSScriptRoot
$ManifestPath = Join-Path $ExtensionDir "manifest.json"

if (-not (Test-Path $ManifestPath)) {
    Write-Error "manifest.json not found in $ExtensionDir"
}

function Find-Chrome {
    $paths = @(
        "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "${env:LocalAppData}\Google\Chrome\Application\chrome.exe"
    )
    foreach ($p in $paths) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

$Chrome = Find-Chrome
if (-not $Chrome) {
    Write-Error "Google Chrome not found. Install Chrome first."
}

$ShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Chrome with Luma Agent.lnk"
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Chrome
$loadArg = ('--load-extension="{0}"' -f $ExtensionDir)
$Shortcut.Arguments = $loadArg
$Shortcut.WorkingDirectory = Split-Path $Chrome
$Shortcut.Description = "Chrome with Luma Agent extension auto-loaded"
$Shortcut.Save()

Write-Host ""
Write-Host "  Luma Agent installed!" -ForegroundColor Green
Write-Host ""
Write-Host "  Shortcut created:" -ForegroundColor Cyan
Write-Host "    $ShortcutPath"
Write-Host ""
Write-Host "  Use that shortcut to open Chrome - the extension loads automatically."
Write-Host "  (No need to visit chrome://extensions or click Load unpacked.)"
Write-Host ""
Write-Host "  Tip: run 'npm run dev' in this folder for hot-reload while developing."
Write-Host ""

if ($Launch) {
    $ChromeRunning = Get-Process chrome -ErrorAction SilentlyContinue
    if ($ChromeRunning) {
        Write-Host "  Chrome is already running." -ForegroundColor Yellow
        Write-Host "  Close all Chrome windows, then double-click the new shortcut."
        Write-Host "  (Chrome must restart to pick up --load-extension.)"
    } else {
        Write-Host "  Launching Chrome with Luma Agent..." -ForegroundColor Cyan
        Start-Process -FilePath $Chrome -ArgumentList $loadArg
    }
}
