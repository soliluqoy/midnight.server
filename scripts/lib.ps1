# Shared helpers for the midnight.server Windows build scripts. Dot-source only.
Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoRoot = Split-Path -Parent $PSScriptRoot

function Read-JsonFile([string]$Path) {
	return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Get-Sha256([string]$Path) {
	return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Write-Step([string]$Message) {
	Write-Host "==> $Message"
}

# Download $Url to $Destination unless it already exists with the expected hash.
# Uses curl.exe (in Windows 10 1803+) for resume support; the file is only
# promoted after its size and SHA-256 match.
function Get-VerifiedFile([string]$Url, [string]$Destination, [long]$SizeBytes, [string]$Sha256) {
	if (Test-Path -LiteralPath $Destination) {
		if ((Get-Item -LiteralPath $Destination).Length -eq $SizeBytes -and (Get-Sha256 $Destination) -eq $Sha256) {
			return
		}
		Remove-Item -LiteralPath $Destination -Force
	}
	New-Item -ItemType Directory -Force (Split-Path -Parent $Destination) | Out-Null
	$part = "$Destination.part"
	$curl = Join-Path $env:SystemRoot "System32\curl.exe"
	Invoke-Checked $curl @("--fail", "--location", "--retry", "3", "--silent", "--show-error", "--continue-at", "-", "--output", $part, $Url)
	$size = (Get-Item -LiteralPath $part).Length
	if ($size -ne $SizeBytes) { throw "Size mismatch for ${Url}: expected $SizeBytes, got $size. Re-run to resume." }
	$actual = Get-Sha256 $part
	if ($actual -ne $Sha256) {
		Remove-Item -LiteralPath $part -Force
		throw "SHA-256 mismatch for ${Url}: expected $Sha256, got $actual"
	}
	Move-Item -LiteralPath $part -Destination $Destination
}

function Get-BunPath {
	$lock = (Read-JsonFile (Join-Path $PSScriptRoot "toolchain.lock.json")).bun
	return Join-Path $RepoRoot ".cache\tools\bun-$($lock.version)\bun.exe"
}

function Get-CscPath {
	$lock = (Read-JsonFile (Join-Path $PSScriptRoot "toolchain.lock.json")).csc
	return Join-Path $env:SystemRoot $lock.path
}

# Windows PowerShell 5.1 turns any native stderr output into a terminating error
# under $ErrorActionPreference = "Stop"; judge native tools by exit code instead.
function Invoke-Checked([string]$FilePath, [string[]]$Arguments) {
	$previous = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	try {
		& $FilePath @Arguments 2>&1 | ForEach-Object { Write-Host $_ }
		$code = $LASTEXITCODE
	} finally { $ErrorActionPreference = $previous }
	if ($code -ne 0) { throw "$FilePath exited with $code" }
}
