import { GatewayClient } from "@circle-fin/x402-batching/client";

const pk = process.env.BUYER_PRIVATE_KEY;
if (!pk) {
  console.log(JSON.stringify({ ok: false, error: "BUYER_PRIVATE_KEY not set in environment." }));
  process.exit(1);
}

try {
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: pk });
  const balances = await client.getBalances();
  console.log(JSON.stringify({
    ok: true,
    address: client.address,
    walletBalance: balances.wallet.formatted,
    gatewayAvailable: balances.gateway.formattedAvailable,
    gatewayTotal: balances.gateway.formattedTotal,
  }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
  process.exit(1);
}
