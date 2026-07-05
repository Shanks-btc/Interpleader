/**
 * Valiquo - a negotiated-price payment layer in front of live financial
 * and on-chain intelligence data, settled via Circle Gateway/x402 on Arc.
 *
 * Current scope: single seller, BTC Cycle Intelligence (5 tools).
 */

import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { AsyncLocalStorage } from "node:async_hooks";

const app = express();
app.use(express.json());

const SELLER_ADDRESS = process.env.SELLER_ADDRESS as `0x${string}` | undefined;

const BTC_CYCLE_MCP_URL =
  process.env.BTC_CYCLE_MCP_URL ?? "https://btc-cycle-intelligence-production-410b.up.railway.app/mcp";

const BTC_TOOLS = new Set([
  "get_btc_cycle_regime",
  "get_lth_behavior",
  "get_entry_risk",
  "compare_to_2021_top",
  "get_nupl_sentiment",
]);

const COST_FLOOR_USDC: Record<string, number> = {
  get_btc_cycle_regime: 0.003,
  get_lth_behavior: 0.0015,
  get_entry_risk: 0.0015,
  compare_to_2021_top: 0.002,
  get_nupl_sentiment: 0.0015,
};

const ASK_PRICE_USDC: Record<string, number> = {
  get_btc_cycle_regime: 0.008,
  get_lth_behavior: 0.004,
  get_entry_risk: 0.004,
  compare_to_2021_top: 0.005,
  get_nupl_sentiment: 0.004,
};

if (!SELLER_ADDRESS) {
  console.error("Missing SELLER_ADDRESS in .env");
  process.exit(1);
}

const gateway = createGatewayMiddleware({
  sellerAddress: SELLER_ADDRESS,
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  networks: ["eip155:5042002"],
});

type QuoteState = "OPEN" | "PROCESSING" | "FULFILLED";

interface Quote {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  agreedPrice: number;
  createdAt: number;
  state: QuoteState;
  negotiationId: string;
  round: number;
  // Set when payment settled (state is FULFILLED) but callMcpTool() kept
  // failing after retries - a "paid, undelivered" record, kept visible
  // rather than silently dropped.
  fulfillmentFailure?: string;
}
const quotes = new Map<string, Quote>();

// Per-negotiationId round counter, enforced server-side (not just by the
// buyer's own attempt loop). Default cap chosen to bound a single
// negotiation session to a handful of back-and-forth offers.
const MAX_NEGOTIATION_ROUNDS = 5;
const negotiationRounds = new Map<string, number>();

function nextNegotiationRound(negotiationId: string): number {
  const round = (negotiationRounds.get(negotiationId) ?? 0) + 1;
  negotiationRounds.set(negotiationId, round);
  return round;
}

// Correlates a Gateway payment back to its quote id. GatewayMiddleware's
// lifecycle hooks only receive { paymentPayload, requirements } - no direct
// access to req.params - so the request-scoped id is threaded through via
// AsyncLocalStorage instead of trusting any client-supplied field on the
// payment payload (e.g. paymentPayload.resource.url is plain JSON, not
// covered by the EIP-712 signature, and so is spoofable by the caller).
const quoteContext = new AsyncLocalStorage<string>();

function decide(tool: string, proposedPrice: number): { decision: "accept" | "reject" | "counter"; price: number; reason: string } {
  if (!BTC_TOOLS.has(tool)) {
    return { decision: "reject", price: 0, reason: `Unknown tool: ${tool}` };
  }
  const floor = COST_FLOOR_USDC[tool];
  const ask = ASK_PRICE_USDC[tool];

  if (proposedPrice >= ask) {
    return { decision: "accept", price: ask, reason: "Offer meets or exceeds asking price." };
  }
  if (proposedPrice >= floor) {
    return { decision: "accept", price: proposedPrice, reason: "Offer clears cost floor; accepted at proposed price." };
  }
  if (proposedPrice >= floor * 0.5) {
    return { decision: "counter", price: floor, reason: "Offer below cost floor; countering at floor price." };
  }
  return { decision: "reject", price: 0, reason: "Offer too far below cost floor to be worth countering." };
}

app.post("/quote", (req, res) => {
  const { tool, args, proposedPrice, negotiationId: incomingNegotiationId } = req.body as {
    tool: string;
    args?: Record<string, unknown>;
    proposedPrice: number;
    negotiationId?: string;
  };

  if (!tool || typeof proposedPrice !== "number") {
    res.status(400).json({ error: "tool and proposedPrice are required" });
    return;
  }

  const negotiationId = incomingNegotiationId ?? crypto.randomUUID();
  const round = nextNegotiationRound(negotiationId);

  if (round > MAX_NEGOTIATION_ROUNDS) {
    res.status(200).json({
      decision: "reject",
      reason: `Max negotiation rounds (${MAX_NEGOTIATION_ROUNDS}) exceeded for this session.`,
      negotiationId,
      round,
    });
    return;
  }

  const result = decide(tool, proposedPrice);

  if (result.decision === "reject") {
    res.status(200).json({ decision: "reject", reason: result.reason, negotiationId, round });
    return;
  }

  const id = crypto.randomUUID();
  quotes.set(id, {
    id,
    tool,
    args: args ?? {},
    agreedPrice: result.price,
    createdAt: Date.now(),
    state: "OPEN",
    negotiationId,
    round,
  });

  res.status(200).json({
    decision: result.decision,
    quoteId: id,
    agreedPrice: result.price,
    reason: result.reason,
    payUrl: `/pay/${id}`,
    expiresInSeconds: 120,
    negotiationId,
    round,
  });
});

app.get("/pay/:id", (req, res, next) => {
  const quote = quotes.get(req.params.id);
  if (!quote) { res.status(404).json({ error: "Unknown or expired quote" }); return; }
  if (quote.state !== "OPEN") {
    const detail = quote.state === "FULFILLED" ? "Quote already redeemed" : "Payment already in progress for this quote";
    res.status(409).json({ error: detail });
    return;
  }
  if (Date.now() - quote.createdAt > 120_000) { res.status(410).json({ error: "Quote expired - request a new /quote" }); return; }

  const priced = gateway.require(`$${quote.agreedPrice.toFixed(6)}`);
  quoteContext.run(req.params.id, () => priced(req as any, res as any, next));
});

const MAX_FULFILLMENT_ATTEMPTS = 3;

app.get("/pay/:id", async (req, res) => {
  const quote = quotes.get(req.params.id)!;
  // PROCESSING -> FULFILLED happens here, right after next() fires (verify +
  // settle already succeeded) and before callMcpTool() runs. Payment has
  // landed at this point, so this state is never rolled back below - a
  // fulfillment failure is a delivery problem, not a payment problem.
  quote.state = "FULFILLED";

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_FULFILLMENT_ATTEMPTS; attempt++) {
    try {
      const data = await callMcpTool(quote.tool, quote.args);
      quote.fulfillmentFailure = undefined;
      res.json({
        message: "Payment accepted - here is your data.",
        tool: quote.tool,
        agreedPrice: quote.agreedPrice,
        data,
        negotiationId: quote.negotiationId,
        round: quote.round,
      });
      return;
    } catch (err) {
      lastError = err as Error;
    }
  }

  // Paid but undelivered after retries - surfaced as a distinct record on
  // the quote (not hidden), rather than pretending the quote never happened.
  quote.fulfillmentFailure = lastError?.message ?? "Unknown fulfillment error";
  res.status(502).json({
    error: "Payment succeeded but data fulfillment failed after retries.",
    quoteId: quote.id,
    negotiationId: quote.negotiationId,
    round: quote.round,
    detail: quote.fulfillmentFailure,
  });
});

// OPEN -> PROCESSING transition. This hook only fires once a real signed
// payment payload has arrived (an unpaid discovery request never reaches
// runVerifyLifecycle()), so it cannot wrongly flip state on a plain 402
// probe. The check-and-set below has no `await` between reading and writing
// quote.state, so it is atomic against other requests in Node's event loop.
gateway.onBeforeVerify(async (ctx: any) => {
  const amountUsdc = Number(ctx?.requirements?.amount ?? 0) / 1_000_000;
  if (amountUsdc > 0 && amountUsdc < 0.001) {
    return { abort: true, reason: "Payment below absolute floor safety net." };
  }

  const quoteId = quoteContext.getStore();
  if (!quoteId) {
    return { abort: true, reason: "Payment is not associated with a known quote." };
  }
  const quote = quotes.get(quoteId);
  if (!quote) {
    return { abort: true, reason: "Unknown or expired quote." };
  }
  if (quote.state !== "OPEN") {
    return { abort: true, reason: `Quote is already ${quote.state.toLowerCase()}.` };
  }
  quote.state = "PROCESSING";
});

// PROCESSING -> OPEN recovery: a transient verify/settle failure must not
// permanently lock a quote out of being paid again.
gateway.onVerifyFailure(async () => {
  const quote = quotes.get(quoteContext.getStore() ?? "");
  if (quote?.state === "PROCESSING") {
    quote.state = "OPEN";
  }
});

gateway.onSettleFailure(async () => {
  const quote = quotes.get(quoteContext.getStore() ?? "");
  if (quote?.state === "PROCESSING") {
    quote.state = "OPEN";
  }
});

async function callMcpTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(BTC_CYCLE_MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: tool, arguments: args } }),
  });
  if (!r.ok) throw new Error(`MCP server returned ${r.status}`);

  const raw = await r.text();
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`Unexpected MCP response shape: ${raw.slice(0, 200)}`);
  const json = JSON.parse(dataLine.slice(5).trim()) as { result?: { content?: Array<{ type: string; text?: string }> }; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);

  const content = json.result?.content;
  if (!content || content.length === 0) throw new Error("MCP tool returned no content");
  const text = content[0].text ?? "";
  try { return JSON.parse(text); } catch { return text; }
}

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Valiquo listening on http://localhost:${PORT}`);
  console.log(`Seller: ${SELLER_ADDRESS}`);
  console.log(`Wrapping MCP tool server: ${BTC_CYCLE_MCP_URL}`);
});
