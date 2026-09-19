#Requires -Version 5.1
<#
.SYNOPSIS
  Sync latest GitHub source, compile Windows CLI, and build the desktop NSIS installer
  with the compiled CLI embedded.

.DESCRIPTION
  1) Sync repo from origin
  2) Install deps
  3) Compile portable CLI (packages/opencode -> opencode.exe)
  4) Compile desktop background CLI (packages/cli -> opencode-cli.exe) and embed it
  5) Build Windows NSIS installer
  6) Print output file locations

  Aborts immediately if any step fails.

.EXAMPLE
  .\script\build-windows-installer.cmd

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\script\build-windows-installer.ps1

.EXAMPLE
  .\script\build-windows-installer.cmd -SkipSync -Channel prod
#>
[CmdletBinding()]
param(
  [ValidateSet("dev", "beta", "prod")]
  [string]$Channel = "dev",

  [string]$Version = "",

  [switch]$SkipSync,

  [switch]$SkipInstall,

  [switch]$SkipCli,

  [string]$Remote = "origin",

  [string]$Branch = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
# PowerShell 7+: treat native command non-zero exit as terminating
if (Test-Path variable:/PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $true
}

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-ExitCode {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [int]$Code = $LASTEXITCODE
  )
  if ($null -eq $Code) { return }
  if ($Code -ne 0) {
    throw "$Label failed with exit code $Code"
  }
}

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter()][string[]]$ArgumentList = @(),
    [Parameter(Mandatory = $true)][string]$Label
  )
  Write-Host "  > $FilePath $($ArgumentList -join ' ')"
  & $FilePath @ArgumentList
  Assert-ExitCode -Label $Label
}

function Ensure-Bun {
  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $bun) {
    $candidate = Join-Path $env:USERPROFILE ".bun\bin"
    if (Test-Path (Join-Path $candidate "bun.exe")) {
      $env:Path = "$candidate;$env:Path"
    }
  }
  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $bun) {
    throw "Bun is not installed. Install from https://bun.sh then re-run this script."
  }
  Write-Host "Using bun: $((bun --version).Trim())"
}

function Invoke-BunChecked {
  param([Parameter(Mandatory = $true)][string[]]$BunArgs)
  Invoke-Native -FilePath "bun" -ArgumentList $BunArgs -Label "bun $($BunArgs -join ' ')"
}

function Ensure-ElectronBuilderLocalPatches {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $configPath = Join-Path $RepoRoot "packages\desktop\electron-builder.config.ts"
  if (-not (Test-Path $configPath)) {
    throw "Missing electron-builder config: $configPath"
  }

  $content = Get-Content -Raw -Path $configPath
  $original = $content

  if ($content -notmatch 'publish:\s*null') {
    $needle = 'artifactName: "opencode-desktop-${os}-${arch}.${ext}",'
    $insert = @(
      'artifactName: "opencode-desktop-${os}-${arch}.${ext}",'
      '  // Avoid null publish channel crashes during local packaging.'
      '  publish: null,'
    ) -join "`r`n"
    if (-not $content.Contains($needle)) {
      throw "Could not patch publish:null into electron-builder.config.ts"
    }
    $content = $content.Replace($needle, $insert)
  }

  if ($content -notmatch 'OPENCODE_EMBED_CLI') {
    $content = $content.Replace(
      '...(channel === "dev"',
      '...(channel === "dev" || process.env.OPENCODE_EMBED_CLI === "1"'
    )
  }

  if ($content -notmatch '!resources/opencode\.exe') {
    $needle = 'files: ["out/**/*", "resources/**/*", "!resources/opencode-cli*"],'
    $insert = 'files: ["out/**/*", "resources/**/*", "!resources/opencode-cli*", "!resources/opencode.exe"],'
    if ($content.Contains($needle)) {
      $content = $content.Replace($needle, $insert)
    }
  }

  if ($content -match 'filter:\s*\["opencode-cli\*"\]') {
    $content = $content.Replace(
      'filter: ["opencode-cli*"]',
      'filter: ["opencode-cli*", "opencode.exe"]'
    )
  }

  if ($content -ne $original) {
    Set-Content -Path $configPath -Value $content -NoNewline
    Write-Host "Applied local electron-builder patches for Windows packaging"
  }
}

try {
  $root = Resolve-Path (Join-Path $PSScriptRoot "..")
  Set-Location $root
  Write-Host "Repo root: $root"

  $layoutRoot = $root.Path
  $compileRoot = Join-Path $layoutRoot "compile"
  $publishRoot = Join-Path $layoutRoot "package-dist"
  $logRoot = Join-Path $layoutRoot "logs"
  New-Item -ItemType Directory -Force -Path $compileRoot, $publishRoot, $logRoot | Out-Null
  Write-Host "Compile dir: $compileRoot"
  Write-Host "Publish dir: $publishRoot"
  Write-Host "Log dir: $logRoot"

  Ensure-Bun

  # Avoid CI-only Windows signing locally
  Remove-Item Env:GITHUB_ACTIONS -ErrorAction SilentlyContinue
  $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
  $env:NODE_OPTIONS = "--max-old-space-size=4096"
  $env:OPENCODE_CHANNEL = $Channel
  $env:OPENCODE_EMBED_CLI = "1"

  if (-not $Version) {
    $Version = "0.0.0-windows-$(Get-Date -Format 'yyyyMMddHHmm')"
  }
  $env:OPENCODE_VERSION = $Version
  Write-Host "Channel=$Channel Version=$Version EmbedCli=$($env:OPENCODE_EMBED_CLI)"

  if (-not $SkipSync) {
    Write-Step "Sync latest source from GitHub (always overwrite local changes)"
    if (-not (Test-Path (Join-Path $root ".git"))) {
      throw "Not a git repo: $root"
    }

    Invoke-Native -FilePath "git" -ArgumentList @("remote", "get-url", $Remote) -Label "git remote get-url"
    Invoke-Native -FilePath "git" -ArgumentList @("fetch", $Remote, "--prune") -Label "git fetch"

    if (-not $Branch) {
      $Branch = (git rev-parse --abbrev-ref HEAD).Trim()
      Assert-ExitCode -Label "git rev-parse --abbrev-ref HEAD"
    }

    $remoteRef = "$Remote/$Branch"
    git rev-parse --verify --quiet $remoteRef 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Remote branch not found: $remoteRef"
    }

    $status = git status --porcelain
    Assert-ExitCode -Label "git status"
    if ($status) {
      Write-Host "Discarding local changes:" -ForegroundColor Yellow
      git status --short | Out-Host
    }

    # Always match remote exactly.
    Invoke-Native -FilePath "git" -ArgumentList @("reset", "--hard", $remoteRef) -Label "git reset --hard $remoteRef"
    # Keep local build helper scripts + heavy/generated dirs.
    Invoke-Native -FilePath "git" -ArgumentList @(
      "clean", "-fd",
      "-e", "node_modules",
      "-e", "**/node_modules",
      "-e", "script/build-windows-installer.ps1",
      "-e", "script/build-windows-installer.cmd",
      "-e", "packages/*/dist",
      "-e", "packages/desktop/resources/opencode-cli.exe",
      "-e", "packages/desktop/resources/opencode.exe",
      "-e", "compile",
      "-e", "package-dist",
      "-e", "logs",
      "-e", "source",
      "-e", "AGENT.md"
    ) -Label "git clean -fd"

    $sha = (git rev-parse --short HEAD).Trim()
    Assert-ExitCode -Label "git rev-parse"
    Write-Host "Synced to: $sha ($remoteRef) — local changes overwritten"
  }
  else {
    Write-Step "Skip sync (-SkipSync)"
  }

  # Re-apply after hard reset so packaging still embeds CLI / avoids publish crash.
  Ensure-ElectronBuilderLocalPatches -RepoRoot $root

  if (-not $SkipInstall) {
    Write-Step "Install dependencies"
    Invoke-BunChecked @("install")
  }
  else {
    Write-Step "Skip install (-SkipInstall)"
  }

  $cliZip = $null
  $cliExe = $null
  $embeddedCli = $null
  $embeddedOpencode = $null

  if (-not $SkipCli) {
    Write-Step "Compile portable CLI (packages/opencode)"
    Set-Location (Join-Path $root "packages\opencode")
    Invoke-BunChecked @("run", "script/build.ts", "--single")

    $cliExe = Join-Path $root "packages\opencode\dist\opencode-windows-x64\bin\opencode.exe"
    if (-not (Test-Path $cliExe)) {
      throw "Portable CLI missing: $cliExe"
    }

    $cliZip = Join-Path $root "packages\opencode\dist\opencode-windows-x64.zip"
    if (Test-Path $cliZip) { Remove-Item $cliZip -Force }
    Compress-Archive -Path (Join-Path (Split-Path $cliExe) "*") -DestinationPath $cliZip -Force
    if (-not (Test-Path $cliZip)) {
      throw "Failed to create CLI zip: $cliZip"
    }
    Write-Host "Portable CLI ready: $cliExe"

    $resourcesDir = Join-Path $root "packages\desktop\resources"
    New-Item -ItemType Directory -Force -Path $resourcesDir | Out-Null
    $embeddedOpencode = Join-Path $resourcesDir "opencode.exe"
    Copy-Item -Force $cliExe $embeddedOpencode
    Write-Host "Staged portable CLI into installer resources: $embeddedOpencode"

    Write-Step "Compile desktop background CLI (packages/cli)"
    Set-Location (Join-Path $root "packages\cli")
    Invoke-BunChecked @("run", "script/build.ts", "--single")

    $builtBg = Get-ChildItem -Path (Join-Path $root "packages\cli\dist") -Recurse -Filter "lildax.exe" |
      Select-Object -First 1
    if (-not $builtBg) {
      throw "Background CLI (lildax.exe) not found under packages\cli\dist"
    }

    $embeddedCli = Join-Path $resourcesDir "opencode-cli.exe"
    Copy-Item -Force $builtBg.FullName $embeddedCli
    if (-not (Test-Path $embeddedCli)) {
      throw "Failed to stage embedded CLI: $embeddedCli"
    }
    Write-Host "Embedded background CLI staged: $($builtBg.FullName) -> $embeddedCli"
  }
  else {
    Write-Step "Skip CLI compile (-SkipCli)"
  }

  $desktop = Join-Path $root "packages\desktop"
  Set-Location $desktop

  Write-Step "Prepare desktop package"
  Invoke-BunChecked @("./scripts/prepare.ts")

  # prepare (dev) may download a prebuilt CLI; prefer our freshly compiled binaries
  if (-not $SkipCli) {
    Write-Step "Re-apply compiled CLIs into desktop resources"
    if (-not (Test-Path $cliExe)) {
      throw "Portable CLI missing after prepare: $cliExe"
    }
    $embeddedOpencode = Join-Path $desktop "resources\opencode.exe"
    Copy-Item -Force $cliExe $embeddedOpencode
    Write-Host "Re-copied portable CLI: $embeddedOpencode"

    $builtBg = Get-ChildItem -Path (Join-Path $root "packages\cli\dist") -Recurse -Filter "lildax.exe" |
      Select-Object -First 1
    if (-not $builtBg) {
      throw "Background CLI (lildax.exe) missing after prepare; cannot embed."
    }
    $embeddedCli = Join-Path $desktop "resources\opencode-cli.exe"
    Copy-Item -Force $builtBg.FullName $embeddedCli
    Write-Host "Re-copied background CLI: $embeddedCli"
  }

  if (-not (Test-Path (Join-Path $desktop "resources\opencode.exe"))) {
    throw "Missing packages\desktop\resources\opencode.exe — installer would not include portable CLI."
  }
  if (-not (Test-Path (Join-Path $desktop "resources\opencode-cli.exe"))) {
    throw "Missing packages\desktop\resources\opencode-cli.exe — desktop backend CLI missing."
  }

  Write-Step "Build desktop (electron-vite)"
  $logMarker = Join-Path $desktop "resources\deploy-log-dir.txt"
  Set-Content -LiteralPath $logMarker -Value $logRoot -Encoding ascii
  Invoke-BunChecked @("run", "build")

  Write-Step "Package Windows NSIS installer"
  Invoke-Native -FilePath "npx" -ArgumentList @(
    "--yes", "electron-builder",
    "--win", "--x64",
    "--publish", "never",
    "--config", "electron-builder.config.ts"
  ) -Label "electron-builder"

  $dist = Join-Path $desktop "dist"
  $installer = Join-Path $dist "opencode-desktop-win-x64.exe"
  $blockmap = Join-Path $dist "opencode-desktop-win-x64.exe.blockmap"
  $unpackedCli = Join-Path $dist "win-unpacked\resources\opencode-cli.exe"
  $unpackedOpencode = Join-Path $dist "win-unpacked\resources\opencode.exe"
  $unpacked = Join-Path $dist "win-unpacked\OpenCode Dev.exe"
  if ($Channel -eq "prod") {
    $unpacked = Join-Path $dist "win-unpacked\OpenCode.exe"
  }
  elseif ($Channel -eq "beta") {
    $unpacked = Join-Path $dist "win-unpacked\OpenCode Beta.exe"
  }

  if (-not (Test-Path $installer)) {
    throw "Installer not produced: $installer"
  }
  if (-not (Test-Path $unpackedOpencode)) {
    throw "Portable opencode.exe was not embedded in installer resources: $unpackedOpencode"
  }
  if (-not (Test-Path $unpackedCli)) {
    throw "Background opencode-cli.exe was not embedded in installer resources: $unpackedCli"
  }

  if ($cliExe -and (Test-Path $cliExe)) {
    Copy-Item -LiteralPath $cliExe -Destination (Join-Path $publishRoot "opencode.exe") -Force
  }
  Copy-Item -LiteralPath $installer -Destination (Join-Path $publishRoot "opencode-desktop-win-x64.exe") -Force
  if (Test-Path $blockmap) {
    Copy-Item -LiteralPath $blockmap -Destination (Join-Path $publishRoot "opencode-desktop-win-x64.exe.blockmap") -Force
  }
  Set-Content -LiteralPath (Join-Path $publishRoot "deploy-log-dir.txt") -Value $logRoot -Encoding ascii
  $launcher = @"
@echo off
setlocal
set OPENCODE_LOG_DIR=$logRoot
set OPENCODE_LOG_LEVEL=DEBUG
"%~dp0opencode.exe" web --port 4446 --hostname 127.0.0.1
endlocal
"@
  Set-Content -LiteralPath (Join-Path $publishRoot "launch-web.cmd") -Value $launcher -Encoding ascii

  Write-Host ""
  Write-Host "==== OUTPUT ====" -ForegroundColor Green
  Write-Host "Publish dir: $publishRoot"
  Write-Host "Log dir    : $logRoot"
  Write-Host "Prompt failures are written to $logRoot\opencode.log"

  if ($cliExe -and (Test-Path $cliExe)) {
    $item = Get-Item $cliExe
    Write-Host "CLI exe   : $($item.FullName)"
    Write-Host ("CLI size  : {0:N1} MB" -f ($item.Length / 1MB))
  }
  if ($cliZip -and (Test-Path $cliZip)) {
    Write-Host "CLI zip   : $((Get-Item $cliZip).FullName)"
  }
  if ($embeddedOpencode -and (Test-Path $embeddedOpencode)) {
    Write-Host "Packaged opencode.exe : $((Get-Item $embeddedOpencode).FullName)"
  }
  if ($embeddedCli -and (Test-Path $embeddedCli)) {
    Write-Host "Packaged opencode-cli : $((Get-Item $embeddedCli).FullName)"
  }

  $item = Get-Item $installer
  Write-Host "Installer : $($item.FullName)"
  Write-Host ("Size      : {0:N1} MB" -f ($item.Length / 1MB))

  if (Test-Path $blockmap) {
    Write-Host "Updater map: $((Get-Item $blockmap).FullName)"
  }
  if (Test-Path $unpacked) {
    Write-Host "Unpacked  : $((Get-Item $unpacked).FullName)"
  }
  Write-Host "After install, web CLI: %LOCALAPPDATA%\Programs\@opencode-aidesktop\resources\opencode.exe"
  Write-Host "In installer resources: $((Get-Item $unpackedOpencode).FullName)"
  Write-Host "In installer resources: $((Get-Item $unpackedCli).FullName)"

  Write-Host ""
  Write-Host "Done." -ForegroundColor Green
  exit 0
}
catch {
  Write-Host ""
  Write-Host "BUILD FAILED: $($_.Exception.Message)" -ForegroundColor Red
  if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
    Write-Host $_.InvocationInfo.PositionMessage -ForegroundColor DarkRed
  }
  exit 1
}
