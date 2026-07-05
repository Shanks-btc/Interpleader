# Valiquo - Architecture

## What this is
Valiquo is a negotiated-price payment layer for live financial/on-chain intelligence data. Instead of a fixed x402 price, a buyer proposes a price; Valiquo's own policy logic decides accept / reject / counter; only on agreement does a real Circle Gateway/x402 payment fire, at the negotiated price. Built for the Lepton Agents Hackathon (Circle + Arc + Canteen).

Current scope: single seller - BTC Cycle Intelligence (5 tools). Short Squeeze Intelligence exists, is auth-fixed and reachable, but is deliberately out of scope for now (see plan.md).

## Why this is not a trivial x402 wrapper
Verified directly from @circle-fin/x402-batching@3.2.0's own TypeScript type definitions: there is NO negotiation/quote/counter-offer API anywhere in Circle's SDK. gateway.require(price) takes one static price string. Circle's own CLI (circle services pay --max-amount) only supports a hard refuse-to-overpay ceiling, not real negotiation. The negotiation logic in this repo is 100% custom, sitting in front of Circle's payment gate - this is the actual differentiator, not a marketing claim.

## Request flow
Buyer -> POST /quote {tool, args, proposedPrice} -> Valiquo runs decide(): accept/reject/counter -> returns {decision, quoteId, agreedPrice, payUrl}
Buyer -> GET /pay/:id (unpaid) -> 402 (Circle Gateway middleware intercepts here)
Buyer -> GET /pay/:id (signed payment) -> Gateway verifies + settles -> callMcpTool(tool, args) -> tools/call (SSE response) -> real data returned
Buyer <- {message, tool, agreedPrice, data}

## Verified technical facts (each confirmed live or from source, not assumptions)
- Arc Testnet chain id (CAIP-2): eip155:5042002 - confirmed 3 independent ways (SDK source, RPC eth_chainId call via both public and Canteen-hosted RPC).
- Gateway facilitator (testnet): https://gateway-api-testnet.circle.com
- USDC contract (Arc Testnet): 0x3600000000000000000000000000000000000000
- GatewayWallet contract: 0x0077777d7EBA4688BDeF3E311b846F25870A19B9
- Public RPC: https://rpc.testnet.arc.network. Canteen-hosted authenticated RPC also available via arc-canteen rpc-url (see .env RPC value).
- Gateway minimum deposit: 0.5 USDC (confirmed from circle gateway deposit docs).
- On-chain batch settlement lag on testnet: reference docs (circle-agent README) state ~10 minutes under light load; the off-chain debit itself is fast (confirmed: a real test payment completed end-to-end, including MCP fulfillment, in 4660ms). Treat the 10-minute figure as for on-chain batch flush specifically, not end-to-end buyer experience.
- BTC Cycle Intelligence responds to tools/call as SSE (event: message / data: {...}), not bare JSON - confirmed live, handled in callMcpTool().
- BTC Cycle Intelligence's tool results are human-readable prose text, not structured JSON, despite the README showing a JSON example - confirmed live. callMcpTool() tries JSON.parse first, falls back to raw text.
- BTC Cycle Intelligence originally required CTX Protocol JWT auth (createContextMiddleware()) on tools/call (but not tools/list) - this was DISABLED in our fork since it is unrelated to the Arc/Circle payment flow being built. Confirmed fix via live re-test.
- @circle-fin/cli (the documented rich CLI) is versioned 0.0.6 on npm as of this build - far behind its own documentation. Do not rely on CLI commands beyond what has been individually verified; the SDK (@circle-fin/x402-batching) is the reliable path.
- Circle Agent Wallet spending-policy limits are mainnet-only - confirmed from official CLI docs (circle wallet limit: "Testnet chains not supported"). Valiquo's own decide() function and the onBeforeVerify hook are the actual budget/policy enforcement, not a Circle-managed feature.

## Core logic - decide(tool, proposedPrice) in src/server.ts
Each tool has a floor (minimum acceptable) and an ask (list price):
- proposedPrice >= ask -> accept at ask (no discount given away for free).
- floor <= proposedPrice < ask -> accept at proposedPrice (the real negotiated discount).
- floor*0.5 <= proposedPrice < floor -> counter at floor.
- proposedPrice < floor*0.5 -> reject outright, no counter.

This is a deterministic, transparent policy engine - not an LLM. Deliberate choice: fully inspectable, reproducible for a live demo, no risk of unpredictable model behavior during judging.

## File map
- src/server.ts - Express API: /quote, /pay/:id, MCP adapter, Gateway wiring
- buyer-agent/index.ts - Autonomous buyer: negotiates + pays with no human interaction
- scripts/ - PowerShell test harness (all read-only except -ExecutePayment)
- web/ - NOT YET BUILT - human-facing UI (see plan.md)
- docs/ - This folder

## What is proven vs not yet built
Proven live, with real test-USDC (see handoff.md for exact evidence):
- Full negotiation logic (all 4 branches) against the real running server.
- x402 402-gate behavior, duplicate-request safety.
- One real end-to-end payment: quote -> Gateway payment -> real BTC Cycle Intelligence data returned, HTTP 200, 4660ms.

Not yet built:
- OPEN -> PROCESSING -> FULFILLED state machine (approved design exists, not implemented; current code uses a simpler used boolean flag with a known race-condition caveat).
- negotiationId / round tracking for multi-round negotiation sessions.
- Buyer-agent wiring against the now-working server (script drafted, untested against live server).
- Web UI (web/ - entirely unbuilt).
- Durable quote storage (currently in-memory Map, acceptable for local testing only).
