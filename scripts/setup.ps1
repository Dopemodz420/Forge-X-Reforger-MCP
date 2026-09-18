#Requires -Version 5.1
<#
.SYNOPSIS
  One-time setup for ReforgerForge MCP.

.DESCRIPTION
  - Auto-detects Arma Reforger and Tools install paths
  - Installs npm dependencies and builds the server
  - Writes agent config files with correct absolute paths
  - Verifies all tools register
  - Optionally adds reforger-forge to agent configs
#>

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ServerEntry = Join-Path $Root "dist\index.js"

Write-Host "ReforgerForge MCP Setup" -ForegroundColor Cyan
Write-Host "=======================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Repo: $Root"

# Check Node.js
$nodeVersion = node --version 2>$null
if (-not $nodeVersion) {
    Write-Host "ERROR: Node.js 20+ is required. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "Node.js: $nodeVersion" -ForegroundColor Green

# ── Auto-detect install paths ────────────────────────────────────────────────
function Find-ArmaPaths {
    $searchPaths = @(
        # Steam - default
        "C:\Program Files (x86)\Steam\steamapps\common",
        "C:\Program Files\Steam\steamapps\common",
        # Steam - common alternate drives
        "D:\SteamLibrary\steamapps\common",
        "E:\SteamLibrary\steamapps\common",
        "F:\SteamLibrary\steamapps\common",
        "G:\SteamLibrary\steamapps\common",
        # Epic Games
        "C:\Program Files\Epic Games",
        "D:\Epic Games",
        # User's Downloads (common for manual installs)
        "$env:USERPROFILE\Downloads"
    )

    $gamePath = $null
    $toolsPath = $null

    foreach ($base in $searchPaths) {
        if (-not (Test-Path $base)) { continue }

        # Check for Arma Reforger game
        $gameCandidate = Join-Path $base "Arma Reforger"
        if (Test-Path "$gameCandidate\ArmaReforgerSteamDiag.exe") {
            $gamePath = $gameCandidate
        }

        # Check for Arma Reforger Tools
        $toolsCandidate = Join-Path $base "Arma Reforger Tools"
        if (Test-Path "$toolsCandidate\Workbench.exe") {
            $toolsPath = $toolsCandidate
        }

        if ($gamePath -and $toolsPath) { break }
    }

    return @{ GamePath = $gamePath; ToolsPath = $toolsPath }
}

Write-Host ""
Write-Host "Auto-detecting Arma Reforger installs..." -ForegroundColor Yellow
$detected = Find-ArmaPaths

if ($detected.GamePath) {
    Write-Host "  Game found:  $($detected.GamePath)" -ForegroundColor Green
} else {
    Write-Host "  Game NOT found - you'll need to set gamePath manually" -ForegroundColor Yellow
}
if ($detected.ToolsPath) {
    Write-Host "  Tools found: $($detected.ToolsPath)" -ForegroundColor Green
} else {
    Write-Host "  Tools NOT found - you'll need to set workbenchPath manually" -ForegroundColor Yellow
}

# ── Create/update config ────────────────────────────────────────────────────
$configPath = Join-Path $Root "reforger-forge.config.json"
$examplePath = Join-Path $Root "reforger-forge.config.example.json"

if (-not (Test-Path $configPath)) {
    Copy-Item $examplePath $configPath
    Write-Host ""
    Write-Host "Created reforger-forge.config.json" -ForegroundColor Yellow
}

# Update config with detected paths
$config = Get-Content $configPath -Raw | ConvertFrom-Json

if ($detected.GamePath -and (-not $config.gamePath -or $config.gamePath -eq "")) {
    $config.gamePath = $detected.GamePath
}
if ($detected.ToolsPath -and (-not $config.workbenchPath -or $config.workbenchPath -eq "")) {
    $config.workbenchPath = $detected.ToolsPath
}

# Prompt for project path if not set
if (-not $config.projectPath -or $config.projectPath -eq "") {
    Write-Host ""
    $defaultProject = "$env:USERPROFILE\Documents\My Games\ArmaReforgerWorkbench\addons"
    $projectPath = Read-Host "Mod project path (Enter for default: $defaultProject)"
    if (-not $projectPath) { $projectPath = $defaultProject }
    $config.projectPath = $projectPath
}

# Prompt for export path (optional)
Write-Host ""
Write-Host "Export directory (optional - for faster file reads):" -ForegroundColor Yellow
Write-Host "  If you have an unpacked game data export from ReforgerPakTool,"
Write-Host "  enter the path. Otherwise press Enter to skip."
$exportPath = Read-Host "Export path"
if ($exportPath) {
    $config.exportPath = $exportPath
}

# Save config
$config | ConvertTo-Json -Depth 5 | Set-Content $configPath -Encoding UTF8
Write-Host ""
Write-Host "Config saved: $configPath" -ForegroundColor Green

# ── Build ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Installing dependencies..." -ForegroundColor Yellow
Push-Location $Root
npm install
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }

Write-Host "Building..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location
Write-Host "Build complete." -ForegroundColor Green

# ── List tools ──────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Verifying tools..." -ForegroundColor Yellow
node (Join-Path $Root "scripts\list-tools.mjs")

# ── Agent install ───────────────────────────────────────────────────────────
Write-Host ""
$answer = Read-Host "Install into AI agents? (all/cursor/antigravity/claude/windsurf/vscode/continue/kiro/n)"
if ($answer -eq "all") {
    & (Join-Path $Root "scripts\install-agents.ps1") -All
} elseif ($answer -ne "n" -and $answer -ne "N" -and $answer -ne "") {
    & (Join-Path $Root "scripts\install-agents.ps1") -Agent $answer
}

Write-Host ""
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Restart your AI agent"
Write-Host "  2. Verify forge-x-reforger-mcp shows 67 tools"
Write-Host "  3. Start modding!"
