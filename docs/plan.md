# Valiquo - Build Plan

## Decision history (why things are the way they are)
- Single-seller scope (BTC Cycle Intelligence only). Short Squeeze Intelligence is real, live, and auth-fixed, but was deliberately deferred to keep the first fully-working loop small. Add back only after everything below is solid.
- Deterministic policy engine, not an LLM negotiator. Chosen for reliability and inspectability in a live demo - approved architecture decision, not a shortcut. Do not silently swap in an LLM without re-approving the tradeoff (cost, latency, non-determinism risk right before judging).
- callMcpTool() bug (fixed): an earlier multi-seller draft referenced an undefined BTC_CYCLE_MCP_URL variable. Fixed by reverting to single-seller scope with the variable properly defined. Verified fixed via a real payment completing end-to-end (see handoff.md).
- CTX Protocol auth middleware disabled on the forked BTC Cycle Intelligence (and Short Squeeze Intelligence, though currently unused) - createContextMiddleware() from @ctxprotocol/sdk was gating tools/call with a JWT check unrelated to this hackathon's Arc/Circle payment flow. Commented out, not deleted, so it is reversible if these tools are ever resubmitted to CTX.

## Remaining work, in priority order

### 1. State machine hardening (approved design, not yet implemented)
Replace the current used:boolean flag with OPEN -> PROCESSING -> FULFILLED:
- OPEN -> PROCESSING: inside gateway.onBeforeVerify hook - fires only when a real signed payment payload arrives (unpaid discovery requests never reach this hook, so it cannot wrongly flip state on a plain 402 probe). Atomically check-and-set; if already PROCESSING/FULFILLED, abort with {abort:true, reason}.
- PROCESSING -> OPEN (recovery): on onVerifyFailure / onSettleFailure hooks, so a transient failure does not permanently lock a quote.
- PROCESSING -> FULFILLED: set immediately after next() fires (verify+settle succeeded), before calling callMcpTool().
- Edge case to handle: if callMcpTool() fails after FULFILLED (payment succeeded, data delivery did not), do not roll back state - retry fulfillment using the stored tool/args (no repayment needed), and if it keeps failing, surface as a distinct "paid, undelivered" record rather than hiding it.

### 2. negotiationId / round tracking
/quote should accept an optional negotiationId in the request body. If absent, generate one and return round:1. If present, increment round for that session server-side, and enforce a max-round limit per negotiationId (not just client-side, as it is today). Every quote record and buyer-agent log line should carry both fields so a full negotiation session is traceable end to end.

### 3. Buyer-agent wiring + real test
buyer-agent/index.ts is drafted (opens at a reference-price-based offer, reacts to accept/reject/counter, respects maxBudget, pays via headless GatewayClient). It has NOT yet been run against the fixed, single-seller server. Next action: run it for real, once with a generous --max-budget (expect accept), once with a stingy one (expect walk-away, no payment). Both outcomes should be provable via presence/absence of a real Gateway transaction.

### 4. Web UI (web/ - entirely unbuilt)
Single page, no multi-view dashboard (that is a stretch goal only). Next.js (App Router) + React + TypeScript + viem's wallet client for MetaMask signing (no heavier wallet library needed). Four steps on one screen:
1. Ask - pick a BTC Cycle tool/question, optionally propose a price.
2. Negotiate - call /quote, show the live decision + reasoning.
3. Pay - if accepted, "Pay $X via MetaMask" triggers EIP-712 signing (pattern from circle-agent/public/buyer.html, ported to React).
4. Result - show the real returned data + a receipt (what was asked, what was paid, why).

Explicitly deferred: multi-page dashboard, ledger/history view, author/earnings pages.

### 5. Durable quote storage
Current in-memory Map is fine for local testing only - dies on restart, unusable once deployed publicly. Before public Railway deployment, move to a Railway-managed Redis addon (recommended over Postgres - quote records are small, short-lived, simple get/set/expire access pattern; Redis fits better than relational storage here).

### 6. README + demo
- README should make the negotiation logic and the "no negotiation exists in Circle's own SDK" differentiation obvious to a judge reading the repo cold.
- Demo script: see demo-script.md.

## What NOT to do (guardrails for any agent picking this up)
- Do not swap the deterministic policy engine for an LLM negotiator without explicit re-approval - this was a deliberate, reasoned choice, not a placeholder.
- Do not claim pre-payment freshness negotiation (e.g. "buyer requests data under 2 minutes old") - out of scope until there is a real seller-side freshness tier. Post-payment validation of asOf/confidence/sourceRefs is fine; pre-payment freshness guarantees are not.
- Do not re-enable createContextMiddleware() without understanding it will break tools/call for this hackathon's flow (it requires a CTX JWT unrelated to Arc/Circle).
- Do not add Short Squeeze Intelligence back into scope without re-testing it fresh (auth fix is pushed but response-format assumptions were never fully verified with real ticker arguments through Valiquo's own adapter, only through the raw test scripts).
- Do not claim this is a "multi-party marketplace" - it currently has one seller, built by the same person building Valiquo. Reusability (same negotiation code, different tool) is demonstrated; independent third-party adoption is not, and should not be implied.

## Known limitation - buyer-agent walk-away path (documented, not a bug)
The buyer-agent's current strategy (open at half of --max-budget) means a "counter that exceeds budget" scenario is mathematically unreachable against the current BTC Cycle Intelligence pricing table: reaching the counter zone at all requires a budget already >= the tool's floor, which guarantees the countered price is affordable. Discovered and confirmed via real multi-round testing in Phase 2 (buyer-agent negotiationId/round wiring).

Decision: left as-is. The proven, demonstrated walk-away path is the outright-reject case (offer far below floor -> flat reject, no counter, no payment attempted) - this is a cleaner, more legible demo moment than a near-miss counter scenario would be, and changing the buyer strategy to force a reachable counter-exceeds-budget case risks destabilizing logic that is already tested and working, for no real gain in demo clarity or honesty.

Both required demo outcomes are proven and real: (1) real accept -> real payment -> real data returned, (2) real outright-reject -> no payment ever attempted, verified structurally unreachable in code, not just skipped by a flag.
