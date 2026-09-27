<#
.SYNOPSIS
Verify a packaged release archive the way a clean machine would see it.

.DESCRIPTION
Extracts the archive to a directory whose path contains spaces and non-ASCII
characters, checks every file against release-manifest.json, then runs the
executable with a minimal PATH (System32 and Windows PowerShell only: no Node,
Bun, Python or Git) and an isolated config directory.
#>
param(
	[Parameter(Mandatory = $true)][string]$Package,
	[switch]$Keep
)
. (Join-Path $PSScriptRoot "lib.ps1")
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Package = (Resolve-Path -LiteralPath $Package).Path
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("midnight verify " + [char]0x00FC + " " + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force $work | Out-Null
$failures = @()
function Check([bool]$Ok, [string]$Label) {
	Write-Host ("{0}  {1}" -f ($(if ($Ok) { "ok  " } else { "FAIL" })), $Label)
	if (-not $Ok) { $script:failures += $Label }
}

try {
	Write-Step "Extracting to $work"
	[System.IO.Compression.ZipFile]::ExtractToDirectory($Package, $work)
	$app = Join-Path $work "midnight.server"
	$exe = Join-Path $app "midnight.server.exe"
	$manifest = Read-JsonFile (Join-Path $app "release-manifest.json")

	Write-Step "Checking $(@($manifest.files).Count) files against release-manifest.json"
	$bad = @()
	foreach ($file in $manifest.files) {
		$path = Join-Path $app ($file.path.Replace("/", "\"))
		if (-not (Test-Path -LiteralPath $path) -or (Get-Item -LiteralPath $path).Length -ne $file.bytes -or (Get-Sha256 $path) -ne $file.sha256) {
			$bad += $file.path
		}
	}
	Check ($bad.Count -eq 0) "file hashes ($($bad -join ', '))"
	foreach ($required in "midnight.server.exe", "photon_rs_bg.wasm", "native\win32\prebuilds\win32-x64\win32-platform.node", "licenses\pi-LICENSE.txt", "THIRD_PARTY_NOTICES.md") {
		Check (Test-Path -LiteralPath (Join-Path $app $required)) "present: $required"
	}

	Write-Step "Running with minimal PATH and isolated config"
	$saved = @{ PATH = $env:PATH; MIDNIGHT_SERVER_CODING_AGENT_DIR = $env:MIDNIGHT_SERVER_CODING_AGENT_DIR }
	$env:PATH = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
	$env:MIDNIGHT_SERVER_CODING_AGENT_DIR = Join-Path $work "agent"
	try {
		$version = (& $exe --version 2>&1 | Out-String).Trim()
		Check ($LASTEXITCODE -eq 0 -and $version -eq $manifest.version) "--version reports $version (expected $($manifest.version))"
		$help = (& $exe --help 2>&1 | Out-String)
		Check ($LASTEXITCODE -eq 0 -and $help -match "midnight.server") "--help runs"
	} finally {
		foreach ($key in $saved.Keys) { Set-Item -Path "Env:$key" -Value $saved[$key] -ErrorAction SilentlyContinue; if ($null -eq $saved[$key]) { Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue } }
	}
} finally {
	if (-not $Keep) { Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue } else { Write-Host "Kept $work" }
}

if ($failures.Count -gt 0) { throw "$($failures.Count) check(s) failed: $($failures -join '; ')" }
Write-Host "Release verified: $Package"
