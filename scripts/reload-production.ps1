param(
    [string]$QuotaPolicy = "",
    [string]$SonnetAgenticEnabled = ""
)

$ErrorActionPreference = "Stop"
$Project = "C:\Projects\router\auto-router-v2"
$EnvPath = Join-Path $Project ".env"
$RuntimeDir = Join-Path $Project "scripts\.runtime"
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$Node = (Get-Command node.exe -ErrorAction Stop).Source

if ($QuotaPolicy -in @("shadow", "auto", "off")) {
    $envContent = Get-Content $EnvPath
    $newContent = @()
    $found = $false
    foreach ($line in $envContent) {
        if ($line -match '^QUOTA_POLICY=') {
            $newContent += "QUOTA_POLICY=$QuotaPolicy"
            $found = $true
        } else {
            $newContent += $line
        }
    }
    if (-not $found) {
        $newContent += "QUOTA_POLICY=$QuotaPolicy"
    }
    $newContent | Set-Content $EnvPath
    Write-Host "Set QUOTA_POLICY=$QuotaPolicy in .env"
}

if ($SonnetAgenticEnabled -in @("true", "false")) {
    $envContent = Get-Content $EnvPath
    $newContent = @()
    $found = $false
    foreach ($line in $envContent) {
        if ($line -match '^SONNET_AGENTIC_ENABLED=') {
            $newContent += "SONNET_AGENTIC_ENABLED=$SonnetAgenticEnabled"
            $found = $true
        } else {
            $newContent += $line
        }
    }
    if (-not $found) {
        $newContent += "SONNET_AGENTIC_ENABLED=$SonnetAgenticEnabled"
    }
    $newContent | Set-Content $EnvPath
    Write-Host "Set SONNET_AGENTIC_ENABLED=$SonnetAgenticEnabled in .env"
}

$oldConn = Get-NetTCPConnection -LocalPort 20200 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$oldPid = $null
if ($oldConn) {
    $oldPid = $oldConn.OwningProcess
    Write-Host "Stopping existing production PID: $oldPid"
    Stop-Process -Id $oldPid -Force
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

for ($i = 0; $i -lt 50; $i++) {
    $check = Get-NetTCPConnection -LocalPort 20200 -State Listen -ErrorAction SilentlyContinue
    if (-not $check) { break }
    Start-Sleep -Milliseconds 50
}

$autoOut = Join-Path $RuntimeDir "autorouter.out.log"
$autoErr = Join-Path $RuntimeDir "autorouter.err.log"

$proc = Start-Process -FilePath $Node -ArgumentList "dist/index.js" -WorkingDirectory $Project -RedirectStandardOutput $autoOut -RedirectStandardError $autoErr -WindowStyle Hidden -PassThru

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 100
    try {
        $res = Invoke-RestMethod "http://127.0.0.1:20200/health" -TimeoutSec 1
        if ($res.status -eq "ok") {
            $ready = $true
            break
        }
    } catch { }
}

$sw.Stop()
$downtimeMs = $sw.ElapsedMilliseconds

if (-not $ready) {
    throw "AutoRouter failed to become ready on 20200"
}

Write-Host "SUCCESS: AutoRouter listening on port 20200"
Write-Host "PID: $($proc.Id)"
Write-Host "Downtime: $($downtimeMs)ms"
