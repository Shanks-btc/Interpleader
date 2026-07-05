. "$PSScriptRoot\_common.ps1"

$SqueezeBase = "https://short-squeeze-intelligence-production-6b31.up.railway.app"
$SqueezeMcp = "$SqueezeBase/mcp"
$log = New-TestLog -Prefix "short-squeeze-mcp"

Write-Host "=== Short Squeeze Intelligence - live verification ===" -ForegroundColor Cyan
Write-Host "Log: $log"

$health = Invoke-WebRequest -Uri "$SqueezeBase/" -UseBasicParsing
Write-Evidence -LogPath $log -Label "health check raw response" -Content $health.Content
if ($health.Content -like "*status*ok*") {
    Write-Result -LogPath $log -Status PASS -TestName "health check" -Detail $health.Content
} else {
    Write-Result -LogPath $log -Status FAIL -TestName "health check" -Detail $health.Content
}

$listResult = Invoke-JsonRpc -Url $SqueezeMcp -Method "tools/list"
Write-Evidence -LogPath $log -Label "tools/list raw response" -Content $listResult.Raw

if (-not $listResult.Success) {
    Write-Result -LogPath $log -Status FAIL -TestName "tools/list" -Detail "Response did not parse."
} else {
    $toolNames = $listResult.Parsed.result.tools.name
    Write-Result -LogPath $log -Status PASS -TestName "tools/list" -Detail "$($toolNames.Count) tools returned"
}

$callSpecs = @(
    @{ tool = "get_squeeze_risk"; args = @{ ticker = "GME" } },
    @{ tool = "get_short_interest"; args = @{ ticker = "GME" } },
    @{ tool = "get_cost_to_borrow"; args = @{ ticker = "GME" } },
    @{ tool = "compare_squeeze_risk"; args = @{ ticker1 = "CVNA"; ticker2 = "GME" } },
    @{ tool = "get_short_interest_trend"; args = @{ ticker = "GME" } }
)

foreach ($spec in $callSpecs) {
    $tool = $spec.tool
    $callResult = Invoke-JsonRpc -Url $SqueezeMcp -Method "tools/call" -Params @{ name = $tool; arguments = $spec.args }
    Write-Evidence -LogPath $log -Label "tools/call $tool raw response" -Content $callResult.Raw

    if (-not $callResult.Success) {
        Write-Result -LogPath $log -Status FAIL -TestName $tool -Detail "Response did not parse."
        continue
    }
    $content = $callResult.Parsed.result.content
    if (-not $content -or $content.Count -eq 0) {
        Write-Result -LogPath $log -Status FAIL -TestName $tool -Detail "No content array."
        continue
    }
    $data = $content[0].text | ConvertFrom-Json
    $detail = "ticker=$($data.ticker), asOf=$($data.asOf), confidence=$($data.confidence), regime=$($data.regime)"
    Write-Result -LogPath $log -Status PASS -TestName $tool -Detail $detail
}

Write-Host "Done. Full evidence saved to: $log" -ForegroundColor Cyan
