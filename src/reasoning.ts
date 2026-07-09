/**
 * LLM tool-selection reasoning layer - sits in front of the existing,
 * unchanged /quote + /pay/:id negotiation flow. Purely a router: given a
 * natural-language question, decides which one of the BTC Cycle
 * Intelligence tools (if any) answers it, with inspectable reasoning.
 *
 * Does not touch decide(), the state machine, Postgres, or pricing - the
 * caller (server.ts) combines the selected tool with the existing pricing
 * constants after this returns.
 */

import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("Missing ANTHROPIC_API_KEY - required for /ask");
    }
    client = new Anthropic();
  }
  return client;
}

// Tool descriptions rarely change and the MCP server has no notification for
// it, so a plain in-memory cache (populated once per mcpUrl, no TTL) is
// enough - avoids a tools/list round trip on every /ask call.
const descriptionCache = new Map<string, Map<string, string>>();

async function fetchMcpToolDescriptions(mcpUrl: string): Promise<Map<string, string>> {
  const r = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/list", params: {} }),
  });
  if (!r.ok) throw new Error(`MCP server returned ${r.status} for tools/list`);

  // Same SSE response shape as tools/call (see callMcpTool in server.ts).
  const raw = await r.text();
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`Unexpected MCP tools/list response shape: ${raw.slice(0, 200)}`);
  const json = JSON.parse(dataLine.slice(5).trim()) as {
    result?: { tools?: Array<{ name: string; description?: string }> };
    error?: { message: string };
  };
  if (json.error) throw new Error(json.error.message);

  const tools = json.result?.tools ?? [];
  return new Map(tools.map((t) => [t.name, t.description ?? ""]));
}

async function getToolDescriptions(mcpUrl: string): Promise<Map<string, string>> {
  let cached = descriptionCache.get(mcpUrl);
  if (!cached) {
    cached = await fetchMcpToolDescriptions(mcpUrl);
    descriptionCache.set(mcpUrl, cached);
  }
  return cached;
}

export interface ToolSelection {
  tool: string;
  reasoning: string;
  confidence: "high" | "medium" | "low";
}

// toolNames must match the tool names server.ts negotiates over (BTC_TOOLS) -
// passed in by the caller rather than imported, so this module has no
// dependency on server.ts's internals.
export async function selectTool(question: string, mcpUrl: string, toolNames: string[]): Promise<ToolSelection> {
  const descriptions = await getToolDescriptions(mcpUrl);
  const toolList = toolNames
    .map((name) => `- ${name}: ${descriptions.get(name) || "(no description available)"}`)
    .join("\n");

  const response = await getClient().messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    system:
      'You are a routing layer for a BTC on-chain intelligence service. Given a user\'s natural-language question, decide which ONE of the listed tools (if any) would answer it. Only select a tool if it clearly and directly answers the question. If the question is ambiguous, off-topic, or does not map cleanly to any tool, select "none" and explain why rather than guessing.',
    messages: [
      {
        role: "user",
        content: `Available tools:\n${toolList}\n\nQuestion: "${question}"`,
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            tool: { type: "string", enum: [...toolNames, "none"] },
            reasoning: { type: "string", description: "1-3 sentence explanation of the choice, inspectable by the caller." },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["tool", "reasoning", "confidence"],
          additionalProperties: false,
        },
      },
    },
  });

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("LLM returned no text content for tool selection");
  }
  return JSON.parse(block.text) as ToolSelection;
}
