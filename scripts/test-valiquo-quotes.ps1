. "$PSScriptRoot\_common.ps1"

$Base = "http://localhost:3000"
$log = New-TestLog -Prefix "valiquo-quotes"

Write-Host "=== Valiquo local /quote and /pay/:id verification ===" -ForegroundColor Cyan
Write-Host "Log: $log"

function Invoke-Quote {
    param([string]$Tool, [double]$ProposedPrice, [hashtable]$ToolArgs = @{})
    $bodyObj = @{ tool = $Tool; proposedPrice = $ProposedPrice; args = $ToolArgs }
    $bodyJson = $bodyObj | ConvertTo-Json -Compress
    try {
        $response = Invoke-WebRequest -Uri "$Base/quote" -Method POST -Headers @{ "Content-Type" = "application/json" } -Body $bodyJson -UseBasicParsing
        return [PSCustomObject]@{ Raw = $response.Content; Parsed = ($response.Content | ConvertFrom-Json); Success = $true; StatusCode = $response.StatusCode }
    } catch {
        $statusCode = $null
        $errBody = ""
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream)
                $errBody = $reader.ReadToEnd()
            } catch {}
        }
        return [PSCustomObject]@{ Raw = "HTTP $statusCode : $errBody"; Parsed = $null; Success = $false; StatusCode = $statusCode }
    }
}

$r1 = Invoke-Quote -Tool "get_btc_cycle_regime" -ProposedPrice 0.02
Write-Evidence -LogPath $log -Label "Case 1: offer above list" -Content $r1.Raw
if ($r1.Success -and $r1.Parsed.decision -eq "accept" -and $r1.Parsed.agreedPrice -eq 0.008) {
    Write-Result -LogPath $log -Status PASS -TestName "Offer above list price" -Detail "accept @ $($r1.Parsed.agreedPrice)"
} else {
    Write-Result -LogPath $log -Status FAIL -TestName "Offer above list price" -Detail $r1.Raw
}

$r2 = Invoke-Quote -Tool "get_btc_cycle_regime" -ProposedPrice 0.005
Write-Evidence -LogPath $log -Label "Case 2: offer between reserve/list" -Content $r2.Raw
if ($r2.Success -and $r2.Parsed.decision -eq "accept" -and $r2.Parsed.agreedPrice -eq 0.005) {
    Write-Result -LogPath $log -Status PASS -TestName "Offer between reserve and list" -Detail "accept @ $($r2.Parsed.agreedPrice)"
} else {
    Write-Result -LogPath $log -Status FAIL -TestName "Offer between reserve and list" -Detail $r2.Raw
}

$r3 = Invoke-Quote -Tool "get_btc_cycle_regime" -ProposedPrice 0.002
Write-Evidence -LogPath $log -Label "Case 3: offer below reserve, near enough" -Content $r3.Raw
if ($r3.Success -and $r3.Parsed.decision -eq "counter" -and $r3.Parsed.agreedPrice -eq 0.003) {
    Write-Result -LogPath $log -Status PASS -TestName "Offer below reserve (counter range)" -Detail "counter @ $($r3.Parsed.agreedPrice)"
} else {
    Write-Result -LogPath $log -Status FAIL -TestName "Offer below reserve (counter range)" -Detail $r3.Raw
}

$r4 = Invoke-Quote -Tool "get_btc_cycle_regime" -ProposedPrice 0.0005
Write-Evidence -LogPath $log -Label "Case 4: offer far below reserve" -Content $r4.Raw
if ($r4.Success -and $r4.Parsed.decision -eq "reject") {
    Write-Result -LogPath $log -Status PASS -TestName "Offer far below reserve (reject)" -Detail $r4.Parsed.reason
} else {
    Write-Result -LogPath $log -Status FAIL -TestName "Offer far below reserve (reject)" -Detail $r4.Raw
}

$r5 = Invoke-Quote -Tool "not_a_real_tool" -ProposedPrice 0.01
Write-Evidence -LogPath $log -Label "Case 5: invalid tool" -Content $r5.Raw
if ($r5.Success -and $r5.Parsed.decision -eq "reject" -and $r5.Parsed.reason -like "*Unknown tool*") {
    Write-Result -LogPath $log -Status PASS -TestName "Invalid tool name" -Detail $r5.Parsed.reason
} else {
    Write-Result -LogPath $log -Status FAIL -TestName "Invalid tool name" -Detail $r5.Raw
}

try {
    $raw6 = Invoke-WebRequest -Uri "$Base/quote" -Method POST -Headers @{ "Content-Type" = "application/json" } -Body '{"tool":"get_btc_cycle_regime"}' -UseBasicParsing
    Write-Result -LogPath $log -Status FAIL -TestName "Missing proposedPrice" -Detail "Expected 400 but got $($raw6.StatusCode)"
} catch {
    $sc = [int]$_.Exception.Response.StatusCode
    if ($sc -eq 400) { Write-Result -LogPath $log -Status PASS -TestName "Missing proposedPrice" -Detail "Correctly returned 400" }
    else { Write-Result -LogPath $log -Status FAIL -TestName "Missing proposedPrice" -Detail "Got $sc instead of 400" }
}

try {
    $raw7 = Invoke-WebRequest -Uri "$Base/quote" -Method POST -Headers @{ "Content-Type" = "application/json" } -Body '{"tool":"get_btc_cycle_regime","proposedPrice":"free please"}' -UseBasicParsing
    Write-Result -LogPath $log -Status FAIL -TestName "Malformed price (non-numeric)" -Detail "Expected 400 but got $($raw7.StatusCode)"
} catch {
    $sc = [int]$_.Exception.Response.StatusCode
    if ($sc -eq 400) { Write-Result -LogPath $log -Status PASS -TestName "Malformed price (non-numeric)" -Detail "Correctly returned 400" }
    else { Write-Result -LogPath $log -Status FAIL -TestName "Malformed price (non-numeric)" -Detail "Got $sc instead of 400" }
}

Write-Host "--- /pay/:id verification (no payment made) ---" -ForegroundColor Cyan

$validQuote = Invoke-Quote -Tool "get_btc_cycle_regime" -ProposedPrice 0.008
Write-Evidence -LogPath $log -Label "Fresh quote for pay-route testing" -Content $validQuote.Raw

if (-not $validQuote.Success -or -not $validQuote.Parsed.quoteId) {
    Write-Result -LogPath $log -Status BLOCKED -TestName "/pay/:id tests" -Detail "Could not obtain a valid quoteId to test against."
} else {
    $quoteId = $validQuote.Parsed.quoteId
    $payUrl = "$Base/pay/$quoteId"

    try {
        $r8 = Invoke-WebRequest -Uri $payUrl -UseBasicParsing
        Write-Result -LogPath $log -Status FAIL -TestName "Unpaid request returns 402" -Detail "Expected 402 but got $($r8.StatusCode)"
    } catch {
        $sc = [int]$_.Exception.Response.StatusCode
        if ($sc -eq 402) { Write-Result -LogPath $log -Status PASS -TestName "Unpaid request returns 402" -Detail "Payment requirements present." }
        else { Write-Result -LogPath $log -Status FAIL -TestName "Unpaid request returns 402" -Detail "Got $sc instead of 402" }
    }

    try {
        $r9 = Invoke-WebRequest -Uri $payUrl -UseBasicParsing
        Write-Result -LogPath $log -Status FAIL -TestName "Duplicate unpaid request is safe" -Detail "Expected 402 but got $($r9.StatusCode)"
    } catch {
        $sc = [int]$_.Exception.Response.StatusCode
        if ($sc -eq 402) { Write-Result -LogPath $log -Status PASS -TestName "Duplicate unpaid request is safe" -Detail "Still 402, no crash." }
        else { Write-Result -LogPath $log -Status FAIL -TestName "Duplicate unpaid request is safe" -Detail "Got $sc instead of 402" }
    }

    Write-Result -LogPath $log -Status SKIPPED -TestName "Quote immutability after issuance" -Detail "No route exists to mutate an existing quote."
}

Write-Host "--- Known adapter bug status ---" -ForegroundColor Cyan
Write-Result -LogPath $log -Status BLOCKED -TestName "MCP adapter runtime verification" -Detail "Confirmed present: callMcpTool() references undefined BTC_CYCLE_MCP_URL instead of MCP_SERVERS[tool]. Known, pre-confirmed BLOCKED item."

Write-Host "Done. Full evidence saved to: $log" -ForegroundColor Cyan
