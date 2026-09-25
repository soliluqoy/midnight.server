<#
.SYNOPSIS
Build the midnight.server Windows distribution layout (without the model).

.DESCRIPTION
1. Compiles native\midnight-host (Job Object owner) with the in-box C# compiler.
2. Compiles the CLI from TypeScript sources with the pinned Bun into one executable.
3. Copies runtime assets beside it, as Pi's release layout expects.
4. Installs the pinned, SHA-256-verified llama.cpp CPU engine into engine\cpu, using
   the built CLI's own `engine fetch` (pins: scripts\generate-engine-pins.mjs).
5. Writes licenses and release-manifest.json (per-file SHA-256).

Output: build\dist\midnight.server-windows-<arch>-<backend>\
Run scripts\bootstrap.ps1 first. The model is added by scripts\package.ps1 -IncludeModel.
#>
param(
	[ValidateSet("x64")][string]$Architecture = "x64",
	[ValidateSet("cpu")][string]$Backend = "cpu",
	[ValidateSet("Release")][string]$Configuration = "Release",
	[string]$OutDir
)
. (Join-Path $PSScriptRoot "lib.ps1")

if (-not $OutDir) { $OutDir = Join-Path $RepoRoot "build\dist\midnight.server-windows-$Architecture-$Backend" }
$agent = Join-Path $RepoRoot "packages\coding-agent"
$bun = Get-BunPath
if (-not (Test-Path -LiteralPath $bun)) { throw "Bun not found. Run scripts\bootstrap.ps1 first." }

if (Test-Path -LiteralPath $OutDir) { Remove-Item -Recurse -Force -LiteralPath $OutDir }
New-Item -ItemType Directory -Force $OutDir | Out-Null

Write-Step "Compiling midnight-host"
$hostOut = Join-Path $RepoRoot "build\native\midnight-host.exe"
New-Item -ItemType Directory -Force (Split-Path -Parent $hostOut) | Out-Null
Invoke-Checked (Get-CscPath) @("/nologo", "/optimize+", "/platform:anycpu", "/target:exe", "/out:$hostOut", (Join-Path $RepoRoot "native\midnight-host\Program.cs"))

Write-Step "Compiling midnight.server.exe with Bun $(& $bun --version)"
Push-Location $RepoRoot
try {
	# Worker scripts are embedded only when passed as explicit entrypoints.
	# --no-compile-autoload-bunfig keeps a project's bunfig.toml from preloading into the binary.
	Invoke-Checked $bun @(
		"build", "--compile", "--no-compile-autoload-bunfig", "--target=bun-windows-$Architecture-baseline",
		"packages/coding-agent/src/bun/cli.ts", "packages/coding-agent/src/utils/image-resize-worker.ts",
		"--outfile", (Join-Path $OutDir "midnight.server.exe")
	)
} finally { Pop-Location }

Write-Step "Copying runtime assets"
$copies = @(
	@{ From = "$agent\package.json"; To = "" },
	@{ From = "$agent\README.md"; To = "" },
	@{ From = "$agent\CHANGELOG.md"; To = "" },
	@{ From = "$RepoRoot\node_modules\@silvia-odwyer\photon-node\photon_rs_bg.wasm"; To = "" },
	@{ From = "$agent\src\modes\interactive\theme\*.json"; To = "theme" },
	@{ From = "$agent\src\core\export-html\template.*"; To = "export-html" },
	@{ From = "$agent\src\core\export-html\vendor\*.js"; To = "export-html\vendor" },
	@{ From = "$RepoRoot\packages\tui\native\win32\prebuilds\win32-$Architecture"; To = "native\win32\prebuilds" }
)
foreach ($copy in $copies) {
	$target = Join-Path $OutDir $copy.To
	New-Item -ItemType Directory -Force $target | Out-Null
	Copy-Item -Recurse -Force -Path $copy.From -Destination $target
}
Copy-Item -Recurse -Force "$agent\docs" (Join-Path $OutDir "docs")

Write-Step "Installing engine ($Backend)"
# The built CLI downloads, verifies and unpacks its own pinned engine, so the
# bundled copy is laid out (and marked) exactly like a first-run download.
# .cache\engine-home keeps it between builds.
$engineHome = Join-Path $RepoRoot ".cache\engine-home"
$previousHome = $env:MIDNIGHT_SERVER_HOME
$env:MIDNIGHT_SERVER_HOME = $engineHome
try {
	$fetched = & (Join-Path $OutDir "midnight.server.exe") engine fetch $Backend
	if ($LASTEXITCODE -ne 0) { throw "midnight.server engine fetch $Backend exited with $LASTEXITCODE" }
} finally { $env:MIDNIGHT_SERVER_HOME = $previousHome }
$engineRoot = ($fetched | Select-String -Pattern "^Engine installed: (.+)$" | Select-Object -Last 1).Matches[0].Groups[1].Value
$engineDir = Join-Path $OutDir "engine\$Backend"
Copy-Item -Recurse -LiteralPath $engineRoot -Destination $engineDir
$engineMarker = Read-JsonFile (Join-Path $engineDir ".midnight-engine.json")
if (-not (Test-Path -LiteralPath (Join-Path $engineDir $engineMarker.server))) { throw "Bundled engine is missing $($engineMarker.server)" }
Copy-Item -Force $hostOut (Join-Path $OutDir "engine\midnight-host.exe")

Write-Step "Writing licenses and notices"
$licenses = Join-Path $OutDir "licenses"
New-Item -ItemType Directory -Force $licenses | Out-Null
Copy-Item -Force "$RepoRoot\LICENSE" (Join-Path $licenses "pi-LICENSE.txt")
Copy-Item -Force "$RepoRoot\packaging\licenses\*" $licenses
Copy-Item -Force "$RepoRoot\packaging\THIRD_PARTY_NOTICES.md" $OutDir
New-Item -ItemType Directory -Force (Join-Path $OutDir "models") | Out-Null
Copy-Item -Force "$RepoRoot\models\minicpm5-2b-q8_0.lock.json" (Join-Path $OutDir "models\model-manifest.json")

Write-Step "Writing release-manifest.json"
$commit = (& git -c "safe.directory=$($RepoRoot -replace '\\','/')" -C $RepoRoot rev-parse HEAD 2>$null)
$dirty = [bool](& git -c "safe.directory=$($RepoRoot -replace '\\','/')" -C $RepoRoot status --porcelain 2>$null)
$files = Get-ChildItem -Recurse -File -LiteralPath $OutDir | Sort-Object FullName | ForEach-Object {
	[ordered]@{
		path = $_.FullName.Substring($OutDir.Length + 1).Replace("\", "/")
		bytes = $_.Length
		sha256 = Get-Sha256 $_.FullName
	}
}
$manifest = [ordered]@{
	product = "midnight.server"
	version = (Read-JsonFile "$agent\package.json").version
	platform = "win32-$Architecture"
	backend = $Backend
	sourceCommit = $commit
	sourceDirty = $dirty
	builtAt = (Get-Date).ToUniversalTime().ToString("o")
	bun = (& $bun --version)
	engine = $engineMarker
	model = Read-JsonFile "$RepoRoot\models\minicpm5-2b-q8_0.lock.json"
	modelIncluded = $false
	files = @($files)
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding ascii -LiteralPath (Join-Path $OutDir "release-manifest.json")

Write-Host ""
Write-Host "Built $OutDir"
Write-Host "Size: $([math]::Round(((Get-ChildItem -Recurse -File $OutDir | Measure-Object Length -Sum).Sum / 1MB), 1)) MiB (without model)"
