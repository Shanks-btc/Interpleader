/**
 * A second, independent payment rail over the exact same TOOLS catalog
 * src/server.ts's negotiated flow sells from - this one is fixed-price
 * (no negotiation) and settles via OKX's real x402 SDK on X Layer instead
 * of Circle Gateway on Arc. Exposed as a single genuine JSON-RPC endpoint,
 * POST /a2mcp, mirroring the same tools/list + tools/call shape this repo
 * already speaks to reach the real seller MCP servers (see callMcpTool in
 * tools.ts) - an agent that already knows how to call an MCP tool server
 * doesn't need to learn a second, bespoke REST shape just because this one
 * happens to charge OKX x402 instead of Circle Gateway.
 *
 * tools/list is always free (real discovery, not a paywall) - grantAccess
 * short-circuits payment entirely via onProtectedRequest below. tools/call
 * is priced dynamically per request from the same TOOLS[name].askPrice the
 * negotiated flow already treats as its real asking price - no second,
 * invented price list for this rail.
 *
 * Non-fatal if unconfigured: unlike SELLER_ADDRESS/DATABASE_URL, missing
 * OKX credentials only disable this one additive route, not the whole
 * server - the negotiated flow this repo already has real traction on
 * must keep working even before an OKX Developer Portal account exists.
 */

import express from "express";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@okxweb3/x402-express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { TOOLS, callMcpTool, findMissingRequiredArgs } from "./tools.ts";

// X Layer mainnet is the real target per OKX's SDK (default stablecoin
// USDT0, EIP-3009). eip155:1952 is X Layer testnet, for validating this
// rail with test funds before OKX_NETWORK is ever pointed at mainnet.
const XLAYER_MAINNET = "eip155:196";

interface A2mcpRequestBody {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

function getA2mcpBody(context: any): A2mcpRequestBody {
  return (context.adapter.getBody() as A2mcpRequestBody) ?? {};
}

// Real discovery payload for the free tools/list method - the same
// TOOLS catalog and fixed askPrice the paid tools/call path charges,
// never a second, hand-maintained description of what's on offer.
function toolCatalogForList() {
  return Object.entries(TOOLS).map(([name, config]) => ({
    name,
    description: `Real, priced data tool - fixed price $${config.askPrice.toFixed(6)}, no negotiation.`,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        (config.requiredArgs ?? []).map((key) => [
          key,
          key === "tickers" ? { type: "array", items: { type: "string" } } : { type: "string" },
        ])
      ),
      required: config.requiredArgs ?? [],
    },
    _meta: { pricing: { fixedUsd: config.askPrice } },
  }));
}

export function mountA2mcp(app: express.Express): void {
  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;
  const sellerAddress = process.env.OKX_SELLER_ADDRESS;
  const network = process.env.OKX_NETWORK || XLAYER_MAINNET;

  if (!apiKey || !secretKey || !passphrase || !sellerAddress) {
    console.warn(
      "A2MCP endpoint disabled: set OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE (from the OKX Developer " +
        "Portal) and OKX_SELLER_ADDRESS (X Layer payout address) to enable POST /a2mcp - fixed-price " +
        "payments via OKX's x402 SDK on X Layer, over the same TOOLS catalog the negotiated flow uses."
    );
    return;
  }

  const facilitatorClient = new OKXFacilitatorClient({ apiKey, secretKey, passphrase });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(network as any, new ExactEvmScheme());

  const routes = {
    "POST /a2mcp": {
      accepts: {
        scheme: "exact",
        network,
        payTo: sellerAddress,
        // Dynamic: the real charge is TOOLS[requested tool].askPrice, read
        // straight from the same JSON-RPC body tools/call is about to run
        // with - never a flat per-route price, since this one route serves
        // every priced tool across all three sellers.
        price: (context: any) => {
          const body = getA2mcpBody(context);
          const config = TOOLS[body.params?.name ?? ""];
          // onProtectedRequest below already rejected any request without
          // a valid, priced tool name before pricing ever runs - config is
          // guaranteed defined here.
          return `$${config!.askPrice.toFixed(6)}`;
        },
      },
      description: "Fixed-price A2MCP tool calls over Interpleader's real data catalog (OKX x402 on X Layer).",
      mimeType: "application/json",
    },
  };

  const httpServer = new x402HTTPResourceServer(resourceServer, routes as any).onProtectedRequest(async (context: any) => {
    const body = getA2mcpBody(context);
    if (body.method === "initialize" || body.method === "tools/list") {
      // Real discovery is free - grantAccess skips payment entirely rather
      // than charging an agent just to see the price list. initialize is
      // the MCP spec's session-handshake method ("MUST be the first
      // interaction") - free for the same reason tools/list is, since
      // neither one ever touches priced data.
      return { grantAccess: true };
    }
    if (body.method !== "tools/call") {
      return { abort: true, reason: "Unsupported method: expected initialize, tools/list, or tools/call" };
    }
    const toolName = body.params?.name;
    const config = toolName ? TOOLS[toolName] : undefined;
    if (!config) {
      return { abort: true, reason: `Unknown tool: ${toolName ?? "(missing)"}` };
    }
    const missing = findMissingRequiredArgs(config, body.params?.arguments ?? {});
    if (missing.length > 0) {
      return { abort: true, reason: `Missing required argument(s): ${missing.join(", ")}` };
    }
  });

  // paymentMiddlewareFromHTTPServer's default syncFacilitatorOnStart=true
  // kicks off httpServer.initialize() itself, immediately, uncaught - a bad
  // OKX_API_KEY/SECRET_KEY/PASSPHRASE would surface as an unhandled promise
  // rejection that crashes the *entire* server, taking down the already-
  // proven negotiated flow along with this additive one. Doing the same
  // initialize() call here ourselves, with a real .catch, gets the same
  // startup route-config validation without that blast radius; passing
  // syncFacilitatorOnStart=false below stops the SDK from also kicking off
  // its own second, unguarded copy of the same call.
  httpServer
    .initialize()
    .catch((err) =>
      console.error(
        "A2MCP facilitator init failed - check OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE:",
        err instanceof Error ? err.message : err
      )
    );

  app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));

  app.post("/a2mcp", async (req: express.Request, res: express.Response) => {
    const body = req.body as A2mcpRequestBody;
    const id = body.id ?? null;

    if (body.method === "initialize") {
      // Spec-required fields only (capabilities, protocolVersion,
      // serverInfo) - stateless on purpose, since every real call on this
      // rail is an independent, fixed-price HTTP request with no session
      // to actually set up (matches how the real upstream seller MCP
      // servers this repo already calls via callMcpTool() work - none of
      // them require this handshake either, confirmed live).
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "interpleader-a2mcp", version: "1.0.0" },
        },
      });
      return;
    }

    if (body.method === "tools/list") {
      res.json({ jsonrpc: "2.0", id, result: { tools: toolCatalogForList() } });
      return;
    }

    // Only tools/call reaches here with a known, valid tool - anything else
    // was already aborted with 403 by onProtectedRequest above, before any
    // payment was priced, let alone verified or settled.
    const name = body.params!.name!;
    const args = body.params?.arguments ?? {};

    try {
      const data = await callMcpTool(name, args);
      res.json({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(data) }] },
      });
    } catch (err) {
      // A >=400 status here makes the SDK skip its post-response settlement
      // step entirely (it settles only once this handler's status is < 400)
      // - a fulfillment failure after a verified payment never actually
      // charges the buyer on this rail, unlike a "paid but undelivered"
      // record on the negotiated flow.
      res.status(502).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: (err as Error).message },
      });
    }
  });

  console.log(`A2MCP endpoint live: POST /a2mcp (OKX x402, network=${network}, payTo=${sellerAddress})`);
}
