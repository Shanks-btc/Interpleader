/**
 * Minimal, standalone entrypoint that boots ONLY the A2MCP payment rail
 * (POST /a2mcp, via mountA2mcp() in okxA2mcp.ts) - no Postgres, no
 * SELLER_ADDRESS/DATABASE_URL, no Circle Gateway/Arc negotiated flow.
 *
 * src/server.ts remains the real, single production entrypoint once a
 * given environment also has the negotiated flow's dependencies
 * configured - this file exists for running/testing the OKX x402 rail in
 * isolation, on a Railway service that doesn't (yet, or ever) also run
 * the Circle Gateway side. mountA2mcp() is imported unchanged from
 * okxA2mcp.ts, so the A2MCP behavior here is identical to what
 * src/server.ts would mount - only the unrelated bootstrap (Postgres,
 * negotiated routes) is left out.
 */

import express from "express";
import cors from "cors";
import { mountA2mcp } from "./okxA2mcp.ts";

const app = express();
// Railway terminates TLS at its edge and forwards internally over plain
// HTTP - without this, req.protocol (and so the 402 payload's resource.url)
// reports "http" even though the public endpoint is genuinely HTTPS-only.
app.set("trust proxy", true);
app.use(express.json());
// Same CORS config as src/server.ts, same reason: PAYMENT-REQUIRED and
// PAYMENT-RESPONSE need to be readable by browser JS across origins.
app.use(cors({ exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));

app.get("/", (_req, res) => {
  res.json({ service: "Interpleader A2MCP (OKX x402 on X Layer only)", endpoints: ["POST /a2mcp"] });
});

// For an external uptime monitor (e.g. UptimeRobot) - deliberately cheap and
// unauthenticated, no facilitator/network calls, just confirms the process
// itself is up and serving requests.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "interpleader-a2mcp" });
});

mountA2mcp(app);

// Same reasoning as src/server.ts's catch-all: keeps error responses JSON
// rather than Express's default HTML error page.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled request error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`A2MCP-only server listening on http://localhost:${PORT}`);
});
