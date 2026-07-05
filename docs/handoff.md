# Valiquo - Handoff

Read this first if you are an AI coding agent or developer picking up this project without prior context. It tells you exactly what is real, what is proven, and what to trust versus verify yourself.

## What is genuinely proven right now (not claims - evidence)
1. A real end-to-end payment succeeded. Log: logs/tests/payment-readiness-20260704-161149.log. Evidence: a /quote call negotiated $0.008 for get_btc_cycle_regime, a real Circle Gateway payment was made from a funded Arc Testnet wallet, and Valiquo returned real live on-chain intelligence data (MVRV 1.18, Bear regime, score 19/100, real price $62565) with HTTP 200 in 4660ms. This is the single most important proof point in the repo - it means the core mechanism (negotiate -> pay -> deliver) genuinely works, not just in theory.
2. All 4 negotiation branches (accept-at-ask, accept-at-offer, counter, reject) verified against the live running server - see logs/tests/valiquo-quotes-*.log.
3. x402's 402-gate and duplicate-request safety verified - an unpaid request correctly returns 402 with payment requirements; hitting it twice unpaid does not crash or falsely consume the quote.
4. On-chain intelligence provider (BTC Cycle Intelligence) auth was fixed and re-verified live - see logs/tests/btc-mcp-20260703-160833.log onward (all 5 tools pass after the createContextMiddleware() fix).
5. State machine hardening (OPEN -> PROCESSING -> FULFILLED) and negotiationId/round tracking have been implemented in src/server.ts. Verified: all decide() branches with negotiationId/round attached, round increment and max-round enforcement, 402 gating unaffected. NOT yet verified: the PROCESSING state transition and onVerifyFailure/onSettleFailure recovery paths, since these only trigger on a real signed payment. A real -ExecutePayment run is needed to confirm this fully.

## What is NOT yet proven - do not assume these work
- The buyer-agent script (buyer-agent/index.ts) has never been run against the fixed server. It is drafted and reasoned through carefully, but untested. Test it before claiming it works.
- The PROCESSING state and failure-recovery hooks in the new state machine have not been exercised by a real payment yet (see point 5 above).
- negotiationId / round tracking exists in the code now but has only been tested via the negotiation-only path, not through a real payment end to end.
- Short Squeeze Intelligence's auth was fixed in its own repo but the fix was never pushed to GitHub / redeployed as of this handoff. Confirm its live status before using it for anything. It remains out of current scope regardless.
- The web UI does not exist. Zero files in web/ because the folder itself has not been created.

## Things that look like bugs but are intentional - do not "fix" without reading why
- createContextMiddleware() is commented out (not deleted) in both forked MCP tool repos (BTC-Cycle-Intelligence, short-squeeze-intelligence). This is deliberate - it is a CTX Protocol JWT auth layer irrelevant to the Arc/Circle payment flow this product is built on. Re-enabling it will reintroduce 401 errors on tools/call.
- callMcpTool() in src/server.ts tries JSON.parse(text) and falls back to raw text on failure. This is correct, not a leftover bug - the on-chain intelligence provider genuinely returns human-readable prose, not JSON, despite its README showing a JSON example.
- The negotiation logic (decide()) is a plain deterministic policy engine, not an LLM. This was a deliberate architecture decision made specifically to avoid non-deterministic behavior during a live demo - do not "upgrade" to an LLM without understanding this tradeoff was already litigated.

## A real bug found and fixed during state-machine work (2026-07-04)
The onBeforeVerify floor-safety-net hook was reading ctx.paymentRequirements.amount, but the SDK's actual hook context field is named requirements, not paymentRequirements.amount - meaning this safety check was silently dead code (always read undefined) since it was first written. Fixed as part of the state-machine rewrite. Lesson: verify SDK field names against actual compiled source (node_modules) rather than assumption, even for code that was "working" - a check can silently do nothing and still look fine because nothing ever failed loudly.

## Known environment quirks (Windows/PowerShell-specific, may not apply elsewhere)
- curl.exe from PowerShell mangles embedded double-quotes in JSON bodies (PowerShell's argv-flattening for native .exe calls does not reliably re-escape them) - this caused several confusing "Bad Request" HTML error pages during development. All test scripts now use Invoke-WebRequest instead, which avoids this entirely. If you add new PowerShell scripts, do not use curl.exe with inline JSON strings - use Invoke-WebRequest -Body.
- A PowerShell parameter named $Args silently collides with PowerShell's automatic $args variable and causes a confusing type-cast error. Renamed to $ToolArgs in the fixed scripts. Avoid $Args/$args as a custom parameter name in any new PowerShell code here.
- Backtick line-continuation in PowerShell here-strings is fragile - a trailing space after the backtick silently breaks the statement with no clear error. Prefer single-line statements over backtick continuation in this codebase's PowerShell scripts.
- When testing changes to src/server.ts locally, port 3000 may already be occupied by the project owner's own manually-run server. Use a different port (e.g. 3001) for your own self-verification runs rather than assuming the port is free or stopping the owner's process.

## External services this project depends on
- On-chain intelligence provider (fork: github.com/Shanks-btc/BTC-Cycle-Intelligence, deployed on Railway at the URL in src/server.ts's BTC_CYCLE_MCP_URL). Original author: Phickayor. CoinMetrics Community API as the underlying free data source, 4-hour cache TTL.
- Circle Gateway/x402 (@circle-fin/x402-batching@3.2.0) - facilitator https://gateway-api-testnet.circle.com, Arc Testnet only.
- Canteen-hosted Arc RPC (optional, via arc-canteen CLI, stored in .env as RPC) - alternative to the public rpc.testnet.arc.network.

## If you are an AI agent continuing this build
Read architecture.md for the technical design and verified facts, plan.md for what is left and in what order, demo-script.md for what the final output needs to demonstrate, deploy.md for how to actually ship it. Do not re-verify things already confirmed in this document without reason - but do verify anything you are about to build on top of that is not explicitly listed as "proven" above. This is a real, ongoing product being built for continued use and expansion - not a one-off event submission.
