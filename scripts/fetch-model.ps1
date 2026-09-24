<#
.SYNOPSIS
Download the pinned MiniCPM GGUF and verify its size and SHA-256.

.DESCRIPTION
Resumes an interrupted download (<file>.part). The file is only renamed into
place after verification, so a partial or corrupt file is never used.
Default output: models\cache\ (ignored by Git).
#>
param(
	[string]$Manifest,
	[string]$OutDir
)
. (Join-Path $PSScriptRoot "lib.ps1")

if (-not $Manifest) { $Manifest = Join-Path $RepoRoot "models\minicpm5-2b-q8_0.lock.json" }
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot "models\cache" }
$lock = Read-JsonFile $Manifest
foreach ($field in "repository", "revision", "fileName", "sizeBytes", "sha256") {
	if (-not $lock.$field) { throw "Manifest is missing $field" }
}
if ($lock.revision -notmatch "^[0-9a-f]{40}$") { throw "Manifest revision must be an immutable commit id" }
if ($lock.fileName -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$") { throw "Invalid model file name" }

$url = "https://huggingface.co/$($lock.repository)/resolve/$($lock.revision)/$($lock.fileName)"
$dest = Join-Path $OutDir $lock.fileName
Write-Step "Fetching $url"
Get-VerifiedFile $url $dest ([long]$lock.sizeBytes) $lock.sha256
Write-Host "Verified $dest ($($lock.sizeBytes) bytes, SHA-256 $($lock.sha256))"
