<#
.SYNOPSIS
Validate the Windows build host and fetch pinned build tools.

.DESCRIPTION
Checks Node.js, npm, Git and the in-box .NET Framework compiler, then downloads
the pinned Bun release into .cache\tools after verifying its SHA-256.
With -Install, also hydrates node_modules with `npm ci --ignore-scripts`.
#>
param(
	[switch]$Install
)
. (Join-Path $PSScriptRoot "lib.ps1")

$toolchain = Read-JsonFile (Join-Path $PSScriptRoot "toolchain.lock.json")
$problems = @()

if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") { $problems += "Only Windows x64 build hosts are supported (found $env:PROCESSOR_ARCHITECTURE)." }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
	$problems += "Node.js $($toolchain.node.minimum)+ is required: https://nodejs.org/"
} else {
	$version = [version]((& node --version).TrimStart("v"))
	if ($version -lt [version]$toolchain.node.minimum) { $problems += "Node.js $version is older than $($toolchain.node.minimum)." }
	Write-Host "node   $version"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { $problems += "npm is required (ships with Node.js)." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $problems += "Git for Windows is required: https://git-scm.com/download/win" }

$csc = Get-CscPath
if (-not (Test-Path -LiteralPath $csc)) { $problems += ".NET Framework 4 compiler not found at $csc." } else { Write-Host "csc    $csc" }

if ($problems.Count -gt 0) {
	$problems | ForEach-Object { Write-Error $_ -ErrorAction Continue }
	throw "Build host is missing prerequisites."
}

$bun = Get-BunPath
if (-not (Test-Path -LiteralPath $bun)) {
	Write-Step "Fetching Bun $($toolchain.bun.version)"
	$zip = Join-Path $RepoRoot ".cache\downloads\$(Split-Path -Leaf $toolchain.bun.url)"
	Get-VerifiedFile $toolchain.bun.url $zip $toolchain.bun.sizeBytes $toolchain.bun.sha256
	$staging = Join-Path $RepoRoot ".cache\tools\bun-staging"
	if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
	New-Item -ItemType Directory -Force $staging | Out-Null
	Invoke-Checked (Join-Path $env:SystemRoot "System32\tar.exe") @("-xf", $zip, "-C", $staging)
	$extracted = Get-ChildItem -Recurse -LiteralPath $staging -Filter bun.exe | Select-Object -First 1
	New-Item -ItemType Directory -Force (Split-Path -Parent $bun) | Out-Null
	Move-Item -LiteralPath $extracted.FullName -Destination $bun
	Remove-Item -Recurse -Force $staging
}
Write-Host "bun    $(& $bun --version) ($bun)"

if ($Install) {
	Write-Step "Installing npm dependencies (lifecycle scripts disabled)"
	Push-Location $RepoRoot
	try { Invoke-Checked "npm" @("ci", "--ignore-scripts") } finally { Pop-Location }
}

Write-Host "Build host ready."
