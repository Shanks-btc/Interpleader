// Real, small-amount end-to-end payment test against the DEPLOYED A2MCP
// endpoint (POST /a2mcp) - signs a real EIP-3009 authorization with
// OKX_TEST_BUYER_PRIVATE_KEY and replays it to the real production server,
// so verify+settle run through the actual deployed src/okxA2mcp.ts code and
// OKX's real facilitator - not a bypass, not a mock, not a local harness.
//
// SAFETY: real money moves on whatever network the deployed server's
// OKX_NETWORK is set to (mainnet = eip155:196 = real funds). Defaults to a
// dry run - fetches the real 402, decodes and prints exactly what WOULD be
// charged (amount, network, payTo), signs and sends NOTHING. Only --execute
// signs and submits a real payment. Same gating pattern as
// scripts/swap-seller-usdc-to-eurc.mjs (estimate first, --execute to act).
//
// Run with:
//   node --experimental-transform-types --no-warnings scripts/test-okx-mainnet-payment.mjs             # dry run - no wallet needed
//   node --experimental-transform-types --no-warnings scripts/test-okx-mainnet-payment.mjs --execute     # real payment - needs OKX_TEST_BUYER_PRIVATE_KEY
//
// Env:
//   A2MCP_BASE_URL          - the deployed server to test against. Defaults to
//                              this repo's known production host; override if
//                              that's wrong or you want to target a different
//                              deployment (e.g. a staging Railway service).
//   OKX_MAINNET_TOOL         - which TOOLS entry to pay for. Defaults to
//                              get_btc_cycle_regime (real askPrice $0.008,
//                              no required arguments).
//   OKX_TEST_BUYER_PRIVATE_KEY - required only for --execute. Never read or
//                              needed for the dry run.

import { x402Client } from "@okxweb3/x402-core/client";
import { x402HTTPClient } from "@okxweb3/x402-core/http";
import { ExactEvmScheme, toClientEvmSigner } from "@okxweb3/x402-evm";
import { privateKeyToAccount } from "viem/accounts";
import { TOOLS } from "../src/tools.ts";

const A2MCP_BASE_URL = process.env.A2MCP_BASE_URL || "https://valiquo-production.up.railway.app";
const TOOL_NAME = process.env.OKX_MAINNET_TOOL || "get_btc_cycle_regime";
const execute = process.argv.slice(2).includes("--execute");

function log(step, detail) {
  console.log(JSON.stringify({ step, ...detail }));
}

const config = TOOLS[TOOL_NAME];
if (!config) {
  log("error", { ok: false, error: `Tool "${TOOL_NAME}" not found in TOOLS catalog (src/tools.ts).` });
  process.exit(1);
}
if (config.requiredArgs && config.requiredArgs.length > 0) {
  log("error", {
    ok: false,
    error: `"${TOOL_NAME}" requires arguments (${config.requiredArgs.join(", ")}). Pick a no-argument tool via OKX_MAINNET_TOOL, e.g. get_btc_cycle_regime.`,
  });
  process.exit(1);
}

const url = `${A2MCP_BASE_URL}/a2mcp`;
const callBody = { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: TOOL_NAME, arguments: {} } };

log("start", { endpoint: url, tool: TOOL_NAME, realAskPriceUsd: config.askPrice, mode: execute ? "EXECUTE (real payment)" : "dry run" });

// --- Step 1: unpaid request against the real deployed server -> real 402 ---
let unpaidRes;
try {
  unpaidRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(callBody),
  });
} catch (err) {
  log("unpaid_request_failed", { ok: false, error: String(err?.message ?? err) });
  process.exit(1);
}

if (unpaidRes.status !== 402) {
  const text = await unpaidRes.text();
  log("unexpected_unpaid_status", { ok: false, expectedStatus: 402, actualStatus: unpaidRes.status, body: text.slice(0, 500) });
  process.exit(1);
}

// getPaymentRequiredResponse() only decodes the PAYMENT-REQUIRED header -
// no scheme registration needed for this, so it's safe to call before
// deciding whether a wallet is even involved (dry run vs --execute).
const coreClient = new x402Client();
const buyerKey = process.env.OKX_TEST_BUYER_PRIVATE_KEY;
let account;
if (buyerKey) {
  account = privateKeyToAccount(buyerKey);
  coreClient.register("eip155:*", new ExactEvmScheme(toClientEvmSigner(account)));
}
const httpClient = new x402HTTPClient(coreClient);

const paymentRequired = httpClient.getPaymentRequiredResponse((name) => unpaidRes.headers.get(name));
const accepted = paymentRequired.accepts?.[0];

log("real_402_received", { ok: true, x402Version: paymentRequired.x402Version, accepts: paymentRequired.accepts });

if (!accepted) {
  log("no_accepts_in_402", { ok: false, error: "Server's 402 response had no accepts[] entries." });
  process.exit(1);
}

console.log("\n=== ABOUT TO PAY (dry run unless --execute) ===");
console.log(`Network:  ${accepted.network}`);
console.log(`Asset:    ${accepted.asset}`);
console.log(`Amount:   ${accepted.amount} (atomic units)`);
console.log(`Pay to:   ${accepted.payTo}`);
console.log(`Tool:     ${TOOL_NAME} (real askPrice $${config.askPrice})`);
console.log("================================================\n");

if (!execute) {
  log("dry_run_complete", {
    ok: true,
    executed: false,
    note: "Dry run only - no wallet was used, nothing was signed or sent. Re-run with --execute to submit a real signed payment.",
  });
  process.exit(0);
}

if (!buyerKey) {
  log("missing_buyer_key", { ok: false, error: "OKX_TEST_BUYER_PRIVATE_KEY not set - required for --execute." });
  process.exit(1);
}

log("signing", { ok: true, payerAddress: account.address });

let paymentPayload;
try {
  paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
} catch (err) {
  log("sign_failed", { ok: false, error: String(err?.message ?? err) });
  process.exit(1);
}

log("submitting_real_payment", {
  ok: true,
  note: "Replaying the signed payment to the real deployed /a2mcp endpoint - verify+settle happen there, via the real OKX facilitator.",
});

let paidRes;
try {
  paidRes = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...httpClient.encodePaymentSignatureHeader(paymentPayload),
    },
    body: JSON.stringify(callBody),
  });
} catch (err) {
  log("paid_request_failed", { ok: false, error: String(err?.message ?? err) });
  process.exit(1);
}

const paidText = await paidRes.text();
let paidBody;
try {
  paidBody = JSON.parse(paidText);
} catch {
  paidBody = paidText;
}

let settlement = null;
try {
  settlement = httpClient.getPaymentSettleResponse((name) => paidRes.headers.get(name));
} catch {
  // No PAYMENT-RESPONSE header (e.g. the request failed before settlement
  // was ever attempted) - not fatal, the raw status/body below is still
  // reported honestly either way.
}

if (paidRes.status === 200 && settlement?.success) {
  log("payment_succeeded", {
    ok: true,
    httpStatus: paidRes.status,
    settlement: {
      success: settlement.success,
      status: settlement.status,
      transaction: settlement.transaction,
      network: settlement.network,
      payer: settlement.payer,
      amount: settlement.amount,
    },
    realDataReturned: paidBody,
  });
  process.exit(0);
} else {
  log("payment_failed_or_unconfirmed", {
    ok: false,
    httpStatus: paidRes.status,
    settlement,
    responseBody: paidBody,
  });
  process.exit(1);
}
