# Valiquo

**A negotiated-price payment layer for live financial and on-chain intelligence.**

Fixed API pricing doesn't fit how autonomous agents (or people) actually value a request — a decision-critical query and a curious one-off ping pay the same flat rate today, with no way for either side to say what something is actually worth. Valiquo replaces the fixed price tag with a real, live negotiation: propose a price, the seller accepts, counters at its real cost floor, or rejects — resolved in one round trip. Once agreed, payment settles on **Arc Testnet** via **Circle Gateway** and the **x402 protocol**, and the buyer receives the actual intelligence result, returned as machine-readable data ready for downstream agent use.


- **Live:** [valiquo.xyz](https://valiquo.xyz)
- **Backend API:** [valiquo-production.up.railway.app](https://valiquo-production.up.railway.app)
- **Dashboard:** [valiquo.xyz/dashboard](https://valiquo.xyz/dashboard)
- **Docs:** [valiquo.xyz/docs](https://valiquo.xyz/docs)
- **GitHub:** [github.com/Shanks-btc/Valiquo](https://github.com/Shanks-btc/Valiquo)

---

## What Valiquo Does

1. **Propose** — an agent (or a person, via the same endpoint) sends a proposed price for a data tool to `POST /quote`.
2. **Negotiate** — the seller accepts outright, counters at its real cost floor with a reason, or rejects — bounded to a handful of rounds per session.
3. **Settle** — once a price is agreed, payment settles on-chain via Circle Gateway and the x402 protocol. No invoices, no manual reconciliation.
4. **Deliver** — the seller calls the live intelligence tool and returns machine-readable data, ready for downstream agent use.

The negotiation logic is a transparent, deterministic policy engine — not an LLM — so every accept/counter/reject decision is fully inspectable and reproducible from the source, not a black box.

---

## Real Traction — Verifiable On-Chain

As of **July 5, 2026**, Valiquo has processed real, distinct payments from real testers — not simulated, not self-transfers. Every number below is pulled live from Valiquo's own `GET /activity` endpoint; regenerate this table yourself anytime with `scripts/generate-traction-table.mjs`, or check the raw endpoint directly: [valiquo-production.up.railway.app/activity](https://valiquo-production.up.railway.app/activity)

| Metric | Value | Verification |
|---|---|---|
| Distinct payer wallets | 6 (5 external testers + 1 project-owner test wallet, labeled below) | [`/activity`](https://valiquo-production.up.railway.app/activity) |
| Real settled negotiations | 9 | `/activity` |
| Backend regression tests | 9/9 passing | `scripts/test-valiquo-quotes.ps1` |
| Real on-chain payment (first end-to-end proof) | $0.008 USDC, balance-verified | See "First Verified Payment" below |

**Distinct payer wallets, individually verifiable on the Arc Testnet explorer:**

| Wallet | Explorer Link | Note |
|---|---|---|
| `0xf6e345d3c7b44c4d7cd27f34d8e9e1d55a112142` | [View](https://testnet.arcscan.app/address/0xf6e345d3c7b44c4d7cd27f34d8e9e1d55a112142) | External tester |
| `0x1d9198499030b115899bd718b8874dd671691f5e` | [View](https://testnet.arcscan.app/address/0x1d9198499030b115899bd718b8874dd671691f5e) | External tester |
| `0xefb9014198317f703408069cda811e1253601a92` | [View](https://testnet.arcscan.app/address/0xefb9014198317f703408069cda811e1253601a92) | External tester |
| `0xeb59f6bc98c655f9ef3b81981f5ad53e8cdb4237` | [View](https://testnet.arcscan.app/address/0xeb59f6bc98c655f9ef3b81981f5ad53e8cdb4237) | External tester |
| `0x9fe8f5497180976fcefee773dd5778db73e01047` | [View](https://testnet.arcscan.app/address/0x9fe8f5497180976fcefee773dd5778db73e01047) | External tester |
| `0x8cfE33b6A26A0797e4C7E7FEB39290e08258c262` | [View](https://testnet.arcscan.app/address/0x8cfE33b6A26A0797e4C7E7FEB39290e08258c262) | Project owner's own test wallet — labeled honestly, not counted as an external user |

More testers are actively onboarding as of this writing — this table will grow. We publish the exact method for generating it so anyone can regenerate and verify it independently, not just take our word for it:

```bash
BACKEND_URL=https://valiquo-production.up.railway.app node scripts/generate-traction-table.mjs
```

### First Verified Payment — Full Trace

Before real users touched the product, we proved the entire negotiate → sign → settle → deliver pipeline end-to-end ourselves:

```
$ curl -X POST https://valiquo-production.up.railway.app/quote \
  -H "Content-Type: application/json" \
  -d '{"tool":"get_btc_cycle_regime","proposedPrice":0.008}'

{"decision":"accept","quoteId":"...","agreedPrice":0.008,
 "reason":"Offer meets or exceeds asking price.", ...}

$ node scripts/check-balance.mjs   # BEFORE
{"gatewayAvailable":"3.984"}

# ... signed payment via GatewayClient.pay() ...

$ node scripts/check-balance.mjs   # AFTER
{"gatewayAvailable":"3.976"}
```

`3.984 → 3.976` — exactly `$0.008` deducted, matching the negotiated price to the fourth decimal. This is independent, arithmetic proof the payment genuinely settled at Circle's Gateway layer, confirmed before any real external user ever touched the product.

### Real Bugs Found and Fixed From Live Testing

We're documenting these because we think a product that responds to real user failures, transparently, is a stronger signal than a product that never reports any:

| Bug | Root Cause | Fix | Evidence |
|---|---|---|---|
| "Quote expired" on real payment attempts | 120-second quote TTL was too short for real MetaMask wallet-signing time | Extended to 10 minutes (`QUOTE_TTL_MS`), unified into one constant so the response field and the enforcement check can no longer drift apart | Real user report, fixed and redeployed same day |
| "Payment settlement failed" with no diagnosable cause | `onSettleFailure` only fires on a thrown exception; Circle's Gateway can also return a soft `{success: false, errorReason: ...}` without throwing, which our hooks never logged | Added `onAfterSettle` diagnostic logging, which fired immediately and revealed the real cause: `insufficient_balance` | Real user report → real Railway log capture → root cause found same day |
| Quotes permanently stuck at `PROCESSING` after a soft settlement failure | `onAfterSettle`'s failure branch never reset quote state back to `OPEN`, unlike the two exception-based hooks | Added the missing state reset, mirroring the existing pattern | Found while investigating the bug above |
| Real users had USDC in their wallet but payments still failed | Circle Gateway requires funds explicitly **deposited** into the Gateway contract — plain wallet USDC balance is a separate pool | Frontend now auto-detects insufficient Gateway balance and auto-deposits before payment, transparently, as part of the same "click Pay" flow | Root cause traced via the `onAfterSettle` logging above; fix verified by 3 real friends completing payments immediately after deploy |

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
                           ▼
              seller calls live intelligence tool
                           │
                           ▼
              machine-readable data returned to buyer
```

### The state machine

Every quote moves through `OPEN → PROCESSING → FULFILLED`, using Circle Gateway's real lifecycle hooks:

- **`onBeforeVerify`** flips `OPEN → PROCESSING` and aborts if the quote isn't in a payable state — correlated to the specific request via Node's `AsyncLocalStorage`, keyed on `req.params.id`. We deliberately avoided correlating via `paymentPayload.resource.url`, since that field isn't covered by the EIP-712 signature and is spoofable — a real security gap we found and fixed during development, before it ever shipped.
- **`onVerifyFailure` / `onSettleFailure`** reset `PROCESSING → OPEN` on a thrown exception, so a failed attempt doesn't permanently lock the quote.
- **`onAfterSettle`** catches *soft* failures (Gateway returning `{success: false}` without throwing) and also resets state — the fix for the second bug in the table above.

### Negotiation logic

```javascript
if (proposedPrice >= askPrice)          → accept at askPrice
if (proposedPrice >= costFloor)         → accept at proposedPrice
if (proposedPrice >= costFloor * 0.5)   → counter at costFloor
else                                     → reject
```

Real example (`get_entry_risk`, floor `$0.0015`, ask `$0.004`): a proposal of `$0.001` (66% of floor) gets countered at `$0.0015`; re-proposing at `$0.0015` gets accepted.

---

## API Reference — Real Endpoints, Real Examples

Full interactive documentation: [valiquo.xyz/docs](https://valiquo.xyz/docs)

### `POST /quote`

Negotiate a price for a data tool.

**Request:**
```json
{
  "tool": "get_btc_cycle_regime",
  "proposedPrice": 0.006,
  "negotiationId": null
}
```

**Response — accept:**
```json
{
  "decision": "accept",
  "quoteId": "c09c5372-fdc7-405c-904e-b6d33bbd3653",
  "agreedPrice": 0.006,
  "reason": "Offer clears cost floor; accepted at proposed price.",
  "payUrl": "/pay/c09c5372-fdc7-405c-904e-b6d33bbd3653",
  "expiresInSeconds": 600,
  "negotiationId": "50c4cc0c-c5da-41e8-a804-28b9c01cf42f",
  "round": 1
}
```

**Response — counter:**
```json
{
  "decision": "counter",
  "quoteId": "23934c4d-f860-40a7-9f72-63b709e65a9d",
  "agreedPrice": 0.003,
  "reason": "Offer below cost floor; countering at floor price.",
  "payUrl": "/pay/23934c4d-f860-40a7-9f72-63b709e65a9d",
  "expiresInSeconds": 600,
  "negotiationId": "43941a0a-78a2-4782-9933-e4bb38426d87",
  "round": 1
}
```

**Response — reject:**
```json
{
  "decision": "reject",
  "reason": "Offer too far below cost floor to be worth countering."
}
```

### `GET /pay/:id`

x402-gated payment route. Unpaid request returns `402` with payment requirements; a correctly signed Circle Gateway payment completes the purchase and returns the real data.

**Unpaid (`402`):**
```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64-encoded payment requirements>
```

**Paid (`200`):**
```json
{
  "message": "Payment accepted — here is your data.",
  "tool": "get_btc_cycle_regime",
  "negotiationId": "...",
  "round": 1,
  "agreedPrice": 0.006,
  "payerAddress": "0x...",
  "data": { "rawText": "BTC Cycle Regime: Mid Bull (Score: 57/100)..." }
}
```

### `GET /activity`

Real negotiation history metadata. **Never exposes the actual paid intelligence data or rejected-offer pricing details** — this is a deliberate design constraint, since the whole product depends on not giving away for free what people pay for.

```json
[
  {
    "quoteId": "b1bc0d90-186b-4b0a-af12-17b19aee9632",
    "negotiationId": "35364571-c2ac-4ff2-89db-9550dbac5cb1",
    "round": 1,
    "tool": "get_btc_cycle_regime",
    "decision": "accepted",
    "agreedPrice": 0.008,
    "createdAt": "2026-07-06T09:00:23.727Z",
    "state": "FULFILLED",
    "payerAddress": "0x..."
  }
]
```

### `GET /pricing`

Real per-tool cost floor and asking price, read directly from source — not duplicated or guessed.

| Tool | Cost Floor | Asking Price | Negotiation Range |
|---|---|---|---|
| `get_btc_cycle_regime` | $0.003 | $0.008 | 63% |
| `get_entry_risk` | $0.0015 | $0.004 | 63% |
| `get_lth_behavior` | $0.0015 | $0.004 | 63% |
| `compare_to_2021_top` | $0.002 | $0.005 | 60% |
| `get_nupl_sentiment` | $0.0015 | $0.004 | 63% |

---

## Tutorial — How the Negotiation-to-Settlement Flow Works

### Step 1 — Propose a price
```bash
curl -X POST https://valiquo-production.up.railway.app/quote \
  -H "Content-Type: application/json" \
  -d '{"tool":"get_entry_risk","proposedPrice":0.001}'
```
Returns a `counter` at the real cost floor (`$0.0015`), with a `payUrl` and a 10-minute expiry window.

### Step 2 — Re-propose at the countered price
```bash
curl -X POST https://valiquo-production.up.railway.app/quote \
  -H "Content-Type: application/json" \
  -d '{"tool":"get_entry_risk","proposedPrice":0.0015,"negotiationId":"<from step 1>"}'
```
Returns `accept` — same `negotiationId`, `round` incremented to `2`.

### Step 3 — Pay via a real wallet (browser)
The frontend's negotiation widget:
1. Detects `window.ethereum`, requests account access.
2. Checks the connected wallet's Circle Gateway available balance. If it's short but the wallet's plain USDC balance covers it, **auto-deposits** into Gateway first (a real, separate signature) — this is the fix for the fourth bug in the table above.
3. Builds the real EIP-712 `TransferWithAuthorization` payload matching the quote's exact `agreedPrice` and the real seller address.
4. Requests the signature via `window.ethereum.request(...)`.
5. Submits the signed payload to the real `payUrl`.

### Step 4 — Receive the result
On success, the response includes the real `payerAddress` and the actual intelligence data. The frontend shows a **"View on Arc Explorer"** link to `testnet.arcscan.app/address/{payerAddress}` so the payer can independently verify their own transaction history.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│              web/ (Next.js frontend)               │
│   Landing page · Dashboard · Docs                   │
│   Real wallet signing via viem + window.ethereum    │
│   Auto-deposit + payment, both signed in-browser     │
└───────────────────────┬────────────────────────────┘
                        │ HTTPS (CORS-enabled)
                        ▼
┌──────────────────────────────────────────────────┐
│         src/server.ts (Express backend)             │
│   /quote · /pay/:id · /activity · /pricing           │
│   In-memory quote/negotiation state                  │
│   (does not survive a restart — known limitation)    │
└───────────────────────┬────────────────────────────┘
                        │ @circle-fin/x402-batching
                        ▼
┌──────────────────────────────────────────────────┐
│         Circle Gateway (Arc Testnet)                 │
│   Real USDC contract, real GatewayWallet contract     │
│   chain id eip155:5042002                             │
└───────────────────────┬────────────────────────────┘
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
| Backend | Node.js 22, Express, TypeScript (run directly via `--experimental-transform-types`, no build step) |
| Frontend | Next.js 14 (App Router), React, TypeScript, Tailwind CSS |
| Payments | `@circle-fin/x402-batching`, `viem` |
| Blockchain | Arc Testnet (`eip155:5042002`), Circle Gateway, x402 protocol |
| Wallet signing | Real EIP-712 `TransferWithAuthorization`, `window.ethereum` |
| Deployment | Railway (two separate services — backend and frontend) |
| Testing | Custom PowerShell test harness (`scripts/`), Playwright (responsiveness + hydration checks) |

---

## Test Scenarios Covered

Valiquo was tested by real users during the hackathon period, in addition to the automated regression suite.

| Scenario | Result |
|---|---|
| Offer at or above asking price | Accepted at asking price |
| Offer between floor and ask | Accepted at proposed price |
| Offer below floor, within counter range | Countered at floor |
| Offer far below floor | Rejected, no quote created |
| Invalid tool name | Rejected with clear reason |
| Missing/malformed `proposedPrice` | `400` with clear error |
| Unpaid `GET /pay/:id` | `402` with real payment requirements |
| Duplicate unpaid request | Safe, no crash, no false-consume |
| Real wallet with sufficient Gateway balance | Payment settles, real data returned |
| Real wallet with USDC but zero Gateway balance | Auto-deposit triggers, then payment settles |
| Real wallet with zero USDC | Clear error directing to the faucet |
| Quote expiry (10 minutes) | Enforced; expired quotes rejected with a clear message |
| Max negotiation rounds (5) | Enforced server-side |
| Mobile browser (375px–1440px) | Responsive UI confirmed across all breakpoints |

---

## Local Deployment

### Prerequisites
- Node.js 22+
- An Arc Testnet wallet with test-USDC ([faucet.circle.com](https://faucet.circle.com))

### Backend
```bash
git clone https://github.com/Shanks-btc/Valiquo.git
cd Valiquo
npm install
echo "SELLER_ADDRESS=0xYourSellerAddress" > .env
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

Set `NEXT_PUBLIC_QUOTE_API_URL` and `QUOTE_API_URL` to point the frontend at your backend if not running both on default ports.

### Test harness
```powershell
.\scripts\test-valiquo-quotes.ps1        # negotiation + payment-route checks, read-only
.\scripts\test-btc-mcp.ps1               # verify the live data seller
.\scripts\test-payment-readiness.ps1     # env/config/balance checks (add -ExecutePayment to spend real test-USDC)
node scripts\generate-traction-table.mjs # regenerate the real traction table above
```

---

## Known Limitations

Stated plainly — these are accepted tradeoffs given the build timeline, not oversights we're unaware of:

- **In-memory state does not survive a server restart.** Negotiation/quote/activity history resets to empty on every redeploy. A durable store (Redis or Postgres, both natively available on Railway) is the planned next step before any production-scale deployment.
- **Single live data seller today** (BTC Cycle Intelligence). The architecture — the negotiation layer, the payment gate, the `/activity`/`/pricing` pattern — is seller-agnostic and designed to support more sellers; we deliberately scoped to one for reliability under deadline pressure.
- **No custom smart contract.** Valiquo settles through Circle's own audited Gateway/USDC contracts on Arc rather than a bespoke contract we could not have properly security-reviewed in the time available. We consider this the right call given the timeline, not a shortcut.
- **Requires a Circle Gateway deposit, not just wallet USDC** — a real Gateway-level requirement, now handled transparently by the frontend's auto-deposit flow (see Real Bugs Found table above).

---

## Team

Solo builder — full-stack Web3 developer.

| Channel | Handle |
|---|---|
| X | [@Shank_btc](https://x.com/Shank_btc) |
| GitHub | [Shanks-btc](https://github.com/Shanks-btc) |
