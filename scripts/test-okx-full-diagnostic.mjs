// Standalone, read-only diagnostic for the entire OKX x402 integration
// chain behind src/okxA2mcp.ts (POST /a2mcp). Run from the SAME environment
// src/server.ts runs in (e.g. Railway) - this exists specifically to rule
// network/geo restrictions in or out as a variable, separately from
// credential problems and separately from request-building bugs.
//
// Safety: every step here is read-only. Nothing in this script ever calls
// /verify or /settle, so no funds can move and no quote/state is created
// anywhere - safe to run as many times as needed.
//
// Imports TOOLS directly from src/tools.ts (the real, single catalog both
// payment rails sell from - never a second, hand-copied price list), so
// this needs the same flag src/server.ts itself already requires. Run with:
//
//   node --experimental-transform-types --no-warnings scripts/test-okx-full-diagnostic.mjs

import crypto from "node:crypto";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { x402ResourceServer } from "@okxweb3/x402-core/server";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { TOOLS } from "../src/tools.ts";

const BASE_URL = "https://web3.okx.com";
const SUPPORTED_PATH = "/api/v6/pay/x402/supported";
const DIAGNOSTIC_TOOL = "get_btc_cycle_regime";
const REQUEST_TIMEOUT_MS = 10_000;

const results = [];

function record(step, name, ok, detail) {
  results.push({ step, name, ok, detail });
  console.log(`\n[Step ${step}] ${name}: ${ok ? "PASS" : "FAIL"}`);
  if (detail !== undefined) {
    console.log(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  }
}

function printSummaryAndExit() {
  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(`Step ${r.step} - ${r.name}: ${r.ok ? "PASS" : "FAIL"}`);
  }
  const firstFailure = results.find((r) => !r.ok);
  if (firstFailure) {
    console.log(`\nFirst failure: Step ${firstFailure.step} - ${firstFailure.name}`);
    console.log(JSON.stringify(firstFailure.detail, null, 2));
    process.exit(1);
  }
  console.log("\nAll steps passed - the OKX x402 integration chain works end to end from this environment.");
  process.exit(0);
}

console.log("=== OKX x402 integration diagnostic ===");
console.log(`Run at: ${new Date().toISOString()}`);
console.log(`Node: ${process.version}, platform: ${process.platform}`);

// --- Step 1: required env vars ---------------------------------------------
const REQUIRED_VARS = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE", "OKX_SELLER_ADDRESS"];
const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
const network = process.env.OKX_NETWORK || "eip155:196";

if (missing.length > 0) {
  // Lengths only, never the actual secret values - same discipline as the
  // rest of this repo's diagnostics around OKX_API_KEY/OKX_SECRET_KEY/
  // OKX_PASSPHRASE.
  record(1, "Required env vars present", false, {
    missing,
    present: REQUIRED_VARS.filter((v) => !missing.includes(v)),
    network,
  });
  printSummaryAndExit();
}
record(1, "Required env vars present", true, {
  present: REQUIRED_VARS,
  network,
  lengths: Object.fromEntries(REQUIRED_VARS.map((v) => [v, process.env[v].length])),
});

const apiKey = process.env.OKX_API_KEY;
const secretKey = process.env.OKX_SECRET_KEY;
const passphrase = process.env.OKX_PASSPHRASE;
const sellerAddress = process.env.OKX_SELLER_ADDRESS;

// --- Step 2: raw reachability, no auth --------------------------------------
// Same exact endpoint as step 3, deliberately with zero auth headers - the
// only thing that should distinguish step 2 from step 3 is authentication.
// "ok" here means "the network layer worked" (we got *an* HTTP response),
// regardless of what status code OKX returns for an unauthenticated call.
try {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}${SUPPORTED_PATH}`, {
    method: "GET",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  record(2, "Raw network reachability to web3.okx.com (unauthenticated)", true, {
    httpStatus: res.status,
    elapsedMs: Date.now() - start,
    bodyPreview: text.slice(0, 300),
  });
} catch (err) {
  record(2, "Raw network reachability to web3.okx.com (unauthenticated)", false, {
    errorName: err?.name,
    errorMessage: err?.message,
    cause: err?.cause ? String(err.cause) : undefined,
  });
  printSummaryAndExit();
}

// --- Step 3: authenticated GET /supported -----------------------------------
// Mirrors OKXFacilitatorClient's internal createHeaders() HMAC-SHA256
// signing exactly (same algorithm src/okxA2mcp.ts's OKXFacilitatorClient
// uses under the hood), hand-rolled here only so we can see OKX's actual
// response body on failure - the SDK's own getSupported() swallows the
// body and throws just a bare status code.
function signOkxRequest(method, path, body) {
  const timestamp = new Date().toISOString();
  const prehash = timestamp + method + path + (body ?? "");
  const sign = crypto.createHmac("sha256", secretKey).update(prehash).digest("base64");
  return {
    "OK-ACCESS-KEY": apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": passphrase,
    "Content-Type": "application/json",
  };
}

let step3Ok = false;
try {
  const headers = signOkxRequest("GET", SUPPORTED_PATH);
  const res = await fetch(`${BASE_URL}${SUPPORTED_PATH}`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  step3Ok = res.ok;
  // Never log `headers` here - OK-ACCESS-KEY and OK-ACCESS-PASSPHRASE are
  // real secrets and must never reach stdout/logs.
  record(3, "Authenticated GET /api/v6/pay/x402/supported", res.ok, {
    httpStatus: res.status,
    responseBody: body,
  });
} catch (err) {
  record(3, "Authenticated GET /api/v6/pay/x402/supported", false, {
    errorName: err?.name,
    errorMessage: err?.message,
  });
}

if (!step3Ok) {
  printSummaryAndExit();
}

// --- Step 4: build (never submit) a real payment requirement ---------------
// Uses the real SDK objects src/okxA2mcp.ts uses in production (not a hand-
// rolled replica, unlike step 3) - this step is about proving the actual
// request-building code path works, not just raw auth. Nothing here ever
// calls verify/settle, and buildPaymentRequirementsFromOptions() has no
// side effects - it only resolves the dynamic price/payTo and returns a
// plain object.
try {
  const facilitatorClient = new OKXFacilitatorClient({ apiKey, secretKey, passphrase });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(network, new ExactEvmScheme());

  // Same one-time startup validation src/okxA2mcp.ts's mountA2mcp() runs -
  // fetches supported schemes/networks from the facilitator so
  // buildPaymentRequirements() below can validate against them.
  await resourceServer.initialize();

  const config = TOOLS[DIAGNOSTIC_TOOL];
  if (!config) {
    throw new Error(`Diagnostic tool "${DIAGNOSTIC_TOOL}" not found in TOOLS - src/tools.ts may have changed.`);
  }

  // Fakes just enough of HTTPRequestContext for the dynamic price() function
  // src/okxA2mcp.ts registers - it only ever reads context.adapter.getBody().
  // No Express app, no real HTTP request/response involved.
  const fakeContext = {
    adapter: { getBody: () => ({ method: "tools/call", params: { name: DIAGNOSTIC_TOOL, arguments: {} } }) },
    path: "/a2mcp",
    method: "POST",
  };

  const paymentOptions = [
    {
      scheme: "exact",
      network,
      payTo: sellerAddress,
      price: `$${config.askPrice.toFixed(6)}`,
    },
  ];

  const requirements = await resourceServer.buildPaymentRequirementsFromOptions(paymentOptions, fakeContext);

  record(4, "Build real payment requirements (nothing submitted)", true, {
    tool: DIAGNOSTIC_TOOL,
    realAskPriceUsd: config.askPrice,
    requirements,
  });
} catch (err) {
  record(4, "Build real payment requirements (nothing submitted)", false, {
    errorName: err?.name,
    errorMessage: err?.message,
    stack: err?.stack,
  });
}

printSummaryAndExit();
