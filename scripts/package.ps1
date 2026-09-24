<#
.SYNOPSIS
Package a built layout into release archives.

.DESCRIPTION
Without -IncludeModel: dist\midnight.server-windows-<arch>.zip (app + engine; the
model is fetched on first use with `midnight.server model fetch`).

With -IncludeModel: also dist\midnight.server-windows-<arch>-offline.zip, which
contains the verified GGUF. GitHub limits release assets to under 2 GiB, so the
offline archive is additionally split into parts below that limit, with
SHA256SUMS and join-offline.ps1 to reassemble and verify it.
#>
param(
	[ValidateSet("x64")][string]$Architecture = "x64",
	[ValidateSet("cpu")][string]$Backend = "cpu",
	[switch]$IncludeModel,
	[string]$LayoutDir,
	[string]$ModelPath,
	[long]$PartBytes = 1900MB
)
. (Join-Path $PSScriptRoot "lib.ps1")
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not $LayoutDir) { $LayoutDir = Join-Path $RepoRoot "build\dist\midnight.server-windows-$Architecture-$Backend" }
if (-not (Test-Path -LiteralPath (Join-Path $LayoutDir "release-manifest.json"))) { throw "Build output not found. Run scripts\build.ps1 first." }
$dist = Join-Path $RepoRoot "dist"
New-Item -ItemType Directory -Force $dist | Out-Null

# Zip64-capable writer. Already-compressed or incompressible files are stored.
function New-ReleaseZip([string]$SourceDir, [string]$ZipPath, [string]$Root, [hashtable]$ExtraFiles) {
	if (Test-Path -LiteralPath $ZipPath) { Remove-Item -Force -LiteralPath $ZipPath }
	$zip = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
	try {
		$entries = @{}
		Get-ChildItem -Recurse -File -LiteralPath $SourceDir | ForEach-Object {
			$entries["$Root/" + $_.FullName.Substring($SourceDir.Length + 1).Replace("\", "/")] = $_.FullName
		}
		foreach ($key in $ExtraFiles.Keys) { $entries["$Root/$key"] = $ExtraFiles[$key] }
		foreach ($name in ($entries.Keys | Sort-Object)) {
			$level = if ($name -match "\.(gguf|zip|png)$") { [System.IO.Compression.CompressionLevel]::NoCompression } else { [System.IO.Compression.CompressionLevel]::Optimal }
			[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $entries[$name], $name, $level) | Out-Null
		}
	} finally { $zip.Dispose() }
}

$root = "midnight.server"
$small = Join-Path $dist "midnight.server-windows-$Architecture.zip"
Write-Step "Creating $small"
New-ReleaseZip $LayoutDir $small $root @{}
$sums = @("$(Get-Sha256 $small)  $(Split-Path -Leaf $small)")

if ($IncludeModel) {
	$lock = Read-JsonFile (Join-Path $RepoRoot "models\minicpm5-2b-q8_0.lock.json")
	if (-not $ModelPath) { $ModelPath = Join-Path $RepoRoot "models\cache\$($lock.fileName)" }
	if (-not (Test-Path -LiteralPath $ModelPath)) { throw "Model not found at $ModelPath. Run scripts\fetch-model.ps1." }
	Write-Step "Verifying model"
	if ((Get-Item -LiteralPath $ModelPath).Length -ne $lock.sizeBytes -or (Get-Sha256 $ModelPath) -ne $lock.sha256) {
		throw "Model at $ModelPath does not match the lock."
	}

	# Offline manifest: same build, plus the model entry.
	$manifest = Read-JsonFile (Join-Path $LayoutDir "release-manifest.json")
	$manifest.modelIncluded = $true
	$manifest.files = @($manifest.files) + [pscustomobject]@{ path = "models/$($lock.fileName)"; bytes = $lock.sizeBytes; sha256 = $lock.sha256 }
	$offlineManifest = Join-Path $RepoRoot "build\offline-release-manifest.json"
	$manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding ascii -LiteralPath $offlineManifest

	$offline = Join-Path $dist "midnight.server-windows-$Architecture-offline.zip"
	Write-Step "Creating $offline"
	$layoutWithoutManifest = Join-Path $RepoRoot "build\offline-layout"
	if (Test-Path $layoutWithoutManifest) { Remove-Item -Recurse -Force $layoutWithoutManifest }
	Copy-Item -Recurse -LiteralPath $LayoutDir -Destination $layoutWithoutManifest
	Remove-Item -Force (Join-Path $layoutWithoutManifest "release-manifest.json")
	New-ReleaseZip $layoutWithoutManifest $offline $root @{
		"models/$($lock.fileName)" = (Resolve-Path -LiteralPath $ModelPath).Path
		"release-manifest.json" = $offlineManifest
	}
	Remove-Item -Recurse -Force $layoutWithoutManifest
	$offlineHash = Get-Sha256 $offline
	$sums += "$offlineHash  $(Split-Path -Leaf $offline)"

	Write-Step "Splitting offline archive into parts below $([math]::Round($PartBytes / 1GB, 2)) GiB"
	Get-ChildItem -LiteralPath $dist -Filter "$(Split-Path -Leaf $offline).*" | Where-Object { $_.Name -match "\.\d{3}$" } | Remove-Item -Force
	$buffer = New-Object byte[] (8MB)
	$reader = [System.IO.File]::OpenRead($offline)
	try {
		$index = 1
		while ($reader.Position -lt $reader.Length) {
			$partPath = "$offline.{0:D3}" -f $index
			$output = [System.IO.File]::Create($partPath)
			try {
				$written = 0
				while ($written -lt $PartBytes) {
					$read = $reader.Read($buffer, 0, [int][math]::Min($buffer.Length, $PartBytes - $written))
					if ($read -le 0) { break }
					$output.Write($buffer, 0, $read)
					$written += $read
				}
			} finally { $output.Dispose() }
			$sums += "$(Get-Sha256 $partPath)  $(Split-Path -Leaf $partPath)"
			$index++
		}
	} finally { $reader.Dispose() }
	Copy-Item -Force (Join-Path $RepoRoot "packaging\join-offline.ps1") $dist
}

Set-Content -Encoding ascii -LiteralPath (Join-Path $dist "SHA256SUMS") -Value $sums
Write-Host ""
Get-ChildItem -LiteralPath $dist | Select-Object Name, @{ n = "MiB"; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize | Out-String | Write-Host
