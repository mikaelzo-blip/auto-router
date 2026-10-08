$ErrorActionPreference = "Stop"

$Project = "C:\Projects\router\auto-router-v2"
$Nine    = "http://127.0.0.1:20128"

Set-Location $Project

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " AUTOROUTER PRODUCTION READINESS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$keyLine = Get-Content ".env" |
    Where-Object { $_ -match '^UPSTREAM_API_KEY=' } |
    Select-Object -First 1

if (-not $keyLine) {
    throw "UPSTREAM_API_KEY tidak ditemukan."
}

$key = $keyLine.Substring(
    $keyLine.IndexOf("=") + 1
).Trim().Trim('"').Trim("'")

$headers = @{
    Authorization = "Bearer $key"
}

$health = Invoke-RestMethod `
    "$Nine/api/health" `
    -TimeoutSec 5

if (-not $health.ok) {
    throw "9Router health gagal."
}

Write-Host "9Router health       : PASS" -ForegroundColor Green

$modelResponse = Invoke-RestMethod `
    "$Nine/v1/models" `
    -Headers $headers `
    -TimeoutSec 15

$available = @(
    $modelResponse.data.id
)

Write-Host "Models discovered    : $($available.Count)" -ForegroundColor Green

$cfg = Get-Content `
    ".\config\routes.json" `
    -Raw |
    ConvertFrom-Json

$required = @()

foreach (
    $property in
    $cfg.routes.PSObject.Properties
) {

    $route = $property.Value

    if (
      $route.selectionPriority -and
      $route.selectionPriority.Count -gt 0
    ) {
        $required +=
            $route.selectionPriority
    }
    else {
        $required +=
            $route.upstreamModel
    }
}

$required = @(
    $required |
    Where-Object { $_ } |
    Sort-Object -Unique
)

$missing = @(
    $required |
    Where-Object {
        $_ -notin $available
    }
)

if ($missing.Count -gt 0) {

    Write-Host "`nMissing upstream:" -ForegroundColor Red

    $missing |
    ForEach-Object {
        Write-Host "  $_" -ForegroundColor Red
    }

    throw "9Router readiness gagal."
}

Write-Host "Configured upstreams : PASS" -ForegroundColor Green
Write-Host "LLM startup probes   : 0" -ForegroundColor Green

npm run build

if ($LASTEXITCODE -ne 0) {
    throw "Build gagal."
}

Write-Host "Build                : PASS" -ForegroundColor Green

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " READINESS PASS - STARTING AUTOROUTER" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "9Router              : READY"
Write-Host "Models               : $($available.Count)"
Write-Host "Required upstreams   : $($required.Count)"
Write-Host "Startup LLM calls    : 0"
Write-Host "AutoRouter           : PRODUCTION"
Write-Host ""

node dist/index.js
