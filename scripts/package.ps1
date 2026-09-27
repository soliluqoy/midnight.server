<#
.SYNOPSIS
Package a built layout into a release archive.

.DESCRIPTION
Writes dist\midnight.server-windows-<arch>.zip and dist\SHA256SUMS.
#>
param(
	[ValidateSet("x64")][string]$Architecture = "x64",
	[string]$LayoutDir
)
. (Join-Path $PSScriptRoot "lib.ps1")
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not $LayoutDir) { $LayoutDir = Join-Path $RepoRoot "build\dist\midnight.server-windows-$Architecture" }
if (-not (Test-Path -LiteralPath (Join-Path $LayoutDir "release-manifest.json"))) { throw "Build output not found. Run scripts\build.ps1 first." }
$dist = Join-Path $RepoRoot "dist"
New-Item -ItemType Directory -Force $dist | Out-Null

$zipPath = Join-Path $dist "midnight.server-windows-$Architecture.zip"
Write-Step "Creating $zipPath"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -Force -LiteralPath $zipPath }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
	Get-ChildItem -Recurse -File -LiteralPath $LayoutDir | Sort-Object FullName | ForEach-Object {
		$name = "midnight.server/" + $_.FullName.Substring($LayoutDir.Length + 1).Replace("\", "/")
		$level = if ($name -match "\.(zip|png)$") { [System.IO.Compression.CompressionLevel]::NoCompression } else { [System.IO.Compression.CompressionLevel]::Optimal }
		[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name, $level) | Out-Null
	}
} finally { $zip.Dispose() }

Set-Content -Encoding ascii -LiteralPath (Join-Path $dist "SHA256SUMS") -Value "$(Get-Sha256 $zipPath)  $(Split-Path -Leaf $zipPath)"
Write-Host ""
Get-ChildItem -LiteralPath $dist | Select-Object Name, @{ n = "MiB"; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize | Out-String | Write-Host
