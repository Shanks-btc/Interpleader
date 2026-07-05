# Valiquo - Deployment

## Current deployment status
- BTC Cycle Intelligence: deployed and live on Railway (fork: Shanks-btc/BTC-Cycle-Intelligence). Auth-disabled fix is pushed and confirmed live via re-test.
- Short Squeeze Intelligence: fix made locally, NOT yet pushed/redeployed as of last handoff. Not in current build scope regardless (see plan.md).
- Valiquo itself: local only. No deployment target configured yet. This is required before public launch - a live link needs to work cold, with no prior setup from a visitor's side.

## Deploying the seller MCP tool (reference - already done once, repeat if redeploying)
1. Fork the tool's repo to your own GitHub account (already done for BTC Cycle Intelligence).
2. If disabling CTX auth: comment out (do not delete) the app.use(createContextMiddleware()) line in src/index.js, with a note explaining why.
3. Commit and push.
4. In Railway: New Project -> Deploy from GitHub repo -> select your fork. Railway auto-detects Node/Express, runs npm install then npm start.
5. Under the service's Settings -> Networking -> Public Networking (not Private/*.railway.internal, which is unreachable from outside Railway) -> Generate Domain, pointed at the port the app actually logs on startup (confirmed for these tools: 8080).
6. Verify live with a raw tools/list and at least one real tools/call - do not assume a successful deploy means the auth/response format is correct; both have been wrong before in this project's history (see handoff.md).

## Deploying Valiquo (not yet done - steps for when ready)
1. Valiquo is a plain Express/TypeScript app run via node --experimental-transform-types (no build step) - same deploy pattern as the MCP tools works here: Railway, New Project -> Deploy from GitHub -> auto-detect Node.
2. Before deploying publicly: replace the in-memory Map quote store with the Redis addon (see plan.md item 5) - a restart mid-negotiation currently loses all pending quotes, which is fine locally but not acceptable for a public live link.
3. Environment variables needed on the deployed service (do not commit these - set them in Railway's dashboard):
   - SELLER_ADDRESS - the wallet that receives payments.
   - PORT - Railway typically injects this automatically; confirm src/server.ts's process.env.PORT ?? 3000 picks it up correctly.
   - BTC_CYCLE_MCP_URL - optional override; defaults to the confirmed live URL already hardcoded as a fallback.
   - RPC - optional; only needed if switching from the public Arc Testnet RPC to the Canteen-hosted one.
4. Generate a public domain the same way as the MCP tools (Public Networking, correct port).
5. Re-run the full test suite (scripts/test-*.ps1, pointed at the new public URL instead of localhost:3000) before considering the deploy done. Do not assume a successful local test still holds after deployment - different network path, different environment.

## Deploying the web UI (once built - see plan.md item 4)
Standard Next.js deployment (Vercel is the simplest path, or Railway alongside the API). The UI calls Valiquo's /quote and /pay/:id over the network - it needs Valiquo's public URL (from the step above) as its API base, not localhost.

## Pre-launch checklist
- [ ] Public GitHub repo - confirm README.md is written and the repo is public, not just pushed.
- [ ] Recorded demo video - see demo-script.md.
- [ ] Live deployed link - Valiquo's public URL, working cold with no prior setup from a visitor's side.
- [ ] Usage numbers ready to report honestly - distinct real users, real payment count, any repeat usage. Do not inflate.
