/**
 * Valiquo - a negotiated-price payment layer in front of live financial
 * and on-chain intelligence data, settled via Circle Gateway/x402 on Arc.
 *
 * Current scope: single seller, BTC Cycle Intelligence (5 tools).
 */

import express from "express";
import cors from "cors";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { generatePrivateKey } from "viem/accounts";
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { logSettlementOnChain } from "./settlementLog.ts";

const app = express();
app.use(express.json());
// Allows the web/ frontend (localhost:3001, later its production domain) to
// call this API directly from the browser. Wide open for local development -
// restrict this to the actual production frontend origin before public
// deployment. exposedHeaders is required so browser JS can actually read
// these two custom response headers via fetch's Response.headers - without
// it the request succeeds but the headers are invisible to client code,
// even same-origin-looking code, per the CORS spec's default header allowlist.
app.use(cors({ exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));

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

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env");
  process.exit(1);
}

// Named so /pricing can expose the real value instead of a second, drifting
// copy of the literal.
const NETWORK = "eip155:5042002";

const gateway = createGatewayMiddleware({
  sellerAddress: SELLER_ADDRESS,
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  networks: [NETWORK],
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
  // Recorded at creation so /activity can tell an open accept apart from an
  // unresolved counter - both look identical via `state` alone until paid.
  decision: "accept" | "counter";
  // Set when payment settled (state is FULFILLED) but callMcpTool() kept
  // failing after retries - a "paid, undelivered" record, kept visible
  // rather than silently dropped.
  fulfillmentFailure?: string;
  // The real payer address from the verified/settled Gateway payment
  // (req.payment.payer, per @circle-fin/x402-batching's PaymentRequest
  // type). Only ever set once payment has actually landed.
  payerAddress?: string;
}

// --- Postgres-backed storage -------------------------------------------
// Was three in-memory stores (quotes Map, negotiationRounds Map, rejections
// array) that reset to empty on every process restart - real user
// transaction history was lost whenever the server redeployed or crashed.
// Railway's Postgres addon (DATABASE_URL) now backs all three so /activity
// and quote state survive a restart.
const { Pool, types } = pg;

// BIGINT (oid 20) columns come back as strings from node-postgres by
// default, since JS numbers can't safely represent the full int8 range.
// createdAt is always a Date.now() value, always well within
// Number.MAX_SAFE_INTEGER, so it's safe to parse back to a plain number
// globally rather than converting at every call site.
types.setTypeParser(20, (val: string) => parseInt(val, 10));

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Railway's managed Postgres requires TLS for external connections (e.g.
  // the public proxy URL used for local dev/testing) but presents a cert
  // that isn't chained to a public CA - the standard PaaS pattern is to
  // encrypt without verifying against a public root. Local Postgres
  // (localhost) and Railway's own *.railway.internal private network (used
  // when this server itself runs on Railway, talking to the Postgres
  // service over its private network) need no TLS at all.
  ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
});

// An idle client emitting an error (e.g. the connection was dropped by the
// server) is an 'error' event on the Pool itself in node-postgres - without
// a listener, that's an unhandled 'error' event, which crashes the process.
// This is a defensive addition the in-memory Maps never needed a DB can
// misbehave in ways a JS object never could.
pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error:", err);
});

async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      negotiation_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      tool TEXT NOT NULL,
      args JSONB NOT NULL DEFAULT '{}'::jsonb,
      agreed_price DOUBLE PRECISION NOT NULL,
      created_at BIGINT NOT NULL,
      state TEXT NOT NULL,
      decision TEXT NOT NULL,
      payer_address TEXT,
      fulfillment_failure TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rejections (
      id SERIAL PRIMARY KEY,
      tool TEXT NOT NULL,
      negotiation_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  // Not part of the Quote interface, but negotiationRounds was the second of
  // the three in-memory stores this migration covers - the round counter
  // needs to survive a restart exactly like quotes/rejections do, or a
  // negotiation resuming after a redeploy would start re-using round
  // numbers already spent before the restart.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS negotiation_rounds (
      negotiation_id TEXT PRIMARY KEY,
      round INTEGER NOT NULL
    )
  `);
}

function rowToQuote(row: any): Quote {
  return {
    id: row.id,
    tool: row.tool,
    args: row.args ?? {},
    agreedPrice: Number(row.agreed_price),
    createdAt: row.created_at,
    state: row.state,
    negotiationId: row.negotiation_id,
    round: row.round,
    decision: row.decision,
    fulfillmentFailure: row.fulfillment_failure ?? undefined,
    payerAddress: row.payer_address ?? undefined,
  };
}

// How long an accepted/countered quote stays payable. Needs to comfortably
// cover a real human wallet-signing flow (connect MetaMask, review, sign) -
// 120s proved too short in practice, so this is 10 minutes rather than
// something that makes the negotiation feel meaningfully less "live".
const QUOTE_TTL_MS = 600_000;

// Per-negotiationId round counter, enforced server-side (not just by the
// buyer's own attempt loop). Default cap chosen to bound a single
// negotiation session to a handful of back-and-forth offers.
const MAX_NEGOTIATION_ROUNDS = 5;

// Lightweight record of rejected proposals for /activity. A reject never
// creates a Quote, so without this a rejection would leave zero trace.
// Deliberately excludes proposedPrice/reason - activity metadata should
// never leak how close a lowball offer was to the real cost floor.
interface Rejection {
  tool: string;
  negotiationId: string;
  round: number;
  createdAt: number;
}

// Atomic upsert-and-increment: a single statement, so two concurrent /quote
// calls for the same (rare, but possible) negotiationId can't both read the
// same starting count before either writes, the way a separate read-then-
// write pair could. Postgres serializes concurrent INSERT ... ON CONFLICT
// DO UPDATE on the same row via its normal row-level locking, so this keeps
// the same atomicity the in-memory Map's synchronous get+set had.
async function nextNegotiationRound(negotiationId: string): Promise<number> {
  const result = await pool.query(
    `INSERT INTO negotiation_rounds (negotiation_id, round) VALUES ($1, 1)
     ON CONFLICT (negotiation_id) DO UPDATE SET round = negotiation_rounds.round + 1
     RETURNING round`,
    [negotiationId]
  );
  return result.rows[0].round;
}

// Correlates a Gateway payment back to its quote id. GatewayMiddleware's
// lifecycle hooks only receive { paymentPayload, requirements } - no direct
// access to req.params - so the request-scoped id is threaded through via
// AsyncLocalStorage instead of trusting any client-supplied field on the
// payment payload (e.g. paymentPayload.resource.url is plain JSON, not
// covered by the EIP-712 signature, and so is spoofable by the caller).
const quoteContext = new AsyncLocalStorage<string>();

// Express 4 does not catch rejected promises from async route handlers -
// an unhandled rejection there just hangs the request. This wraps a handler
// so a thrown/rejected DB error reaches Express's error middleware instead.
// The in-memory Maps never needed this since a Map access can't throw.
function asyncHandler(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

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

app.post("/quote", asyncHandler(async (req, res) => {
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
  const round = await nextNegotiationRound(negotiationId);

  if (round > MAX_NEGOTIATION_ROUNDS) {
    await pool.query(
      `INSERT INTO rejections (tool, negotiation_id, round, created_at) VALUES ($1, $2, $3, $4)`,
      [tool, negotiationId, round, Date.now()]
    );
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
    await pool.query(
      `INSERT INTO rejections (tool, negotiation_id, round, created_at) VALUES ($1, $2, $3, $4)`,
      [tool, negotiationId, round, Date.now()]
    );
    res.status(200).json({ decision: "reject", reason: result.reason, negotiationId, round });
    return;
  }

  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO quotes (id, negotiation_id, round, tool, args, agreed_price, created_at, state, decision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8)`,
    [id, negotiationId, round, tool, JSON.stringify(args ?? {}), result.price, Date.now(), result.decision]
  );

  res.status(200).json({
    decision: result.decision,
    quoteId: id,
    agreedPrice: result.price,
    reason: result.reason,
    payUrl: `/pay/${id}`,
    expiresInSeconds: QUOTE_TTL_MS / 1000,
    negotiationId,
    round,
  });
}));

// GET /activity - metadata about past negotiations (never the paid BTC
// Cycle Intelligence content itself, and never a rejected proposal's
// price/reason - see the Rejection comment above). Reads from Postgres, so
// unlike the old in-memory Maps/array, this now survives a server restart.
//
// Decision derivation:
// - FULFILLED or PROCESSING: someone has already committed to paying this
//   quote's agreedPrice, so it counts as "accepted" regardless of whether
//   that price arrived via an immediate accept or a countered price that
//   was paid later.
// - OPEN: falls back to the decision recorded on the Quote at creation
//   time, since an open accept and an unresolved counter are otherwise
//   indistinguishable from stored state alone.
// - Entries with no Quote at all (rejections) are always "rejected".
const DEFAULT_ACTIVITY_LIMIT = 100;

app.get("/activity", asyncHandler(async (req, res) => {
  const limitParam = Number(req.query.limit);
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : DEFAULT_ACTIVITY_LIMIT;

  const [quotesResult, rejectionsResult] = await Promise.all([
    pool.query(`SELECT * FROM quotes`),
    pool.query(`SELECT * FROM rejections`),
  ]);

  const fromQuotes = quotesResult.rows.map(rowToQuote).map((quote) => ({
    quoteId: quote.id,
    negotiationId: quote.negotiationId,
    round: quote.round,
    tool: quote.tool,
    decision:
      quote.state === "FULFILLED" || quote.state === "PROCESSING" || quote.decision === "accept"
        ? ("accepted" as const)
        : ("countered" as const),
    agreedPrice: quote.agreedPrice,
    createdAt: quote.createdAt,
    state: quote.state as string,
    // Only ever surfaced once a real payment has actually settled - never
    // for OPEN/PROCESSING records, where no payer exists yet.
    payerAddress: quote.state === "FULFILLED" ? quote.payerAddress ?? null : null,
  }));

  const fromRejections = rejectionsResult.rows.map((r) => ({
    quoteId: null as string | null,
    negotiationId: r.negotiation_id as string,
    round: r.round as number,
    tool: r.tool as string,
    decision: "rejected" as const,
    agreedPrice: null as number | null,
    createdAt: r.created_at as number,
    state: null as string | null,
    payerAddress: null as string | null,
  }));

  const activity = [...fromQuotes, ...fromRejections]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((entry) => ({ ...entry, createdAt: new Date(entry.createdAt).toISOString() }));

  res.status(200).json(activity);
}));

// GET /pricing - read-only pricing configuration: the real cost floor and
// ask price /quote negotiates against for each tool, plus the seller
// address and settlement network, straight from this file's own constants
// (never a second, hand-copied set of numbers). Purely additive - no
// negotiation logic here.
app.get("/pricing", (_req, res) => {
  const tools = Object.keys(COST_FLOOR_USDC).map((tool) => ({
    tool,
    costFloor: COST_FLOOR_USDC[tool],
    askPrice: ASK_PRICE_USDC[tool],
  }));
  res.status(200).json({ sellerAddress: SELLER_ADDRESS, network: NETWORK, tools });
});

// GET /revenue - read-only view of the seller's real Circle Gateway
// balance, i.e. actual settled USDC payments from /pay/:id. Uses a
// throwaway signing key purely because GatewayClient's constructor
// requires one - getBalances(address) queries the given address's public
// Gateway balance and never signs or sends anything with that key.
// Additive and read-only: no negotiation/payment/state-machine logic here.
app.get("/revenue", asyncHandler(async (_req, res) => {
  const throwawayKey = generatePrivateKey();
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: throwawayKey });
  const balances = await client.getBalances(SELLER_ADDRESS);

  res.status(200).json({
    sellerAddress: SELLER_ADDRESS,
    gatewayTotal: balances.gateway.formattedTotal,
    gatewayAvailable: balances.gateway.formattedAvailable,
  });
}));

app.get("/pay/:id", asyncHandler(async (req, res, next) => {
  const result = await pool.query(`SELECT * FROM quotes WHERE id = $1`, [req.params.id]);
  if (result.rows.length === 0) { res.status(404).json({ error: "Unknown or expired quote" }); return; }
  const quote = rowToQuote(result.rows[0]);
  if (quote.state !== "OPEN") {
    const detail = quote.state === "FULFILLED" ? "Quote already redeemed" : "Payment already in progress for this quote";
    res.status(409).json({ error: detail });
    return;
  }
  if (Date.now() - quote.createdAt > QUOTE_TTL_MS) { res.status(410).json({ error: "Quote expired - request a new /quote" }); return; }

  const priced = gateway.require(`$${quote.agreedPrice.toFixed(6)}`);
  quoteContext.run(req.params.id, () => priced(req as any, res as any, next));
}));

const MAX_FULFILLMENT_ATTEMPTS = 3;

app.get("/pay/:id", asyncHandler(async (req, res) => {
  // PROCESSING -> FULFILLED happens here, right after next() fires (verify +
  // settle already succeeded) and before callMcpTool() runs. Payment has
  // landed at this point, so this state is never rolled back below - a
  // fulfillment failure is a delivery problem, not a payment problem.
  //
  // req.payment is populated by the gateway middleware once verify+settle
  // succeed (see PaymentRequest in @circle-fin/x402-batching/server) - the
  // real payer address, not derived/guessed.
  const payerAddress = (req as any).payment?.payer || null;
  const updateResult = await pool.query(
    `UPDATE quotes SET state = 'FULFILLED', payer_address = $2 WHERE id = $1 RETURNING *`,
    [req.params.id, payerAddress]
  );
  const quote = rowToQuote(updateResult.rows[0]);

  // Append-only, non-custodial proof log on Arc Testnet - additive only.
  // Fire-and-forget: never awaited, never blocks the response or the
  // fulfillment retry loop below, and a failure here can never affect the
  // already-completed payment or data delivery. Fires regardless of
  // whether callMcpTool() below succeeds, since the settlement itself is
  // already real at this point either way.
  logSettlementOnChain(quote)
    .then((txHash) => console.log(`Settlement logged on-chain (negotiation ${quote.negotiationId}): ${txHash}`))
    .catch((err) => console.error("Settlement log failed (non-fatal - payment already settled):", err));

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_FULFILLMENT_ATTEMPTS; attempt++) {
    try {
      const data = await callMcpTool(quote.tool, quote.args);
      await pool.query(`UPDATE quotes SET fulfillment_failure = NULL WHERE id = $1`, [quote.id]);
      res.json({
        message: "Payment accepted - here is your data.",
        tool: quote.tool,
        agreedPrice: quote.agreedPrice,
        data,
        negotiationId: quote.negotiationId,
        round: quote.round,
        payerAddress: quote.payerAddress ?? null,
      });
      return;
    } catch (err) {
      lastError = err as Error;
    }
  }

  // Paid but undelivered after retries - surfaced as a distinct record on
  // the quote (not hidden), rather than pretending the quote never happened.
  const fulfillmentFailure = lastError?.message ?? "Unknown fulfillment error";
  await pool.query(`UPDATE quotes SET fulfillment_failure = $2 WHERE id = $1`, [quote.id, fulfillmentFailure]);
  res.status(502).json({
    error: "Payment succeeded but data fulfillment failed after retries.",
    quoteId: quote.id,
    negotiationId: quote.negotiationId,
    round: quote.round,
    detail: fulfillmentFailure,
  });
}));

// OPEN -> PROCESSING transition. This hook only fires once a real signed
// payment payload has arrived (an unpaid discovery request never reaches
// runVerifyLifecycle()), so it cannot wrongly flip state on a plain 402
// probe. Unlike the old in-memory Map (a synchronous get+set, atomic for
// free within Node's single-threaded event loop), every step here is now an
// async DB round trip, which reopens a real race: two near-simultaneous
// signed requests for the same quote could both read state="OPEN" before
// either writes. The UPDATE ... WHERE state = 'OPEN' below closes that -
// it's a single atomic statement, so only one concurrent request can ever
// match and flip the row; Postgres's row-level locking on UPDATE serializes
// the rest, and a second request simply matches zero rows once the first
// commits.
gateway.onBeforeVerify(async (ctx: any) => {
  const amountUsdc = Number(ctx?.requirements?.amount ?? 0) / 1_000_000;
  if (amountUsdc > 0 && amountUsdc < 0.001) {
    return { abort: true, reason: "Payment below absolute floor safety net." };
  }

  const quoteId = quoteContext.getStore();
  if (!quoteId) {
    return { abort: true, reason: "Payment is not associated with a known quote." };
  }

  const updateResult = await pool.query(
    `UPDATE quotes SET state = 'PROCESSING' WHERE id = $1 AND state = 'OPEN' RETURNING id`,
    [quoteId]
  );
  if (updateResult.rows.length === 0) {
    // Either the quote doesn't exist, or it exists but wasn't OPEN (already
    // claimed by a concurrent request, or already FULFILLED) - re-read
    // (outside the atomic decision above) just to report which, matching
    // the original two distinct error messages.
    const current = await pool.query(`SELECT state FROM quotes WHERE id = $1`, [quoteId]);
    if (current.rows.length === 0) {
      return { abort: true, reason: "Unknown or expired quote." };
    }
    return { abort: true, reason: `Quote is already ${(current.rows[0].state as string).toLowerCase()}.` };
  }
});

// PROCESSING -> OPEN recovery: a transient verify/settle failure must not
// permanently lock a quote out of being paid again.
//
// Diagnostic logging: onVerifyFailure/onSettleFailure only fire when the SDK
// call itself throws - a *different* failure class from a normal API
// response with success:false (e.g. Circle's settle endpoint responding
// with {success:false, errorReason:"..."}), which is what actually produces
// the generic "Payment settlement failed" the client sees. That case never
// throws, so it never reaches these two hooks - onAfterSettle below is the
// only hook that sees it, since it runs on every settle attempt regardless
// of outcome.
//
// These three recovery hooks aren't Express routes, so a thrown/rejected DB
// error here wouldn't reach an Express error handler - it would be an
// unhandled rejection, which crashes the whole process. They're wrapped in
// try/catch and log-only: the original failure is already logged above the
// recovery attempt, so a failed recovery is unfortunate (the quote stays
// PROCESSING) but must not take the server down.
gateway.onVerifyFailure(async (ctx: any) => {
  console.error(`[verify threw] quote=${quoteContext.getStore() ?? "unknown"}:`, ctx?.error?.message ?? ctx?.error);
  try {
    await pool.query(`UPDATE quotes SET state = 'OPEN' WHERE id = $1 AND state = 'PROCESSING'`, [quoteContext.getStore() ?? ""]);
  } catch (err) {
    console.error("Failed to recover quote state after verify failure:", err);
  }
});

gateway.onSettleFailure(async (ctx: any) => {
  console.error(`[settle threw] quote=${quoteContext.getStore() ?? "unknown"}:`, ctx?.error?.message ?? ctx?.error);
  try {
    await pool.query(`UPDATE quotes SET state = 'OPEN' WHERE id = $1 AND state = 'PROCESSING'`, [quoteContext.getStore() ?? ""]);
  } catch (err) {
    console.error("Failed to recover quote state after settle failure:", err);
  }
});

// Fires on every settle attempt (success or a normal failed-result response)
// - the real errorReason from Circle's Gateway API for the soft-failure case
// described above.
gateway.onAfterSettle(async (ctx: any) => {
  if (!ctx?.result?.success) {
    console.error(
      `[settle failed] quote=${quoteContext.getStore() ?? "unknown"} network=${ctx?.result?.network}:`,
      ctx?.result?.errorReason ?? "(no errorReason provided)"
    );
    try {
      await pool.query(`UPDATE quotes SET state = 'OPEN' WHERE id = $1 AND state = 'PROCESSING'`, [quoteContext.getStore() ?? ""]);
    } catch (err) {
      console.error("Failed to recover quote state after soft settle failure:", err);
    }
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

// Falls through to here when an async route handler's promise rejects (see
// asyncHandler) - keeps error responses JSON, consistent with the rest of
// this API, rather than Express's default HTML error page.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled request error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

async function main() {
  await ensureSchema();

  const PORT = process.env.PORT ?? 3000;
  app.listen(PORT, () => {
    console.log(`Valiquo listening on http://localhost:${PORT}`);
    console.log(`Seller: ${SELLER_ADDRESS}`);
    console.log(`Wrapping MCP tool server: ${BTC_CYCLE_MCP_URL}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
