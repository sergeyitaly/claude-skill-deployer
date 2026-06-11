# Test weekly report delivery paths for claude-skills-deployer
param(
    [ValidateSet("github", "email", "both")]
    [string]$Mode = "both"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "=== Weekly report delivery test ===" -ForegroundColor Cyan
Write-Host "Workspace: $root"
Write-Host ""

Write-Host "gh auth:" -ForegroundColor Yellow
gh auth status
Write-Host ""

if ($Mode -eq "github" -or $Mode -eq "both") {
    Write-Host "--- GitHub issue (assignee @me -> GitHub emails you) ---" -ForegroundColor Yellow
    $bodyFile = Join-Path $env:TEMP "claude-skills-weekly-test.md"
    @"
## Weekly AI agent usage (manual test)

Workspace: $root
Sent: $(Get-Date -Format o)

This is a test issue from scripts/test_weekly_email.ps1.
Safe to close after verifying you received a GitHub notification email.
"@ | Set-Content -Path $bodyFile -Encoding UTF8
    try {
        $url = gh issue create --title "TEST Weekly AI Agent Usage Report" --body-file $bodyFile --assignee "@me"
        Write-Host "OK: $url" -ForegroundColor Green
    } finally {
        Remove-Item $bodyFile -ErrorAction SilentlyContinue
    }
    Write-Host ""
}

if ($Mode -eq "email" -or $Mode -eq "both") {
    Write-Host "--- Direct SMTP email ---" -ForegroundColor Yellow
    $vars = @("CLAUDE_SKILLS_SMTP_HOST", "CLAUDE_SKILLS_SMTP_USER", "CLAUDE_SKILLS_SMTP_PASSWORD", "CLAUDE_SKILLS_REPORT_TO")
    $missing = $vars | Where-Object { -not (Get-Item "Env:$_" -ErrorAction SilentlyContinue) }
    if ($missing) {
        Write-Host "SKIP: set these env vars first:" -ForegroundColor DarkYellow
        $missing | ForEach-Object { Write-Host "  $_" }
        Write-Host ""
        Write-Host "Example (Gmail app password):" -ForegroundColor Gray
        Write-Host '  $env:CLAUDE_SKILLS_SMTP_HOST="smtp.gmail.com"'
        Write-Host '  $env:CLAUDE_SKILLS_SMTP_PORT="587"'
        Write-Host '  $env:CLAUDE_SKILLS_SMTP_USER="you@gmail.com"'
        Write-Host '  $env:CLAUDE_SKILLS_SMTP_PASSWORD="app-password"'
        Write-Host '  $env:CLAUDE_SKILLS_REPORT_TO="you@gmail.com"'
        Write-Host '  py scripts/send_weekly_report.py --target . --email'
    } else {
        py scripts/send_weekly_report.py --target $root --email
    }
}

Write-Host ""
Write-Host "In VS Code/Cursor: Command Palette -> Claude Skills: Send Weekly AI Usage Report" -ForegroundColor Cyan
