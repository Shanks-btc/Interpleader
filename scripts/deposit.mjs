import { GatewayClient } from "@circle-fin/x402-batching/client";

const pk = process.env.BUYER_PRIVATE_KEY;
const client = new GatewayClient({ chain: "arcTestnet", privateKey: pk });

console.log("Depositing 2 USDC into Gateway...");
const result = await client.deposit("2");
console.log(JSON.stringify(result, (key, value) => typeof value === "bigint" ? value.toString() : value, 2));
