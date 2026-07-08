import { createSwapKitContext, estimate, swap, getChainByEnum } from "@circle-fin/swap-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";

const sellerPrivateKey = process.env.SELLER_PRIVATE_KEY;
const stablecoinKitApiKey = process.env.STABLECOIN_KIT_API_KEY;
const sellerAddress = process.env.SELLER_ADDRESS ?? "0x1b777a0aE8d7f22d394A9BAB3f40d92664dcaAC1";

const args = process.argv.slice(2);
const amountFlagIndex = args.findIndex((a) => a === "--amount");
const amountIn = amountFlagIndex !== -1 ? args[amountFlagIndex + 1] : "0.01";
const execute = args.includes("--execute");

if (!sellerPrivateKey) {
  console.log(JSON.stringify({ ok: false, error: "SELLER_PRIVATE_KEY not set. This must be the seller's own private key, not the buyer's." }));
  process.exit(1);
}

if (!stablecoinKitApiKey) {
  console.log(JSON.stringify({ ok: false, error: "STABLECOIN_KIT_API_KEY not set. Required to authenticate against Circle's Stablecoin Service (config.kitKey)." }));
  process.exit(1);
}

try {
  const adapter = createViemAdapterFromPrivateKey({ privateKey: sellerPrivateKey });
  const chainDef = getChainByEnum("Arc_Testnet");
  const adapterAddress = await adapter.getAddress(chainDef);

  if (adapterAddress.toLowerCase() !== sellerAddress.toLowerCase()) {
    console.log(JSON.stringify({
      ok: false,
      error: `Key mismatch: this private key controls ${adapterAddress}, not the expected SELLER_ADDRESS ${sellerAddress}. Aborting to avoid swapping funds from the wrong account.`,
    }));
    process.exit(1);
  }

  const context = createSwapKitContext();

  const params = {
    from: { adapter, chain: "Arc_Testnet" },
    tokenIn: "USDC",
    tokenOut: "EURC",
    amountIn,
    config: {
      kitKey: stablecoinKitApiKey,
      slippageBps: 300,
    },
  };

  console.log(JSON.stringify({ step: "estimating", amountIn, tokenIn: "USDC", tokenOut: "EURC", chain: "Arc_Testnet" }));

  const quote = await estimate(context, params);
  console.log(JSON.stringify({
    step: "estimate_result",
    stopLimit: quote.stopLimit,
    estimatedOutput: quote.estimatedOutput,
    fees: quote.fees,
  }));

  if (!execute) {
    console.log(JSON.stringify({
      ok: true,
      executed: false,
      note: "Dry run only (estimate() call). Re-run with --execute to perform a real on-chain swap.",
    }));
    process.exit(0);
  }

  console.log(JSON.stringify({ step: "swapping", amountIn, tokenIn: "USDC", tokenOut: "EURC", chain: "Arc_Testnet" }));

  const result = await swap(context, params);

  console.log(JSON.stringify({
    ok: true,
    executed: true,
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
    amountIn: result.amountIn,
    tokenIn: result.tokenIn,
    tokenOut: result.tokenOut,
  }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
  process.exit(1);
}
