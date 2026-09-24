<#
.SYNOPSIS
Reassemble midnight.server-windows-x64-offline.zip from its .001, .002, ... parts
and verify every part and the result against SHA256SUMS.

Usage (in the folder containing the parts and SHA256SUMS):
  powershell -ExecutionPolicy Bypass -File .\join-offline.ps1
#>
param([string]$Name = "midnight.server-windows-x64-offline.zip")
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$sums = @{}
Get-Content -LiteralPath (Join-Path $here "SHA256SUMS") | ForEach-Object {
	$hash, $file = $_ -split "\s+", 2
	$sums[$file.Trim()] = $hash
}
$parts = Get-ChildItem -LiteralPath $here -Filter "$Name.*" | Where-Object { $_.Name -match "\.\d{3}$" } | Sort-Object Name
if ($parts.Count -eq 0) { throw "No parts named $Name.001 ... found in $here" }
foreach ($part in $parts) {
	$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $part.FullName).Hash.ToLowerInvariant()
	if ($sums[$part.Name] -ne $actual) { throw "Checksum mismatch for $($part.Name); download it again." }
}
$target = Join-Path $here $Name
$output = [System.IO.File]::Create($target)
try {
	foreach ($part in $parts) {
		$reader = [System.IO.File]::OpenRead($part.FullName)
		try { $reader.CopyTo($output) } finally { $reader.Dispose() }
	}
} finally { $output.Dispose() }
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
if ($sums[$Name] -ne $actual) {
	Remove-Item -Force -LiteralPath $target
	throw "Reassembled archive does not match SHA256SUMS."
}
Write-Host "Verified $target. Extract it and run midnight.server\midnight.server.exe --local"
