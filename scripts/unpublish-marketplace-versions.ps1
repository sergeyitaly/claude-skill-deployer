# Unpublish specific VS Marketplace versions of Claude Skills Manager.
# vsce unpublish removes the ENTIRE extension; per-version delete uses the Gallery REST API.
#
# Requires: $env:VSCE_PAT with Marketplace (Manage) scope.
#
# From repo root:
#   $env:VSCE_PAT = '<your-azure-devops-pat>'
#   .\scripts\unpublish-marketplace-versions.ps1
#
# Optional: -From 1.0.2 -To 1.0.16
# Optional: -IncludeLatest (only after a newer version is published; latest cannot be deleted)

param(
  [string]$PublisherExtension = "serhiivoinolovych.claude-skill-deployer",
  [string]$From = "1.0.2",
  [string]$To = "1.0.16",
  [switch]$IncludeLatest
)

$ErrorActionPreference = "Stop"

if (-not $env:VSCE_PAT) {
  Write-Error "Set VSCE_PAT first (Azure DevOps PAT with Marketplace Manage scope)."
}

function Parse-Version([string]$v) {
  return [version]$v
}

function Get-LatestVersion([string[]]$versions) {
  $sorted = $versions | Sort-Object { Parse-Version $_ } -Descending
  return $sorted[0]
}

function Remove-MarketplaceExtensionVersion {
  param(
    [string]$Publisher,
    [string]$ExtensionName,
    [string]$Version,
    [string]$Pat
  )

  $auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$Pat"))
  $headers = @{ Authorization = "Basic $auth" }
  $uri = "https://marketplace.visualstudio.com/_apis/gallery/publishers/$Publisher/extensions/$ExtensionName?api-version=7.1-preview.2&version=$Version"

  try {
    Invoke-RestMethod -Method Delete -Uri $uri -Headers $headers | Out-Null
    return $true
  } catch {
    $status = $null
    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
    }
    $body = $_.ErrorDetails.Message
    if (-not $body) { $body = $_.Exception.Message }
    Write-Warning "HTTP $status deleting $Version`: $body"
    return $false
  }
}

if ($PublisherExtension -notmatch '^([^.]+)\.(.+)$') {
  Write-Error "PublisherExtension must be publisher.extension-name (got '$PublisherExtension')."
}
$publisher = $Matches[1]
$extensionName = $Matches[2]

$fromV = Parse-Version $From
$toV = Parse-Version $To
$extensionRoot = (Join-Path $PSScriptRoot "..\extension" | Resolve-Path).Path

Push-Location $extensionRoot
try {
  $showJson = npx --yes vsce show $PublisherExtension --json 2>&1 | Out-String
  if ($showJson -notmatch "^\s*\{") {
    Write-Error "vsce show failed:`n$showJson"
  }
  $meta = $showJson | ConvertFrom-Json

  $allVersions = @($meta.versions | ForEach-Object { $_.version })
  if ($allVersions.Count -eq 0) {
    Write-Host "No published versions found."
    exit 0
  }

  $latest = Get-LatestVersion $allVersions
  Write-Host "Marketplace latest version: $latest"

  $targets = @($allVersions | Where-Object {
      $ver = Parse-Version $_
      $ver -ge $fromV -and $ver -le $toV
    } | Sort-Object { Parse-Version $_ })

  if ($targets.Count -eq 0) {
    Write-Host "No published versions in range $From .. $To."
    exit 0
  }

  if (-not $IncludeLatest -and ($targets -contains $latest)) {
    Write-Host "Skipping latest version $latest (Marketplace blocks deleting the current latest)."
    Write-Host "Publish a newer version first, then re-run with -IncludeLatest to remove it."
    $targets = @($targets | Where-Object { $_ -ne $latest })
  }

  if ($targets.Count -eq 0) {
    Write-Host "Nothing to unpublish after excluding latest."
    exit 0
  }

  Write-Host "Will unpublish $($targets.Count) version(s): $($targets -join ', ')"
  $failed = @()
  foreach ($ver in $targets) {
    Write-Host "Deleting $publisher/$extensionName version $ver ..."
    $ok = Remove-MarketplaceExtensionVersion -Publisher $publisher -ExtensionName $extensionName -Version $ver -Pat $env:VSCE_PAT
    if ($ok) {
      Write-Host "OK: $ver"
    } else {
      $failed += $ver
    }
  }

  if ($failed.Count -gt 0) {
    Write-Warning "Failed to delete: $($failed -join ', ')"
    exit 1
  }
  Write-Host "Done."
} finally {
  Pop-Location
}
