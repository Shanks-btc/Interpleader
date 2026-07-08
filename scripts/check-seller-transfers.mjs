import { GatewayClient } from "@circle-fin/x402-batching/client";

const sellerAddress = process.env.SELLER_ADDRESS ?? "0x1b777a0aE8d7f22d394A9BAB3f40d92664dcaAC1";

try {
  const { generatePrivateKey } = await import("viem/accounts");
  const throwawayKey = generatePrivateKey();
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: throwawayKey });

  const transfers = await client.searchTransfers({ address: sellerAddress });

  console.log(JSON.stringify({
    ok: true,
    checkedAddress: sellerAddress,
    transferCount: transfers?.length ?? transfers?.data?.length ?? "unknown shape - see raw below",
    raw: transfers,
  }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
  process.exit(1);
}
