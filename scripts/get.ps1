<#
.SYNOPSIS
Download and install the latest midnight.server release from GitHub.

.DESCRIPTION
Web installer, meant to be piped into PowerShell:

    irm https://raw.githubusercontent.com/soliluqoy/midnight.server/main/scripts/get.ps1 | iex

Downloads midnight.server-windows-x64.zip from the newest GitHub release
(pre-releases included), verifies it against the release's SHA256SUMS, installs
it into %LOCALAPPDATA%\Programs\midnight.server and adds that directory to the
user PATH. The model downloads on first use, as with the zip release.

Self-contained on purpose: `iex` runs it without $PSScriptRoot, so it cannot
dot-source lib.ps1. scripts\install.ps1 is the equivalent for a local build.

Environment overrides:
    MIDNIGHT_SERVER_VERSION      Release tag to install (default: newest release)
    MIDNIGHT_SERVER_INSTALL_DIR  Install directory
#>

# Run in a child scope so `iex` does not change preferences or variables in the
# caller's session. Errors throw instead of `exit`, which would close the shell.
& {
	Set-StrictMode -Version 3.0
	$ErrorActionPreference = "Stop"
	$ProgressPreference = "SilentlyContinue"
	# Windows PowerShell 5.1 may default to TLS 1.0, which GitHub rejects.
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

	$repo = "soliluqoy/midnight.server"
	$asset = "midnight.server-windows-x64.zip"
	$installDir = if ($env:MIDNIGHT_SERVER_INSTALL_DIR) { $env:MIDNIGHT_SERVER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\midnight.server" }

	if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") { throw "midnight.server requires Windows x64 (found $env:PROCESSOR_ARCHITECTURE)." }

	# /releases/latest skips pre-releases, so list releases and take the newest.
	$headers = @{ "User-Agent" = "midnight.server-installer"; Accept = "application/vnd.github+json" }
	$release = if ($env:MIDNIGHT_SERVER_VERSION) {
		Invoke-RestMethod -UseBasicParsing -Headers $headers "https://api.github.com/repos/$repo/releases/tags/$env:MIDNIGHT_SERVER_VERSION"
	} else {
		# PowerShell 5.1 emits a JSON array as one object; assigning it first unrolls it.
		$releases = Invoke-RestMethod -UseBasicParsing -Headers $headers "https://api.github.com/repos/$repo/releases?per_page=10"
		$releases | Where-Object { -not $_.draft } | Select-Object -First 1
	}
	if (-not $release) { throw "No midnight.server release found." }
	$zipAsset = @($release.assets) | Where-Object { $_.name -eq $asset } | Select-Object -First 1
	$sumsAsset = @($release.assets) | Where-Object { $_.name -eq "SHA256SUMS" } | Select-Object -First 1
	if (-not $zipAsset -or -not $sumsAsset) { throw "Release $($release.tag_name) is missing $asset or SHA256SUMS." }

	$temp = Join-Path ([IO.Path]::GetTempPath()) "midnight.server-install-$([Guid]::NewGuid().ToString('N'))"
	New-Item -ItemType Directory -Force $temp | Out-Null
	try {
		Write-Host "==> Downloading midnight.server $($release.tag_name) ($([math]::Round($zipAsset.size / 1MB, 1)) MiB)"
		$zipPath = Join-Path $temp $asset
		Invoke-WebRequest -UseBasicParsing -Headers $headers $zipAsset.browser_download_url -OutFile $zipPath
		$sums = (Invoke-WebRequest -UseBasicParsing -Headers $headers $sumsAsset.browser_download_url).Content
		if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }

		Write-Host "==> Verifying SHA-256"
		$line = $sums -split "`r?`n" | Where-Object { ($_ -split "\s+", 2)[-1].TrimStart("*") -eq $asset } | Select-Object -First 1
		if (-not $line) { throw "SHA256SUMS has no entry for $asset." }
		$expected = ($line -split "\s+")[0].ToLowerInvariant()
		$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
		if ($actual -ne $expected) { throw "SHA-256 mismatch for ${asset}: expected $expected, got $actual." }

		Write-Host "==> Extracting"
		$extractDir = Join-Path $temp "x"
		Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir
		$source = Join-Path $extractDir "midnight.server"
		if (-not (Test-Path -LiteralPath (Join-Path $source "midnight.server.exe"))) { throw "$asset does not contain midnight.server\midnight.server.exe." }

		Write-Host "==> Installing to $installDir"
		if (Test-Path -LiteralPath $installDir) {
			# Only replace a previous midnight.server install, never an unrelated directory.
			if (-not (Test-Path -LiteralPath (Join-Path $installDir "midnight.server.exe")) -and (Get-ChildItem -Force -LiteralPath $installDir | Select-Object -First 1)) {
				throw "$installDir exists and is not a midnight.server install. Set MIDNIGHT_SERVER_INSTALL_DIR to another directory."
			}
			try { Remove-Item -Recurse -Force -LiteralPath $installDir }
			catch { throw "Could not replace $installDir. Close any running midnight.server and try again. ($($_.Exception.Message))" }
		}
		New-Item -ItemType Directory -Force (Split-Path -Parent $installDir) | Out-Null
		Move-Item -LiteralPath $source -Destination $installDir
	} finally {
		Remove-Item -Recurse -Force -LiteralPath $temp -ErrorAction SilentlyContinue
	}

	$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
	$entries = @()
	if ($userPath) { $entries = $userPath -split ";" | Where-Object { $_ -ne "" } }
	if ($entries -notcontains $installDir) {
		Write-Host "==> Adding $installDir to the user PATH"
		[Environment]::SetEnvironmentVariable("Path", ((@($entries) + $installDir) -join ";"), "User")
		# Broadcast WM_SETTINGCHANGE so Explorer and terminals launched from it see the new PATH.
		$native = Add-Type -PassThru -Name NativeMethods -Namespace MidnightServerGet -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
		[UIntPtr]$result = [UIntPtr]::Zero
		$native::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result) | Out-Null
	}
	# Make `midnight.server` work in this terminal too, not only in new ones.
	if (($env:Path -split ";") -notcontains $installDir) { $env:Path = "$env:Path;$installDir" }

	Write-Host ""
	Write-Host "Installed midnight.server $($release.tag_name) to $installDir"
	Write-Host "Run: midnight.server doctor"
}
