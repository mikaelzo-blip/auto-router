$ErrorActionPreference = "Stop"

$Project = Split-Path -Parent $PSScriptRoot
$NineRoot = Join-Path $env:APPDATA "npm\node_modules\9router"
$NineApp = Join-Path $NineRoot "app"
$NineServer = Join-Path $NineApp "custom-server.js"
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$NineUrl = "http://127.0.0.1:20128"
$AutoUrl = "http://127.0.0.1:20200"
$RuntimeDir = Join-Path $PSScriptRoot ".runtime"
$PathValue = $env:Path
Remove-Item Env:PATH -ErrorAction SilentlyContinue
$env:Path = $PathValue

function Pass($message) { Write-Host "[PASS] $message" -ForegroundColor Green }
function Fail($message) { Write-Host "[FAIL] $message" -ForegroundColor Red; throw $message }

function Get-EnvValue($name) {
    $line = Get-Content (Join-Path $Project ".env") |
        Where-Object { $_ -match "^$name=" } |
        Select-Object -First 1
    if (-not $line) { return $null }
    return $line.Substring($line.IndexOf("=") + 1).Trim().Trim('"').Trim("'")
}

$NineKey = Get-EnvValue "UPSTREAM_API_KEY"
if (-not $NineKey) { Fail "UPSTREAM_API_KEY is missing from .env" }
$Headers = @{ Authorization = "Bearer $NineKey" }

function Get-PortOwner($port) {
    $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $connection) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $process) { Fail "Cannot verify the command line for PID $($connection.OwningProcess); refusing to stop it" }
    return $process
}

function Test-NineRouter {
    try {
        $models = Invoke-RestMethod "$NineUrl/v1/models" -Headers $Headers -TimeoutSec 5
        $ids = @($models.data | ForEach-Object { $_.id })
        $required = @("ar-fast", "ar-code", "ar-analysis", "ar-research")
        $missing = @($required | Where-Object { $_ -notin $ids })
        if ($missing.Count -eq 0) { return $ids }
    } catch { }
    return $null
}

function Start-DetachedNode($workingDirectory, $arguments, $stdout, $stderr) {
    Start-Process -FilePath $Node -ArgumentList $arguments -WorkingDirectory $workingDirectory -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden | Out-Null
}

Set-Location $Project
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
Write-Host "Hermes local stack (manual launcher)" -ForegroundColor Cyan

$models = Test-NineRouter
if ($models) {
    Pass "9Router API healthy; required combos present ($($models.Count) models)"
} else {
    $owner = Get-PortOwner 20128
    if ($owner) {
        $isNine = $owner.Name -eq "node.exe" -and $owner.CommandLine -match "(?i)9router[\\/]app[\\/]custom-server\.js"
        if (-not $isNine) { Fail "Port 20128 is occupied by an unverified process; refusing to stop it" }
        Write-Host "[INFO] Verified stale/hung 9Router PID $($owner.ProcessId); stopping it" -ForegroundColor Yellow
        Stop-Process -Id $owner.ProcessId -Force
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 250
            if (-not (Get-PortOwner 20128)) { break }
        }
        if (Get-PortOwner 20128) { Fail "9Router port did not release" }
    } else {
        Write-Host "[INFO] 9Router is not running; starting it" -ForegroundColor Yellow
    }

    if (-not (Test-Path $NineServer)) { Fail "9Router production server not found: $NineServer" }
    $nineOut = Join-Path $RuntimeDir "9router.out.log"
    $nineErr = Join-Path $RuntimeDir "9router.err.log"
    Remove-Item $nineOut, $nineErr -Force -ErrorAction SilentlyContinue
    $oldPort = $env:PORT; $oldHost = $env:HOSTNAME
    $env:PORT = "20128"; $env:HOSTNAME = "127.0.0.1"
    Start-DetachedNode $NineApp "--dns-result-order=ipv4first --max-old-space-size=6144 `"$NineServer`"" $nineOut $nineErr
    if ($null -eq $oldPort) { Remove-Item Env:PORT -ErrorAction SilentlyContinue } else { $env:PORT = $oldPort }
    if ($null -eq $oldHost) { Remove-Item Env:HOSTNAME -ErrorAction SilentlyContinue } else { $env:HOSTNAME = $oldHost }

    for ($i = 1; $i -le 30; $i++) {
        Start-Sleep -Seconds 1
        $models = Test-NineRouter
        if ($models) { break }
    }
    if (-not $models) { Fail "9Router did not become API-healthy within 30 seconds" }
    Pass "9Router API healthy; required combos present ($($models.Count) models)"
}

& npm run build
if ($LASTEXITCODE -ne 0) { Fail "AutoRouter production build failed" }
Pass "AutoRouter production build"

$autoReady = $false
try {
    $ready = Invoke-RestMethod "$AutoUrl/health/ready" -TimeoutSec 5
    $autoReady = $ready.status -eq "ready"
} catch { }

if (-not $autoReady) {
    $autoOwner = Get-PortOwner 20200
    if ($autoOwner) {
        $isAuto = $autoOwner.Name -eq "node.exe" -and $autoOwner.CommandLine -match "(?i)(^|[\\/ ])dist[\\/]index\.js([ ]|$)"
        if (-not $isAuto) { Fail "Port 20200 is occupied by an unverified process; refusing to stop it" }
        Stop-Process -Id $autoOwner.ProcessId -Force
        Start-Sleep -Seconds 1
    }
    $autoOut = Join-Path $RuntimeDir "autorouter.out.log"
    $autoErr = Join-Path $RuntimeDir "autorouter.err.log"
    Remove-Item $autoOut, $autoErr -Force -ErrorAction SilentlyContinue
    Start-DetachedNode $Project "dist/index.js" $autoOut $autoErr
}

for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $ready = Invoke-RestMethod "$AutoUrl/health/ready" -TimeoutSec 5
        if ($ready.status -eq "ready") { $autoReady = $true; break }
    } catch { }
}
if (-not $autoReady) { Fail "AutoRouter /health/ready did not report ready within 30 seconds" }
Pass "AutoRouter /health/ready status=ready"
Write-Host "[PASS] Stack ready: AutoRouter 20200 -> 9Router 20128" -ForegroundColor Green
