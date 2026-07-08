/**
 * Fire-and-forget append-only proof logging to ValiquoSettlementLog on Arc
 * Testnet. This contract never holds, custodies, or moves funds - real
 * payment settlement stays entirely on Circle's Gateway/USDC contracts.
 * logSettlementOnChain() must only ever be called AFTER a real payment has
 * already succeeded (see the /pay/:id hook in server.ts).
 */
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network/"] } },
} as const;

// Only the one function this module ever calls - no need to carry the
// contract's full ABI here.
const LOG_SETTLEMENT_ABI = [
  {
    type: "function",
    name: "logSettlement",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tool", type: "string" },
      { name: "agreedPriceMicroUsdc", type: "uint256" },
      { name: "negotiationId", type: "bytes16" },
      { name: "payerAddress", type: "address" },
    ],
    outputs: [{ name: "newSettlementCount", type: "uint256" }],
  },
] as const;

const loggerKey = process.env.SETTLEMENT_LOGGER_PRIVATE_KEY as `0x${string}` | undefined;
const contractAddress = process.env.SETTLEMENT_LOG_CONTRACT_ADDRESS as `0x${string}` | undefined;

const walletClient =
  loggerKey && contractAddress
    ? createWalletClient({ account: privateKeyToAccount(loggerKey), chain: arcTestnet, transport: http() })
    : undefined;

// v4 UUIDs are exactly 128 bits - this is a lossless, reversible encoding
// (dashes stripped), not a hash.
function uuidToBytes16(uuid: string): `0x${string}` {
  return `0x${uuid.replace(/-/g, "")}` as `0x${string}`;
}

export interface SettlementToLog {
  tool: string;
  agreedPrice: number;
  negotiationId: string;
  payerAddress?: string | null;
}

/**
 * Logs a single already-settled payment on-chain. Never throws to a caller
 * that doesn't handle it - callers in server.ts must .catch() this, since a
 * failure here must never affect the already-completed payment/data
 * delivery flow.
 */
export async function logSettlementOnChain(settlement: SettlementToLog): Promise<string> {
  if (!walletClient || !contractAddress) {
    throw new Error(
      "Settlement logging not configured (missing SETTLEMENT_LOGGER_PRIVATE_KEY or SETTLEMENT_LOG_CONTRACT_ADDRESS)."
    );
  }
  if (!settlement.payerAddress) {
    throw new Error("No payerAddress on settled quote - cannot log on-chain.");
  }

  const agreedPriceMicroUsdc = BigInt(Math.round(settlement.agreedPrice * 1_000_000));

  return walletClient.writeContract({
    address: contractAddress,
    abi: LOG_SETTLEMENT_ABI,
    functionName: "logSettlement",
    args: [settlement.tool, agreedPriceMicroUsdc, uuidToBytes16(settlement.negotiationId), settlement.payerAddress as `0x${string}`],
  });
}
