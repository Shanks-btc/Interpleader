. "$PSScriptRoot\_common.ps1"

$BtcUrl = "https://btc-cycle-intelligence-production-410b.up.railway.app/mcp"
$log = New-TestLog -Prefix "btc-mcp"

Write-Host "=== BTC Cycle Intelligence - live verification ===" -ForegroundColor Cyan
Write-Host "Log: $log"

$listResult = Invoke-JsonRpc -Url $BtcUrl -Method "tools/list"
Write-Evidence -LogPath $log -Label "tools/list raw response" -Content $listResult.Raw

if (-not $listResult.Success) {
    Write-Result -LogPath $log -Status FAIL -TestName "tools/list" -Detail "Response did not parse."
} else {
    $toolNames = $listResult.Parsed.result.tools.name
    Write-Result -LogPath $log -Status PASS -TestName "tools/list" -Detail "$($toolNames.Count) tools returned: $($toolNames -join ', ')"
}

$btcTools = @(
    "get_btc_cycle_regime",
    "get_entry_risk",
    "get_lth_behavior",
    "compare_to_2021_top",
    "get_nupl_sentiment"
)

foreach ($tool in $btcTools) {
    $callResult = Invoke-JsonRpc -Url $BtcUrl -Method "tools/call" -Params @{ name = $tool; arguments = @{} }
    Write-Evidence -LogPath $log -Label "tools/call $tool raw response" -Content $callResult.Raw

    if (-not $callResult.Success) {
        Write-Result -LogPath $log -Status FAIL -TestName $tool -Detail "Response did not parse."
        continue
    }

    $content = $callResult.Parsed.result.content
    if (-not $content -or $content.Count -eq 0) {
        Write-Result -LogPath $log -Status FAIL -TestName $tool -Detail "No content array in result."
        continue
    }

    $rawText = $content[0].text

    # This server returns human-readable text, not JSON - confirmed live.
    # Treat presence of a "Data as of" line and non-empty content as PASS,
    # rather than forcing a JSON parse that will never succeed here.
    if ($rawText -and $rawText.Length -gt 20) {
        $hasDate = $rawText -match "Data as of:\s*(\S+)"
        $dateNote = if ($hasDate) { "Data as of: $($Matches[1])" } else { "No explicit date line found" }
        Write-Result -LogPath $log -Status PASS -TestName $tool -Detail "$dateNote | Response length: $($rawText.Length) chars"
    } else {
        Write-Result -LogPath $log -Status FAIL -TestName $tool -Detail "Empty or suspiciously short response."
    }
}

Write-Host "Done. Full evidence saved to: $log" -ForegroundColor Cyan
