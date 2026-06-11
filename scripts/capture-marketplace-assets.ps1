# Capture VS Code Marketplace screenshots from Extension Development Host (E2H).
# Prereq: F5 from extension/ opens a second VS Code window with the extension loaded.
#
# Usage:
#   1. Open extension/ in VS Code, press F5 (Extension Development Host).
#   2. In E2H: open a sample repo, run Setup Wizard, install skills, open Cost Dashboard.
#   3. Run this script from repo root (captures primary monitor — adjust if needed).

$ErrorActionPreference = "Stop"
$outDir = Join-Path $PSScriptRoot "..\extension\images"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Host "Marketplace asset capture helper"
Write-Host "Output directory: $outDir"
Write-Host ""
Write-Host "Manual steps (E2H window must be focused for each shot):"
Write-Host "  1. Skills tree with ROI labels -> save as screenshot-skills-tree.png (1280x800)"
Write-Host "  2. Cost Intelligence Dashboard -> screenshot-dashboard.png"
Write-Host "  3. Setup wizard WebView -> screenshot-setup-wizard.png"
Write-Host "  4. Budget settings + status bar -> screenshot-budget-controls.png"
Write-Host "  5. Record demo.gif: install library -> detect skills -> dashboard (Win+G)"
Write-Host ""
Write-Host "Windows: Win+Shift+S for region capture. macOS: Cmd+Shift+4."
Write-Host "After capture, run: node scripts/validate-release.mjs"
