/**
 * The real, shared tool catalog: 3 live data sellers, priced per real tool.
 * Both the negotiated-price flow (src/server.ts, POST /quote + GET /pay/:id)
 * and the fixed-price A2MCP flow (src/okxA2mcp.ts, POST /a2mcp) sell from this
 * exact same map - a second, hand-copied catalog would drift the moment one
 * seller's pricing changed and the other didn't.
 */

const BTC_CYCLE_MCP_URL =
  process.env.BTC_CYCLE_MCP_URL ?? "https://btc-cycle-intelligence-production-410b.up.railway.app/mcp";

const SHORT_SQUEEZE_MCP_URL =
  process.env.SHORT_SQUEEZE_MCP_URL ?? "https://short-squeeze-intelligence-production-6b31.up.railway.app/mcp";

const ANALYST_MOMENTUM_MCP_URL =
  process.env.ANALYST_MOMENTUM_MCP_URL ?? "https://analyst-momentum-production-4a1d.up.railway.app/mcp";

export interface ToolConfig {
  mcpUrl: string;
  costFloor: number;
  askPrice: number;
  // Present only for tools that need caller-supplied arguments (e.g. a
  // ticker). Checked before any price negotiation - a quote for a tool
  // missing a required arg would otherwise still get priced and paid, only
  // failing later at fulfillment.
  requiredArgs?: string[];
}

// Single lookup spanning all three sellers - tool name is the key everywhere
// this map is used (decide(), callMcpTool(), /pricing, /a2mcp), so one merged
// map avoids a second seller-indirection layer. Tool names are already unique
// across all three sellers' real tool sets.
export const TOOLS: Record<string, ToolConfig> = {
  get_btc_cycle_regime: { mcpUrl: BTC_CYCLE_MCP_URL, costFloor: 0.003, askPrice: 0.008 },
  get_lth_behavior: { mcpUrl: BTC_CYCLE_MCP_URL, costFloor: 0.0015, askPrice: 0.004 },
  get_entry_risk: { mcpUrl: BTC_CYCLE_MCP_URL, costFloor: 0.0015, askPrice: 0.004 },
  compare_to_2021_top: { mcpUrl: BTC_CYCLE_MCP_URL, costFloor: 0.002, askPrice: 0.005 },
  get_nupl_sentiment: { mcpUrl: BTC_CYCLE_MCP_URL, costFloor: 0.0015, askPrice: 0.004 },
  // Short Squeeze Intelligence exposes 5 MCP tool names, but only 2 are
  // priced here. Confirmed live against the seller's own source
  // (short-squeeze-intelligence/src/index.js): tools/call routes every
  // tool name except compare_squeeze_risk through the identical
  // getSqueezeData(ticker) call, with no differentiation by tool name -
  // get_short_interest, get_cost_to_borrow, and get_short_interest_trend
  // return byte-identical payloads to get_squeeze_risk for the same
  // ticker. Pricing them as separate paid products would charge for the
  // same output under different names, so they deliberately have no
  // TOOLS entry - get_squeeze_risk is the one priced, real single-ticker
  // offering.
  get_squeeze_risk: { mcpUrl: SHORT_SQUEEZE_MCP_URL, costFloor: 0.003, askPrice: 0.008, requiredArgs: ["ticker"] },
  compare_squeeze_risk: {
    mcpUrl: SHORT_SQUEEZE_MCP_URL,
    costFloor: 0.002,
    askPrice: 0.005,
    requiredArgs: ["ticker1", "ticker2"],
  },
  // Analyst Momentum exposes 8 MCP tool names, but only 3 are priced here.
  // Confirmed live against the seller's own source (Analyst momentum/src/
  // index.js): tools/call routes get_analyst_consensus, get_analyst_price_
  // target, get_sentiment_shift, get_analyst_conviction, and get_bearish_
  // reversal_signal all through the identical getAnalystMomentum(ticker)
  // call and return the same structuredContent for the same ticker - only
  // the human-readable text summary differs per name. Same reasoning as
  // Short Squeeze's unpriced duplicates: pricing them separately would
  // charge for the same output under different names. get_analyst_momentum
  // (the full composite), compare_analyst_momentum, and
  // screen_analyst_momentum each do genuinely distinct computation, so
  // those are the 3 priced here. askPrice for get_analyst_momentum is the
  // seller's own declared _meta.pricing.queryUsd ($0.07) - used directly,
  // not invented; the other two are scaled off it using this map's
  // existing flagship/compare price ratios.
  get_analyst_momentum: {
    mcpUrl: ANALYST_MOMENTUM_MCP_URL,
    costFloor: 0.025,
    askPrice: 0.07,
    requiredArgs: ["ticker"],
  },
  compare_analyst_momentum: {
    mcpUrl: ANALYST_MOMENTUM_MCP_URL,
    costFloor: 0.018,
    askPrice: 0.045,
    requiredArgs: ["ticker1", "ticker2"],
  },
  screen_analyst_momentum: {
    mcpUrl: ANALYST_MOMENTUM_MCP_URL,
    costFloor: 0.03,
    askPrice: 0.08,
    requiredArgs: ["tickers"],
  },
};

// Shared by both the negotiated flow's decide() and the A2MCP flow's
// onProtectedRequest gate, so "what counts as a missing required arg" can
// never drift between the two payment rails. Most required args are single
// ticker strings, but screen_analyst_momentum's "tickers" is an array (2-5
// symbols) - a required arg is missing if it's an empty/blank string, or an
// empty array.
export function findMissingRequiredArgs(config: ToolConfig, args: Record<string, unknown>): string[] {
  if (!config.requiredArgs) return [];
  return config.requiredArgs.filter((key) => {
    const value = args[key];
    if (Array.isArray(value)) return value.length === 0;
    return typeof value !== "string" || !value;
  });
}

export async function callMcpTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const config = TOOLS[tool];
  if (!config) throw new Error(`Unknown tool: ${tool}`);
  const r = await fetch(config.mcpUrl, {
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
