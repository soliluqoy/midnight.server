<#
.SYNOPSIS
Install midnight.server for the current user and put it on PATH.

.DESCRIPTION
Copies a built app layout (default: build\dist\midnight.server-windows-x64-cpu,
produced by scripts\build.ps1) into %LOCALAPPDATA%\Programs\midnight.server and
adds that directory to the user PATH, so `midnight.server` works in any new
terminal. Does not touch %LOCALAPPDATA%\midnight.server, which is the app's
runtime data directory (model, engine, logs, credentials) — see
packages\coding-agent\src\midnight\paths.ts.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#>
param(
	[string]$Source,
	[string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\midnight.server")
)
. (Join-Path $PSScriptRoot "lib.ps1")

if (-not $Source) {
	$Source = Join-Path $RepoRoot "build\dist\midnight.server-windows-x64-cpu"
}
if (-not (Test-Path -LiteralPath $Source)) {
	throw "Build output not found at $Source. Run scripts\build.ps1 first, or pass -Source <dir>."
}
if (-not (Test-Path -LiteralPath (Join-Path $Source "midnight.server.exe"))) {
	throw "$Source does not contain midnight.server.exe."
}

Write-Step "Installing to $InstallDir"
if (Test-Path -LiteralPath $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
New-Item -ItemType Directory -Force (Split-Path -Parent $InstallDir) | Out-Null
Copy-Item -Recurse -LiteralPath $Source -Destination $InstallDir

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @()
if ($userPath) { $entries = $userPath -split ";" | Where-Object { $_ -ne "" } }
if ($entries -notcontains $InstallDir) {
	Write-Step "Adding $InstallDir to the user PATH"
	$newPath = (@($entries) + $InstallDir) -join ";"
	[Environment]::SetEnvironmentVariable("Path", $newPath, "User")
} else {
	Write-Step "$InstallDir is already on PATH"
}

# Broadcast the environment change so already-running processes (e.g. Explorer)
# notice it without a reboot. New terminals pick up PATH from the registry
# regardless, so this is best-effort.
$signature = @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
$native = Add-Type -MemberDefinition $signature -Name NativeMethods -Namespace MidnightServerInstall -PassThru
[UIntPtr]$result = [UIntPtr]::Zero
$native::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result) | Out-Null

$version = (Get-Item -LiteralPath (Join-Path $InstallDir "midnight.server.exe")).VersionInfo.FileVersion
Write-Host ""
Write-Host "Installed midnight.server $version to $InstallDir"
Write-Host "Open a new terminal and run: midnight.server doctor"
