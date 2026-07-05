# Valiquo - Demo Script

Target: under 3 minutes, per Lepton Agents Hackathon submission requirements. Judges review asynchronously with no live Q&A - the video has to carry the entire argument on its own.

## The one sentence to lead with
"Every x402 payment today is take-it-or-leave-it. Valiquo is the negotiation layer Circle's own SDK does not have - and every sale is decided by real, inspectable logic, live."

Do not lead with "we pay creators" or "AI reads content" language - that is a different, more crowded category. This is an autonomous economic agent story (RFB 1 + RFB 2 + RFB 3), not a content-monetization story.

## Structure (aim ~3:00 total)

0:00-0:20 - The gap, stated plainly
Show the reference arc-nanopayments demo's fixed gateway.require("$0.01") line on screen for 3 seconds. "This is the baseline everyone gets. One price. Take it or leave it." Cut to Valiquo's /quote endpoint. "We built the negotiation Circle's SDK does not have."

0:20-1:10 - Real negotiation, live, both outcomes
- Lowball: propose a price below the floor on get_btc_cycle_regime -> show the live reject response with its actual reason string on screen.
- Fair offer: propose a price between floor and ask -> show the live accept response, at the PROPOSED price (proving it is a real discount, not a fixed table lookup).
- Say out loud: "Four branches, real thresholds, nothing scripted for this demo - you can lowball it yourself on the repo's live link."

1:10-2:00 - Real payment, real data, real proof
- Trigger the actual payment (MetaMask sign, or the buyer-agent script headlessly - whichever is ready by demo time).
- Show the real returned data on screen: live BTC regime, price, MVRV - emphasize "this is real market data, fetched and paid for in the same request, not a stub."
- Show the transaction/settlement evidence (Arc testnet explorer link or the logged tx hash) - this is the moment that proves it is not staged.

2:00-2:30 - Agent-to-agent proof (if buyer-agent is wired by demo time)
Run the buyer-agent script in a terminal, no human clicking. Show it negotiate, decide, pay - entirely autonomously. This is the single strongest piece of evidence for Agentic Sophistication and RFB 3 (agent-to-agent commerce). If not ready, cut this section rather than fake it - do not simulate agent autonomy that is not real.

2:30-2:50 - Traction (fill in once real usage exists)
Show the live product link, real distinct payers if any exist by submission time, repeat usage if any. Do not fabricate - self-transfers or one-off wallet-creation reads as fake and is explicitly disallowed by the brief.

2:50-3:00 - Close
"Live at [URL]. Repo at [URL]. Real negotiation, real payment, real data - on Arc, in testnet USDC, today."

## Non-negotiable honesty constraints for the video
- Do not claim Circle's stack supports negotiation - say explicitly it does not, and that is why this was built.
- Do not call the policy engine "AI negotiation" or imply an LLM is deciding - it is deterministic, and that is a stated strength (reproducible, inspectable), not a weakness to hide.
- Do not show Short Squeeze Intelligence unless it has been independently re-verified live by demo time (see handoff.md - its fix was not confirmed pushed/redeployed as of last handoff).
- Do not present two of your own tools as independent third-party sellers - if only BTC Cycle Intelligence is shown, say "seller" singular, not "marketplace."

## What "unforgettable moment" looks like
A single question asked live -> the seller countering a lowball with its exact reason -> the buyer accepting the counter -> payment firing -> real data returned with a receipt. That whole loop, uncut, is the strongest 30 seconds available - build the video around making that moment as clean and legible as possible rather than spreading attention across many smaller features.
