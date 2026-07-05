$script:LogDir = Join-Path $PSScriptRoot "..\logs\tests"
if (-not (Test-Path $script:LogDir)) {
    New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null
}

function New-TestLog {
    param([string]$Prefix)
    $ts = Get-Date -Format "yyyyMMdd-HHmmss"
    $path = Join-Path $script:LogDir "$Prefix-$ts.log"
    "Valiquo test run: $Prefix" | Out-File -FilePath $path -Encoding utf8
    "Started: $(Get-Date -Format o)" | Out-File -FilePath $path -Append -Encoding utf8
    "---" | Out-File -FilePath $path -Append -Encoding utf8
    return $path
}

function Write-Result {
    param(
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter(Mandatory)][ValidateSet("PASS","FAIL","SKIPPED","BLOCKED")][string]$Status,
        [Parameter(Mandatory)][string]$TestName,
        [string]$Detail = ""
    )
    $line = "[$Status] $TestName"
    if ($Detail) { $line += " - $Detail" }
    if ($Status -eq "PASS") { Write-Host $line -ForegroundColor Green }
    if ($Status -eq "FAIL") { Write-Host $line -ForegroundColor Red }
    if ($Status -eq "SKIPPED") { Write-Host $line -ForegroundColor Yellow }
    if ($Status -eq "BLOCKED") { Write-Host $line -ForegroundColor DarkYellow }
    $line | Out-File -FilePath $LogPath -Append -Encoding utf8
}

function Write-Evidence {
    param(
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$Content
    )
    "--- $Label ---" | Out-File -FilePath $LogPath -Append -Encoding utf8
    $Content | Out-File -FilePath $LogPath -Append -Encoding utf8
    "" | Out-File -FilePath $LogPath -Append -Encoding utf8
}

function Test-EnvVarPresent {
    param([Parameter(Mandatory)][string]$VarName)
    $val = [System.Environment]::GetEnvironmentVariable($VarName)
    return -not [string]::IsNullOrWhiteSpace($val)
}

function Invoke-JsonRpc {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$Method,
        [hashtable]$Params = @{}
    )
    $bodyObj = @{ jsonrpc = "2.0"; id = 1; method = $Method; params = $Params }
    $bodyJson = $bodyObj | ConvertTo-Json -Depth 10 -Compress
    $headers = @{ "Content-Type" = "application/json"; "Accept" = "application/json, text/event-stream" }

    try {
        $response = Invoke-WebRequest -Uri $Url -Method POST -Headers $headers -Body $bodyJson -UseBasicParsing
        $rawText = $response.Content
        $dataLine = ($rawText -split "`n") | Where-Object { $_ -like "data:*" } | Select-Object -First 1
        $jsonText = $rawText.Trim()
        if ($dataLine) { $jsonText = $dataLine.Substring(5).Trim() }
        $parsedObj = $jsonText | ConvertFrom-Json
        return [PSCustomObject]@{ Raw = $rawText; Parsed = $parsedObj; Success = $true }
    } catch {
        $errDetail = $_.Exception.Message
        return [PSCustomObject]@{ Raw = "Request failed: $errDetail"; Parsed = $null; Success = $false }
    }
}
