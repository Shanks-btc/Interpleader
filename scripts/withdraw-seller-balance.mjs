import { GatewayClient } from "@circle-fin/x402-batching/client";

const sellerPrivateKey = process.env.SELLER_PRIVATE_KEY;
const sellerAddress = process.env.SELLER_ADDRESS ?? "0x1b777a0aE8d7f22d394A9BAB3f40d92664dcaAC1";

if (!sellerPrivateKey) {
  console.log(JSON.stringify({ ok: false, error: "SELLER_PRIVATE_KEY not set. This must be the seller's own private key, not the buyer's." }));
  process.exit(1);
}

try {
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: sellerPrivateKey });

  if (client.address.toLowerCase() !== sellerAddress.toLowerCase()) {
    console.log(JSON.stringify({
      ok: false,
      error: `Key mismatch: this private key controls ${client.address}, not the expected SELLER_ADDRESS ${sellerAddress}. Aborting to avoid withdrawing from/to the wrong account.`,
    }));
    process.exit(1);
  }

  const before = await client.getBalances();
  console.log(JSON.stringify({ step: "balance_before", gatewayAvailable: before.gateway.formattedAvailable }));

  const amount = before.gateway.formattedAvailable;
  if (Number(amount) <= 0) {
    console.log(JSON.stringify({ ok: false, error: "No available Gateway balance to withdraw." }));
    process.exit(1);
  }

  console.log(JSON.stringify({ step: "withdrawing", amount, chain: "arcTestnet", recipient: sellerAddress }));

  const result = await client.withdraw(amount, { chain: "arcTestnet", recipient: sellerAddress });

  console.log(JSON.stringify({
    ok: true,
    withdrawResult: result,
    explorerLink: `https://testnet.arcscan.app/address/${sellerAddress}`,
  }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
  process.exit(1);
}
