<#
.SYNOPSIS
Build the midnight.server Windows distribution layout.

.DESCRIPTION
1. Compiles the CLI from TypeScript sources with the pinned Bun into one executable.
2. Copies runtime assets beside it, as Pi's release layout expects.
3. Installs the bundled extensions.
4. Writes licenses and release-manifest.json (per-file SHA-256).

Output: build\dist\midnight.server-windows-<arch>\
Run scripts\bootstrap.ps1 first.
#>
param(
	[ValidateSet("x64")][string]$Architecture = "x64",
	[string]$OutDir
)
. (Join-Path $PSScriptRoot "lib.ps1")

if (-not $OutDir) { $OutDir = Join-Path $RepoRoot "build\dist\midnight.server-windows-$Architecture" }
$agent = Join-Path $RepoRoot "packages\coding-agent"
$bun = Get-BunPath
if (-not (Test-Path -LiteralPath $bun)) { throw "Bun not found. Run scripts\bootstrap.ps1 first." }

if (Test-Path -LiteralPath $OutDir) { Remove-Item -Recurse -Force -LiteralPath $OutDir }
New-Item -ItemType Directory -Force $OutDir | Out-Null

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

Write-Step "Installing bundled extensions"
# Pinned by packaging\extensions\package-lock.json; loaded by default from extensions\ beside the exe.
$bundled = Join-Path $RepoRoot "packaging\extensions"
Invoke-Checked "npm" @("ci", "--ignore-scripts", "--omit=peer", "--prefix", $bundled)
$bundledOut = Join-Path $OutDir "extensions"
New-Item -ItemType Directory -Force $bundledOut | Out-Null
Copy-Item -Force -LiteralPath (Join-Path $bundled "package.json") -Destination $bundledOut
Copy-Item -Recurse -Force -LiteralPath (Join-Path $bundled "node_modules") -Destination $bundledOut
# pi-mcp-adapter only calls recheck's checkSync, which runs in JS; the native and Java
# agents (~50 MiB) back the async check() and are never loaded.
foreach ($unused in @("recheck-jar", "recheck-windows-x64", ".bin")) {
	$unusedPath = Join-Path $bundledOut "node_modules\$unused"
	if (Test-Path -LiteralPath $unusedPath) { Remove-Item -Recurse -Force -LiteralPath $unusedPath }
}

Write-Step "Writing licenses and notices"
$licenses = Join-Path $OutDir "licenses"
New-Item -ItemType Directory -Force $licenses | Out-Null
Copy-Item -Force "$RepoRoot\LICENSE" (Join-Path $licenses "pi-LICENSE.txt")
Copy-Item -Force "$RepoRoot\packaging\THIRD_PARTY_NOTICES.md" $OutDir

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
	sourceCommit = $commit
	sourceDirty = $dirty
	builtAt = (Get-Date).ToUniversalTime().ToString("o")
	bun = (& $bun --version)
	files = @($files)
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding ascii -LiteralPath (Join-Path $OutDir "release-manifest.json")

Write-Host ""
Write-Host "Built $OutDir"
Write-Host "Size: $([math]::Round(((Get-ChildItem -Recurse -File $OutDir | Measure-Object Length -Sum).Sum / 1MB), 1)) MiB"
