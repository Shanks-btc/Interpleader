# Valiquo

**The first negotiated-price payment layer for AI agents buying live intelligence data, with every settlement independently verifiable on-chain.**

Most AI agents pay a flat rate for every API call, whether the request is worth $0.0001 or $10 to them. Valiquo replaces the fixed price tag with a real, live negotiation, propose a price, get accepted, countered, or rejected, settled instantly in USDC via Circle Gateway and x402 on Arc Testnet. Every settlement is also logged permanently on a dedicated on-chain contract, so anyone can independently verify real usage without trusting our server at all.

**Live app:** [valiquo.xyz](https://valiquo.xyz)
**GitHub:** [github.com/Shanks-btc/Valiquo](https://github.com/Shanks-btc/Valiquo)


---

## What Valiquo Does

Most paid data APIs charge the same price per call regardless of what the request is actually worth to the agent making it. Valiquo fixes this with a real negotiation protocol:

1. **Propose** — an agent (or a person, via the same endpoint) sends a proposed price for a data tool to `POST /quote`.
2. **Negotiate** — the seller accepts outright, counters at its real cost floor with a reason, or rejects — bounded to a handful of rounds per session.
3. **Settle** — once a price is agreed, payment settles on-chain via Circle Gateway and the x402 protocol. No invoices, no manual reconciliation.
4. **Deliver** — the seller calls the live intelligence tool and returns the data.
5. **Log** — the settlement is permanently recorded on a dedicated on-chain contract, independently verifiable by anyone.

The negotiation core is a transparent, deterministic policy engine, every accept/counter/reject decision is fully inspectable and reproducible from source, not a black box. On top of it, a genuine LLM reasoning layer (`POST /ask`) lets an agent ask a natural-language question and get back which tool actually answers it, with real justification,not a fixed lookup table.

---

## Real Traction — All Verifiable On-Chain

Every number below is read directly from Valiquo's settlement-logging smart contract on Arc Testnet, not from our own server, not self-reported. Anyone can independently verify this themselves.

| Metric | Value | Verification |
|---|---|---|
| Real settled negotiations | **29** | Contract event log |
| Distinct payer wallets | **19** | `distinctPayerCount()` |
| Settlement contract | `0xa2d85832cdc83557abfdfc167fcc919b87a99a80` | [View on Arc Explorer ↗](https://testnet.arcscan.app/address/0xa2d85832cdc83557abfdfc167fcc919b87a99a80) |
| Real end-to-end payment (first proof) | $0.008 USDC, balance-verified | Documented below |
| Backend regression tests | 9/9 passing | `scripts/test-valiquo-quotes.ps1` |

### Independent verification — anyone can run this

```bash
# Read the real settlement count directly from Arc Testnet
cast call 0xa2d85832cdc83557abfdfc167fcc919b87a99a80 \
  "settlementCount()(uint256)" \
  --rpc-url https://rpc.testnet.arc.network/

cast call 0xa2d85832cdc83557abfdfc167fcc919b87a99a80 \
  "distinctPayerCount()(uint256)" \
  --rpc-url https://rpc.testnet.arc.network/
```

No Valiquo server is in the trust path for this number. The contract only records a settlement after Circle Gateway has already verified and settled a real USDC payment — it cannot be inflated by fake or self-transferred activity.

### Real settlement history (sample — full history on-chain)

| Timestamp (UTC) | Payer | Tool | Price | Tx |
|---|---|---|---|---|
| 2026-07-08 14:51:12 | `0x852D...D085` | get_btc_cycle_regime | $0.005 | [View ↗](https://testnet.arcscan.app/tx/0x1119f2bf57edb5a7d685358414403a3cc84e860a1d68b14d9388166d8d25a0df) |
| 2026-07-08 23:33:21 | `0x9Fe8...1047` | get_btc_cycle_regime | $0.006 | [View ↗](https://testnet.arcscan.app/tx/0x61a58edf2ed2be2ac945f2eec286afeea125198e433899abef9340b667762e4a) |
| 2026-07-09 12:37:00 | `0xa7a5...E7b69` | get_btc_cycle_regime | $0.006 | [View ↗](https://testnet.arcscan.app/tx/0xcf4287eac74dd9ff0e1ada04804bd21c46d9f7e7bfa42196b1d118b8bbb5c535) |
| 2026-07-10 14:15:55 | `0xeb59...B4237` | get_btc_cycle_regime | $0.006 | [View ↗](https://testnet.arcscan.app/tx/0x7095b80252ce152672d25999ebc0f33aae13dc3001b8394087116c3a2554e582) |
| 2026-07-10 15:25:10 | `0x7780...F2482DF36` | get_btc_cycle_regime | $0.006 | [View ↗](https://testnet.arcscan.app/tx/0x0f0973b76f8fdb4b9e56f4bf7ea3124ea7d60d250bd70ed8b2645afa78543def) |
| ...24 more | | | | [Full history on-chain ↗](https://testnet.arcscan.app/address/0xa2d85832cdc83557abfdfc167fcc919b87a99a80) |

*(19 of 29 settlements are from distinct wallets; one address ran repeated local integration testing during development. All 29 are `get_btc_cycle_regime` — real usage to date has concentrated on this tool.)*

### First Verified Payment — full trace

Before real external users touched the product, we proved the entire negotiate → sign → settle → deliver pipeline end-to-end ourselves, with independent, arithmetic proof:

```
Gateway balance BEFORE: 3.984 USDC
... real negotiated payment of $0.008 via GatewayClient.pay() ...
Gateway balance AFTER:  3.976 USDC
```

`3.984 → 3.976` — exactly $0.008 deducted, matching the negotiated price to the fourth decimal.

### Real bugs found and fixed from live testing

We're documenting these because a product that responds to real user failures is a stronger signal than one that reports none:

| Bug | Root Cause | Fix |
|---|---|---|
| "Quote expired" on real payment attempts | 120-second quote TTL was too short for real MetaMask wallet-signing time | Extended to 10 minutes, unified into one shared constant |
| "Payment settlement failed" with no diagnosable cause | Gateway's soft failures (`{success:false}`) weren't logged, only thrown exceptions were | Added `onAfterSettle` diagnostic logging — revealed the real cause immediately |
| Quotes permanently stuck after a soft settlement failure | Missing state reset in the soft-failure path | Added the missing reset, mirroring the existing exception-path pattern |
| Real users had USDC but payments still failed | Circle Gateway requires funds explicitly **deposited**, not just held in the wallet | Frontend now auto-detects and auto-deposits transparently, as part of the same "click Pay" flow |
| `/activity` and quote state resetting to empty on every server restart | In-memory storage — no persistence | Migrated to Railway-managed Postgres, with atomic conditional updates preserving the same race-safety the in-memory version had |

---

## How It Works

```
Agent/User → propose price → POST /quote
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
                 accept        counter        reject
                    │             │             │
                    └──────┬──────┘             │
                           ▼                    ▼
                    GET /pay/:id            (no deal,
                    (x402-gated,             no charge)
                    Circle Gateway)
                           │
                     signed payment
                           │
                           ▼
                  OPEN → PROCESSING → FULFILLED
                           │
                ┌──────────┴──────────┐
                ▼                     ▼
      seller calls live tool   settlement logged
      → data returned          on-chain (async,
                                non-blocking)
```

### The state machine

Every quote moves through `OPEN → PROCESSING → FULFILLED`, using Circle Gateway's real lifecycle hooks:

- **`onBeforeVerify`** flips `OPEN → PROCESSING` and aborts if the quote isn't payable — correlated to the exact request via Node's `AsyncLocalStorage`, keyed on `req.params.id`. We deliberately avoided correlating via `paymentPayload.resource.url`, since that field isn't covered by the EIP-712 signature and is spoofable — a real security gap we found and fixed before it ever shipped.
- **`onVerifyFailure` / `onSettleFailure`** reset `PROCESSING → OPEN` on a thrown exception.
- **`onAfterSettle`** catches soft failures (e.g. `insufficient_balance`) and also resets state.

### Negotiation logic

```javascript
if (proposedPrice >= askPrice)          → accept at askPrice
if (proposedPrice >= costFloor)         → accept at proposedPrice
if (proposedPrice >= costFloor * 0.5)   → counter at costFloor
else                                     → reject
```

### The reasoning layer (`POST /ask`)

A genuine LLM reasoning step sits in front of the (unchanged) negotiation core. Given a natural-language question, Claude Haiku selects which of the 5 tools actually answers it — with real, inspectable justification — or honestly declines if none fit, rather than forcing a guess.

**Real example:**
```
Q: "is BTC in an accumulation phase right now?"

{
  "answered": true,
  "tool": "get_lth_behavior",
  "reasoning": "The question directly asks about whether Bitcoin is in
   an accumulation phase, which is precisely what get_lth_behavior
   analyzes by examining long-term holder accumulation or distribution
   patterns using MVRV and exchange flow data.",
  "confidence": "high"
}

Q: "what's the weather like?"

{
  "answered": false,
  "reasoning": "The question asks about weather conditions, which is
   completely unrelated to Bitcoin on-chain metrics, market cycles, or
   holder behavior. None of the available tools address weather data.",
  "confidence": "high"
}
```

---

## The Settlement-Logging Contract

Unlike a typical hackathon demo where "traction" means trusting a server's own claims, every real Valiquo settlement is permanently logged on a dedicated Arc Testnet contract — deliberately scoped to do one thing only.

```solidity
function logSettlement(
    string calldata tool,
    uint256 agreedPriceMicroUsdc,
    bytes16 negotiationId,
    address payerAddress
) external onlyLogger returns (uint256 newSettlementCount)
```

**Design principles:**
- **Never holds or moves funds.** All real payment settlement stays entirely on Circle's own audited Gateway/USDC contracts. This contract is purely an append-only proof record — even a worst-case bug in it can't lock or lose a single cent.
- **Fire-and-forget, non-blocking.** Called only *after* a real payment has already succeeded via Postgres. If the on-chain log call ever fails, the real payment and data delivery are completely unaffected — logged server-side, never exposed to the buyer.
- **Anyone can independently derive both total settlements and distinct-user count** directly from the contract, with zero trust required in our server.
- **Access-controlled.** Only a dedicated logger key can write to it, preventing spam or fake entries — verified with a real access-control test (an unauthorized call reverts cleanly).

Deployed and tested with 5 real, isolated test cases before ever touching production: successful log, access-control rejection, distinct-user-count correctness, logger rotation, and real gas measurement (96,570 gas for a first-time payer, 36,857 for a repeat payer — roughly 10x cheaper than a comparable token swap on the same network).

---

## API Reference

Full interactive documentation: [valiquo.xyz/docs](https://valiquo.xyz/docs)

| Endpoint | Method | Purpose |
|---|---|---|
| `/quote` | POST | Negotiate a price. `{tool, proposedPrice, negotiationId?}` |
| `/pay/:id` | GET | x402-gated payment route. Unpaid → `402`; signed → settles and returns data. |
| `/activity` | GET | Real negotiation history metadata — never the paid data itself. |
| `/pricing` | GET | Real per-tool cost floor and asking price for all 5 tools. |
| `/revenue` | GET | Real seller Gateway balance — genuine settled earnings, honestly labeled (a live balance, not a lifetime total). |
| `/ask` | POST | LLM-driven tool selection from a natural-language question. |

### Real request/response example

```bash
curl -X POST https://valiquo-production.up.railway.app/quote \
  -H "Content-Type: application/json" \
  -d '{"tool":"get_btc_cycle_regime","proposedPrice":0.008}'
```
```json
{
  "decision": "accept",
  "quoteId": "c09c5372-fdc7-405c-904e-b6d33bbd3653",
  "agreedPrice": 0.008,
  "reason": "Offer meets or exceeds asking price.",
  "payUrl": "/pay/c09c5372-fdc7-405c-904e-b6d33bbd3653",
  "expiresInSeconds": 600,
  "negotiationId": "50c4cc0c-c5da-41e8-a804-28b9c01cf42f",
  "round": 1
}
```

### Real per-tool pricing

| Tool | Cost Floor | Asking Price | Negotiation Range |
|---|---|---|---|
| `get_btc_cycle_regime` | $0.003 | $0.008 | 63% |
| `get_entry_risk` | $0.0015 | $0.004 | 63% |
| `get_lth_behavior` | $0.0015 | $0.004 | 63% |
| `compare_to_2021_top` | $0.002 | $0.005 | 60% |
| `get_nupl_sentiment` | $0.0015 | $0.004 | 63% |

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│              web/ (Next.js frontend)               │
│   Landing page · Dashboard · Docs                    │
│   Real wallet signing via viem + window.ethereum      │
│   Auto-deposit + payment, signed in-browser            │
└───────────────────────┬────────────────────────────┘
                        │ HTTPS (CORS-enabled)
                        ▼
┌──────────────────────────────────────────────────┐
│         src/server.ts (Express backend)              │
│   /quote /pay/:id /activity /pricing /revenue /ask     │
│   Postgres-backed quote/negotiation state               │
│   (survives restarts — migrated from in-memory)          │
└──────┬─────────────────────────────────┬───────────┘
       │ @circle-fin/x402-batching        │ fire-and-forget
       ▼                                  ▼
┌───────────────────────┐    ┌─────────────────────────┐
│  Circle Gateway         │    │  ValiquoSettlementLog    │
│  (Arc Testnet)           │    │  (Arc Testnet)             │
│  Real USDC + Gateway      │    │  Permanent, trustless        │
│  contracts, x402           │    │  proof-of-payment record       │
└───────────────────────┘    └─────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│    BTC Cycle Intelligence (external MCP server)      │
│    The current, single live data seller                │
└──────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 22, Express, TypeScript (`--experimental-transform-types`, no build step) |
| Database | PostgreSQL (Railway-managed) |
| Frontend | Next.js 14 (App Router), React, TypeScript, Tailwind CSS |
| Payments | `@circle-fin/x402-batching`, `@circle-fin/swap-kit`, viem |
| AI Reasoning | `@anthropic-ai/sdk` (Claude Haiku 4.5) |
| Blockchain | Arc Testnet (`eip155:5042002`), Circle Gateway, x402 protocol, custom Solidity settlement contract |
| Deployment | Railway (backend, frontend, and Postgres as separate services) |
| Testing | Custom PowerShell test harness, Playwright (responsiveness + hydration checks) |

---

## Circle Tools Used

- **Gateway & Nanopayments** — the core settlement layer for every negotiated payment.
- **x402 protocol** — the payment-required gate on `/pay/:id`.
- **App Kit / Swap Kit** — real USDC↔EURC swap integration for optional seller payouts, verified with a live `estimate()` call against Circle's real Stablecoin Service.
- **USDC** — native settlement currency throughout.

---

## Test Scenarios Covered

| Scenario | Result |
|---|---|
| Offer at/above asking price | Accepted at asking price |
| Offer between floor and ask | Accepted at proposed price |
| Offer below floor, within counter range | Countered at floor |
| Offer far below floor | Rejected, no quote created |
| Invalid tool name | Rejected with clear reason |
| Real wallet, sufficient Gateway balance | Payment settles, real data + on-chain log |
| Real wallet, USDC but zero Gateway balance | Auto-deposit triggers, then settles |
| Real wallet, zero USDC | Clear error directing to the faucet |
| Quote expiry (10 minutes) | Enforced |
| Server restart mid-session | Quote state survives (Postgres) — proven with a real production restart test |
| Settlement contract access control | Unauthorized caller reverts cleanly |
| `/ask` — clear question | Correct tool selected, real reasoning returned |
| `/ask` — unrelated question | Honestly declines rather than guessing |

---

## Local Deployment

### Prerequisites
- Node.js 22+
- PostgreSQL (or a Railway-provisioned instance)
- An Arc Testnet wallet with test-USDC ([faucet.circle.com](https://faucet.circle.com))

### Backend
```bash
git clone https://github.com/Shanks-btc/Valiquo.git
cd Valiquo
npm install
cat > .env << EOF
SELLER_ADDRESS=0xYourSellerAddress
DATABASE_URL=postgresql://...
EOF
npm start
# Runs on http://localhost:3000
```

### Frontend
```bash
cd web
npm install
npm run dev
# Runs on http://localhost:3001
```

---

## Known Limitations

Stated plainly — accepted tradeoffs given the build timeline, not oversights we're unaware of:

- **Single live data seller today** (BTC Cycle Intelligence). The architecture is seller-agnostic and designed to support more; we deliberately scoped to one for reliability.
- **Real usage to date is concentrated on one tool** (`get_btc_cycle_regime`) — honest, not hidden.
- **No custom contract for payment itself** — deliberate. Valiquo settles through Circle's own audited Gateway/USDC contracts rather than a bespoke payment contract we could not have properly security-reviewed in the time available. The settlement-*logging* contract, by contrast, was built carefully — isolated test deployment, 5 real test cases, before ever touching production.
- **The reasoning layer (`/ask`) selects a tool; it does not yet reason about price or negotiation strategy** — that logic remains deterministic by design, for reliability.

---

## Team

Solo builder — full-stack Web3 developer.

| Channel | Handle |
|---|---|
| X | [@Shank_btc](https://x.com/Shank_btc) |
| GitHub | [Shanks-btc](https://github.com/Shanks-btc) |
