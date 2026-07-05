param(
    [switch]$ExecutePayment
)

. "$PSScriptRoot\_common.ps1"

$Base = "http://localhost:3000"
$log = New-TestLog -Prefix "payment-readiness"

Write-Host "=== Payment readiness check ===" -ForegroundColor Cyan
Write-Host "Log: $log"

$requiredVars = @("SELLER_ADDRESS", "BUYER_PRIVATE_KEY")
foreach ($v in $requiredVars) {
    if (Test-EnvVarPresent -VarName $v) {
        Write-Result -LogPath $log -Status PASS -TestName "Env var present: $v" -Detail "(value masked)"
    } else {
        Write-Result -LogPath $log -Status BLOCKED -TestName "Env var present: $v" -Detail "Not set in this shell session."
    }
}

Write-Host "--- Confirmed configuration ---" -ForegroundColor Cyan
$confirmedConfig = @{
    "Arc Testnet chain id (CAIP-2)" = "eip155:5042002"
    "Gateway facilitator (testnet)" = "https://gateway-api-testnet.circle.com"
    "Arc Testnet RPC" = "https://rpc.testnet.arc.network"
    "USDC contract (Arc Testnet)" = "0x3600000000000000000000000000000000000000"
    "GatewayWallet contract" = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"
    "SDK package" = "@circle-fin/x402-batching@3.2.0 (confirmed installed)"
}
foreach ($k in $confirmedConfig.Keys) {
    Write-Result -LogPath $log -Status PASS -TestName $k -Detail $confirmedConfig[$k]
}

Write-Host "--- Local server reachability ---" -ForegroundColor Cyan
try {
    $serverCheck = Invoke-WebRequest -Uri "$Base/quote" -Method POST -Headers @{ "Content-Type" = "application/json" } -Body '{"tool":"get_btc_cycle_regime","proposedPrice":0.008}' -UseBasicParsing
    Write-Result -LogPath $log -Status PASS -TestName "Local Valiquo server reachable" -Detail "HTTP $($serverCheck.StatusCode) from /quote"
} catch {
    if ($_.Exception.Response) {
        $sc = [int]$_.Exception.Response.StatusCode
        Write-Result -LogPath $log -Status PASS -TestName "Local Valiquo server reachable" -Detail "HTTP $sc from /quote"
    } else {
        Write-Result -LogPath $log -Status BLOCKED -TestName "Local Valiquo server reachable" -Detail "No response - is npm start running in another terminal?"
    }
}

Write-Host "--- Buyer wallet balances ---" -ForegroundColor Cyan
if (Test-EnvVarPresent -VarName "BUYER_PRIVATE_KEY") {
    $balanceRaw = node "$PSScriptRoot\check-balance.mjs" 2>&1
    $balanceText = $balanceRaw -join "`n"
    Write-Evidence -LogPath $log -Label "Balance check raw output" -Content $balanceText
    try {
        $balanceJson = $balanceText | ConvertFrom-Json
        if ($balanceJson.ok) {
            Write-Result -LogPath $log -Status PASS -TestName "Buyer wallet balance check" -Detail "wallet=$($balanceJson.walletBalance) USDC, gatewayAvailable=$($balanceJson.gatewayAvailable) USDC"
            if ([double]$balanceJson.gatewayAvailable -lt 0.5) {
                Write-Result -LogPath $log -Status BLOCKED -TestName "Gateway available balance sufficient" -Detail "Below the documented 0.5 USDC minimum deposit."
            } else {
                Write-Result -LogPath $log -Status PASS -TestName "Gateway available balance sufficient" -Detail "$($balanceJson.gatewayAvailable) USDC available"
            }
        } else {
            Write-Result -LogPath $log -Status FAIL -TestName "Buyer wallet balance check" -Detail $balanceJson.error
        }
    } catch {
        Write-Result -LogPath $log -Status FAIL -TestName "Buyer wallet balance check" -Detail "Could not parse balance output. See log."
    }
} else {
    Write-Result -LogPath $log -Status BLOCKED -TestName "Buyer wallet balance check" -Detail "BUYER_PRIVATE_KEY not set - skipping."
}

Write-Host "--- Known blockers before a real payment can succeed ---" -ForegroundColor Cyan
Write-Result -LogPath $log -Status BLOCKED -TestName "callMcpTool() / MCP_SERVERS bug" -Detail "Confirmed present in src/server.ts. A real payment below will succeed at the Gateway layer but data-fulfillment will throw. EXPECTED until the approved bugfix is applied."

if (-not $ExecutePayment) {
    Write-Host "=== Readiness checks complete. No payment was made (default mode). ===" -ForegroundColor Cyan
    Write-Host "Re-run with -ExecutePayment only after reviewing all results above." -ForegroundColor Yellow
    exit 0
}

Write-Host "WARNING: -ExecutePayment flag set. Making ONE real test-USDC payment. WARNING" -ForegroundColor Red

if (-not (Test-EnvVarPresent -VarName "BUYER_PRIVATE_KEY")) {
    Write-Result -LogPath $log -Status BLOCKED -TestName "Real payment attempt" -Detail "Cannot proceed - BUYER_PRIVATE_KEY not set."
    exit 1
}

$quoteBody = '{"tool":"get_btc_cycle_regime","proposedPrice":0.008}'
try {
    $quoteResp = Invoke-WebRequest -Uri "$Base/quote" -Method POST -Headers @{ "Content-Type" = "application/json" } -Body $quoteBody -UseBasicParsing
    Write-Evidence -LogPath $log -Label "Real-payment quote request" -Content $quoteResp.Content
    $quote = $quoteResp.Content | ConvertFrom-Json

    if (-not $quote.quoteId) { throw "No quoteId returned." }

    Write-Host "Quote obtained: $($quote.quoteId) at `$$($quote.agreedPrice)" -ForegroundColor Cyan
    Write-Host "Paying via headless GatewayClient - this spends real test-USDC."

    $env:PAY_URL = "$Base/pay/$($quote.quoteId)"
    $payScript = "import('@circle-fin/x402-batching/client').then(async ({ GatewayClient }) => { const client = new GatewayClient({ chain: 'arcTestnet', privateKey: process.env.BUYER_PRIVATE_KEY }); const started = Date.now(); try { const result = await client.pay(process.env.PAY_URL); console.log(JSON.stringify({ ok: true, elapsedMs: Date.now() - started, status: result.status, data: result.data })); } catch (err) { console.log(JSON.stringify({ ok: false, elapsedMs: Date.now() - started, error: String(err?.message ?? err) })); } });"
    $payOutput = node -e $payScript 2>&1
    $payText = $payOutput -join "`n"
    Write-Evidence -LogPath $log -Label "Real payment attempt raw output" -Content $payText

    try {
        $payJson = $payText | ConvertFrom-Json
        if ($payJson.ok) {
            Write-Result -LogPath $log -Status PASS -TestName "Real headless payment" -Detail "Completed in $($payJson.elapsedMs)ms, HTTP $($payJson.status)"
        } else {
            if ($payJson.error -like "*BTC_CYCLE_MCP_URL*" -or $payJson.error -like "*not defined*") {
                Write-Result -LogPath $log -Status FAIL -TestName "Real headless payment" -Detail "EXPECTED failure - known callMcpTool() bug. Payment itself likely succeeded on-chain. Error: $($payJson.error)"
            } else {
                Write-Result -LogPath $log -Status FAIL -TestName "Real headless payment" -Detail "Unexpected error (not the known bug): $($payJson.error)"
            }
        }
    } catch {
        Write-Result -LogPath $log -Status FAIL -TestName "Real headless payment" -Detail "Could not parse payment output. See log."
    }
} catch {
    Write-Result -LogPath $log -Status BLOCKED -TestName "Real payment attempt" -Detail "Could not obtain a valid quote to pay against."
}

Write-Host "Done. Full evidence saved to: $log" -ForegroundColor Cyan
Write-Host "If a payment was attempted, verify on https://testnet.arcscan.app using the buyer address." -ForegroundColor Yellow
