$ErrorActionPreference = "Stop"

$Auto = "http://127.0.0.1:20200"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportPath = Join-Path $PSScriptRoot "..\benchmark-baseline-$timestamp.json"

function Percentile {
    param(
        [double[]]$Values,
        [double]$P
    )

    if (-not $Values -or $Values.Count -eq 0) {
        return 0
    }

    $sorted = $Values | Sort-Object
    $index = [Math]::Ceiling(($P / 100) * $sorted.Count) - 1
    if ($index -lt 0) { $index = 0 }
    if ($index -ge $sorted.Count) { $index = $sorted.Count - 1 }

    return [Math]::Round($sorted[$index], 1)
}

Write-Host "`n=== AUTOROUTER BASELINE BENCHMARK ===" -ForegroundColor Cyan

# ------------------------------------------------------------
# 1. HEALTH
# ------------------------------------------------------------

$health = Invoke-RestMethod "$Auto/health"

if ($health.status -ne "ok") {
    throw "AutoRouter health check gagal."
}

Write-Host "AutoRouter health : PASS" -ForegroundColor Green

# ------------------------------------------------------------
# 2. ROUTING ACCURACY
# Tidak memanggil model / tidak menghabiskan quota.
# ------------------------------------------------------------

$routeTests = @(
    @{ expected="fast-chat"; prompt="apa itu EBITDA?" },
    @{ expected="fast-chat"; prompt="translate hello world ke bahasa indonesia" },
    @{ expected="fast-chat"; prompt="jelaskan arti revenue secara singkat" },
    @{ expected="fast-chat"; prompt="rewrite kalimat ini supaya lebih formal" },

    @{ expected="smart-code"; prompt="fix this TypeScript error" },
    @{ expected="smart-code"; prompt="debug Python function ini" },
    @{ expected="smart-code"; prompt="tolong refactor repository Node.js ini" },
    @{ expected="smart-code"; prompt="buat unit test untuk API endpoint ini" },

    @{ expected="smart-analysis"; prompt="analisis laporan keuangan perusahaan ini" },
    @{ expected="smart-analysis"; prompt="audit invoice dan purchase order ini" },
    @{ expected="smart-analysis"; prompt="cek neraca dan arus kas perusahaan" },
    @{ expected="smart-analysis"; prompt="analisis kontrak dan SPK proyek ini" },

    @{ expected="web-research"; prompt="cari berita AI terbaru hari ini" },
    @{ expected="web-research"; prompt="berapa harga Bitcoin terbaru saat ini" },
    @{ expected="web-research"; prompt="cari versi Node.js terbaru" },
    @{ expected="web-research"; prompt="riset regulasi terbaru Indonesia" },

    @{ expected="smart-main"; prompt="bandingkan dua arsitektur microservice secara mendalam" },
    @{ expected="smart-main"; prompt="buat strategi implementasi sistem ERP kompleks" },
    @{ expected="smart-main"; prompt="evaluate trade-off antara PostgreSQL dan distributed database" },
    @{ expected="smart-main"; prompt="buat decision framework untuk memilih arsitektur aplikasi" }
)

$routeResults = @()

foreach ($t in $routeTests) {

    $body = @{
        model = "auto"
        messages = @(
            @{
                role = "user"
                content = $t.prompt
            }
        )
    } | ConvertTo-Json -Depth 10

    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    $result = Invoke-RestMethod `
        -Uri "$Auto/debug/route" `
        -Method POST `
        -ContentType "application/json" `
        -Body $body

    $sw.Stop()

    $correct = $result.route -eq $t.expected

    $routeResults += [PSCustomObject]@{
        prompt     = $t.prompt
        expected   = $t.expected
        actual     = $result.route
        correct    = $correct
        confidence = $result.confidence
        latency_ms = [Math]::Round($sw.Elapsed.TotalMilliseconds,1)
    }

    $symbol = if ($correct) { "PASS" } else { "FAIL" }

    if ($correct) {
        Write-Host "$symbol  $($t.expected) <- $($t.prompt)" -ForegroundColor Green
    }
    else {
        Write-Host "$symbol  expected=$($t.expected) actual=$($result.route) <- $($t.prompt)" -ForegroundColor Red
    }
}

$correctCount = @($routeResults | Where-Object correct).Count
$routeAccuracy = [Math]::Round(($correctCount / $routeResults.Count) * 100,1)

$routeLatency = @(
    $routeResults |
    ForEach-Object { [double]$_.latency_ms }
)

# ------------------------------------------------------------
# 3. END-TO-END BENCHMARK
# Ini benar-benar memanggil LLM.
# Total 8 requests.
# ------------------------------------------------------------

Write-Host "`n=== END-TO-END TEST ===" -ForegroundColor Cyan

$e2ePrompts = @(
    @{
        name   = "fast"
        prompt = "Jawab hanya satu kata: OK"
    },
    @{
        name   = "code"
        prompt = "Jelaskan secara singkat fungsi TypeScript map()"
    },
    @{
        name   = "analysis"
        prompt = "Jelaskan secara singkat perbedaan laba rugi dan arus kas"
    },
    @{
        name   = "research"
        prompt = "Jelaskan secara singkat apa arti informasi terbaru"
    }
)

$e2eResults = @()

foreach ($test in $e2ePrompts) {

    1..2 | ForEach-Object {

        $iteration = $_

        $body = @{
            model = "auto"
            stream = $false
            messages = @(
                @{
                    role = "user"
                    content = $test.prompt
                }
            )
        } | ConvertTo-Json -Depth 10

        $sw = [System.Diagnostics.Stopwatch]::StartNew()

        try {
            $response = Invoke-WebRequest `
                -Uri "$Auto/v1/chat/completions" `
                -Method POST `
                -ContentType "application/json" `
                -Body $body `
                -TimeoutSec 180

            $sw.Stop()

            $route = $response.Headers["x-auto-router-route"]

            $e2eResults += [PSCustomObject]@{
                test       = $test.name
                iteration  = $iteration
                route      = $route
                success    = $true
                latency_ms = [Math]::Round($sw.Elapsed.TotalMilliseconds,1)
            }

            Write-Host "$($test.name) #$iteration : $([Math]::Round($sw.Elapsed.TotalSeconds,2)) sec [$route]" -ForegroundColor Green
        }
        catch {
            $sw.Stop()

            $e2eResults += [PSCustomObject]@{
                test       = $test.name
                iteration  = $iteration
                route      = $null
                success    = $false
                latency_ms = [Math]::Round($sw.Elapsed.TotalMilliseconds,1)
                error      = $_.Exception.Message
            }

            Write-Host "$($test.name) #$iteration : FAIL" -ForegroundColor Red
        }
    }
}

$successfulE2E = @(
    $e2eResults |
    Where-Object success
)

$e2eLatency = @(
    $successfulE2E |
    ForEach-Object { [double]$_.latency_ms }
)

# ------------------------------------------------------------
# 4. SUMMARY
# ------------------------------------------------------------

$summary = [PSCustomObject]@{
    timestamp = (Get-Date).ToString("o")

    routing = @{
        tests       = $routeResults.Count
        correct     = $correctCount
        accuracy    = $routeAccuracy
        p50_ms      = Percentile $routeLatency 50
        p95_ms      = Percentile $routeLatency 95
    }

    end_to_end = @{
        tests       = $e2eResults.Count
        success     = $successfulE2E.Count
        p50_ms      = Percentile $e2eLatency 50
        p95_ms      = Percentile $e2eLatency 95
        min_ms      = if ($e2eLatency.Count) { [Math]::Round(($e2eLatency | Measure-Object -Minimum).Minimum,1) } else { 0 }
        max_ms      = if ($e2eLatency.Count) { [Math]::Round(($e2eLatency | Measure-Object -Maximum).Maximum,1) } else { 0 }
    }

    routing_results = $routeResults
    e2e_results     = $e2eResults
}

$summary |
ConvertTo-Json -Depth 10 |
Set-Content $reportPath -Encoding UTF8

Write-Host "`n==============================" -ForegroundColor Cyan
Write-Host "       BASELINE RESULT" -ForegroundColor Cyan
Write-Host "==============================" -ForegroundColor Cyan

Write-Host "Routing accuracy : $routeAccuracy%"
Write-Host "Routing p50      : $(Percentile $routeLatency 50) ms"
Write-Host "Routing p95      : $(Percentile $routeLatency 95) ms"

Write-Host ""
Write-Host "E2E success      : $($successfulE2E.Count)/$($e2eResults.Count)"
Write-Host "E2E p50          : $(Percentile $e2eLatency 50) ms"
Write-Host "E2E p95          : $(Percentile $e2eLatency 95) ms"

Write-Host ""
Write-Host "Report tersimpan:" -ForegroundColor Cyan
Write-Host $reportPath -ForegroundColor Yellow
