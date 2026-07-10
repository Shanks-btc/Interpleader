// Real MetaMask (or compatible) browser wallet payment, matching the exact
// EIP-712 signing pattern used by @circle-fin/x402-batching's own
// BatchEvmScheme.signAuthorization (verified against the installed
// package's compiled source at node_modules/@circle-fin/x402-batching/dist/
// client/index.js - not guessed):
//   domain:    { name: "GatewayWalletBatched", version: "1", chainId, verifyingContract }
//   types:     { TransferWithAuthorization: [from, to, value, validAfter, validBefore, nonce] }
//   message:   { from: buyer, to: payTo, value: amount, validAfter, validBefore, nonce }
// The signed payload is sent back as a base64 JSON `Payment-Signature`
// request header, matching the server package's own decode logic at
// node_modules/@circle-fin/x402-batching/dist/server/index.js.
//
// Before signing, this also checks the buyer's Gateway *available* balance
// (a separate pool from their plain wallet USDC balance - funds only count
// for payment once deposited into the GatewayWallet contract) and, if it's
// short, deposits automatically. GatewayClient.deposit() in the SDK requires
// a raw private key (node_modules/@circle-fin/x402-batching/dist/client/
// index.js) and can't be used in a browser with an injected wallet, so the
// same approve+deposit contract calls it makes are replicated here via viem
// against window.ethereum, using the exact GATEWAY_WALLET_ABI from that
// same compiled source - not a hand-guessed ABI.

import {
  createPublicClient,
  createWalletClient,
  custom,
  parseUnits,
  formatUnits,
  erc20Abi,
  type Address,
} from "viem";

const GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS = 7 * 24 * 60 * 60 + 100; // matches SDK constant

// Real Arc Testnet values - same ones already used in src/settlementLog.ts,
// scripts/test-settlement-log.mjs, and docs/architecture.md. Not invented
// for this fix.
const ARC_TESTNET_CHAIN_ID = 5042002;
const ARC_TESTNET_CHAIN_ID_HEX = "0x4cef52"; // 5042002 in hex, per EIP-3085
const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.network/";
const ARC_TESTNET_EXPLORER_URL = "https://testnet.arcscan.app";

// Deposit at least this much (in whole USDC) when topping up Gateway balance,
// so a buyer doesn't have to re-deposit before every single small payment.
const MIN_DEPOSIT_USDC = "1";

const GATEWAY_WALLET_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "availableBalance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string; verifyingContract?: string };
}

interface PaymentRequired {
  x402Version: number;
  resource?: { url: string; description: string; mimeType: string };
  accepts: PaymentRequirements[];
}

export interface WalletPayResult {
  message: string;
  tool: string;
  agreedPrice: number;
  data: unknown;
  negotiationId: string;
  round: number;
  payerAddress: string | null;
}

function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

function base64Encode(json: unknown): string {
  return btoa(JSON.stringify(json));
}

function base64Decode<T>(value: string): T {
  return JSON.parse(atob(value)) as T;
}

// Diagnosed root cause of the "returned no data (0x)" contract errors: the
// public/wallet clients below are built on `custom(eth)` - MetaMask's
// injected provider - with no chain enforcement, so every read/write
// silently goes to whatever network MetaMask currently has active. If
// that isn't Arc Testnet, the Gateway contract address has no code there
// and viem's read comes back empty - independent of the contract, ABI, or
// RPC being fine (all separately verified working). This must run before
// any contract interaction, not just before signing.
async function ensureArcTestnet(eth: any, onProgress?: (message: string) => void | Promise<void>): Promise<void> {
  const currentChainIdHex: string = await eth.request({ method: "eth_chainId" });
  if (parseInt(currentChainIdHex, 16) === ARC_TESTNET_CHAIN_ID) {
    return;
  }

  await onProgress?.("> Wallet is on the wrong network - requesting switch to Arc Testnet...");

  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ARC_TESTNET_CHAIN_ID_HEX }],
    });
  } catch (switchError: any) {
    // 4902: chain not yet added to the wallet - the standard EIP-3085
    // signal to fall back to wallet_addEthereumChain instead of failing.
    if (switchError?.code === 4902) {
      await onProgress?.("> Arc Testnet not found in wallet - adding it now...");
      try {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: ARC_TESTNET_CHAIN_ID_HEX,
              chainName: "Arc Testnet",
              nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
              rpcUrls: [ARC_TESTNET_RPC_URL],
              blockExplorerUrls: [ARC_TESTNET_EXPLORER_URL],
            },
          ],
        });
      } catch (addError: any) {
        if (addError?.code === 4001) {
          throw new Error("Adding Arc Testnet was declined in wallet - Arc Testnet is required to pay.");
        }
        throw new Error(addError?.shortMessage ?? addError?.message ?? "Could not add Arc Testnet to your wallet.");
      }
    } else if (switchError?.code === 4001) {
      throw new Error("Network switch declined in wallet - Arc Testnet is required to pay.");
    } else {
      throw new Error(switchError?.shortMessage ?? switchError?.message ?? "Could not switch your wallet to Arc Testnet.");
    }
  }

  // Some wallets resolve the switch/add request without the active network
  // actually having changed yet (or the resolved request was stale) -
  // confirm the chain really changed rather than trusting the request
  // resolved without error.
  const confirmedChainIdHex: string = await eth.request({ method: "eth_chainId" });
  if (parseInt(confirmedChainIdHex, 16) !== ARC_TESTNET_CHAIN_ID) {
    throw new Error("Wallet is still not on Arc Testnet - please switch networks manually and try again.");
  }

  await onProgress?.("> Switched to Arc Testnet.");
}

export async function payWithWallet(
  payUrl: string,
  onProgress?: (message: string) => void | Promise<void>
): Promise<WalletPayResult> {
  const eth = (window as any).ethereum;
  if (!eth) {
    throw new Error("Install MetaMask (or a compatible wallet) to pay.");
  }

  const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
  const buyer = accounts[0];
  if (!buyer) {
    throw new Error("No wallet account available.");
  }

  // Must happen before any contract read/write below (availableBalance,
  // allowance, deposit, etc.) - see ensureArcTestnet's comment for why.
  await ensureArcTestnet(eth, onProgress);

  // Step 1: unpaid GET to discover payment requirements (real 402 response).
  const discoveryRes = await fetch(payUrl, { method: "GET" });
  if (discoveryRes.status !== 402) {
    // Already paid, expired, or some other real state - surface it honestly.
    const body = await discoveryRes.json().catch(() => ({}));
    throw new Error(body?.error ?? `Unexpected response (${discoveryRes.status}) from ${payUrl}`);
  }
  const requiredHeader = discoveryRes.headers.get("PAYMENT-REQUIRED");
  if (!requiredHeader) {
    throw new Error("Server did not return payment requirements (missing PAYMENT-REQUIRED header).");
  }
  const paymentRequired = base64Decode<PaymentRequired>(requiredHeader);
  const requirements = paymentRequired.accepts[0];
  if (!requirements) {
    throw new Error("No payment options offered by the server.");
  }
  const verifyingContract = requirements.extra?.verifyingContract;
  if (!verifyingContract) {
    throw new Error("Payment requirements missing extra.verifyingContract (GatewayWallet address).");
  }
  if (!requirements.network.startsWith("eip155:")) {
    throw new Error(`Unsupported network format "${requirements.network}".`);
  }
  const chainId = parseInt(requirements.network.split(":")[1], 10);

  // Step 1b: check Gateway *available* balance (a separate pool from the
  // buyer's plain wallet USDC balance - only funds deposited into the
  // GatewayWallet contract count toward a payment) and auto-deposit if
  // short, instead of requiring the buyer to have run a manual deposit
  // script beforehand.
  const usdcAddress = requirements.asset as Address;
  const gatewayWallet = verifyingContract as Address;
  const requiredAmount = BigInt(requirements.amount);

  const publicClient = createPublicClient({ transport: custom(eth) });
  const walletClient = createWalletClient({ account: buyer as Address, transport: custom(eth) });

  const availableBalance = await publicClient.readContract({
    address: gatewayWallet,
    abi: GATEWAY_WALLET_ABI,
    functionName: "availableBalance",
    args: [usdcAddress, buyer as Address],
  });

  if (availableBalance < requiredAmount) {
    const walletUsdcBalance = await publicClient.readContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [buyer as Address],
    });

    if (walletUsdcBalance < requiredAmount) {
      throw new Error(
        `Insufficient testnet USDC. Your wallet holds $${formatUnits(walletUsdcBalance, 6)} but this payment needs $${formatUnits(requiredAmount, 6)}. Get free testnet USDC at https://faucet.circle.com, then try again.`
      );
    }

    const roundedMinimum = parseUnits(MIN_DEPOSIT_USDC, 6);
    const desiredDeposit = requiredAmount > roundedMinimum ? requiredAmount : roundedMinimum;
    const depositAmount = walletUsdcBalance < desiredDeposit ? walletUsdcBalance : desiredDeposit;

    await onProgress?.(
      `> Gateway balance insufficient — depositing $${formatUnits(depositAmount, 6)} first...`
    );

    try {
      const allowance = await publicClient.readContract({
        address: usdcAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [buyer as Address, gatewayWallet],
      });

      if (allowance < depositAmount) {
        const approveHash = await walletClient.writeContract({
          chain: null,
          address: usdcAddress,
          abi: erc20Abi,
          functionName: "approve",
          args: [gatewayWallet, depositAmount],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      const depositHash = await walletClient.writeContract({
        chain: null,
        address: gatewayWallet,
        abi: GATEWAY_WALLET_ABI,
        functionName: "deposit",
        args: [usdcAddress, depositAmount],
      });
      await publicClient.waitForTransactionReceipt({ hash: depositHash });
    } catch (err: any) {
      if (err?.code === 4001 || err?.cause?.code === 4001) {
        throw new Error("Deposit transaction rejected in wallet.");
      }
      throw new Error(err?.shortMessage ?? err?.message ?? "Gateway deposit failed.");
    }

    await onProgress?.("> Deposit confirmed. Proceeding with payment...");
  }

  // Step 2: build + sign the EIP-3009 TransferWithAuthorization exactly like
  // BatchEvmScheme.signAuthorization does.
  await onProgress?.("> Building and signing payment authorization (EIP-712)...");
  const now = Math.floor(Date.now() / 1000);
  const validityWindowSeconds = Math.max(requirements.maxTimeoutSeconds, GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS);
  const authorization = {
    from: buyer,
    to: requirements.payTo,
    value: requirements.amount,
    validAfter: (now - 600).toString(),
    validBefore: (now + validityWindowSeconds).toString(),
    nonce: randomNonce(),
  };

  const typedData = {
    domain: {
      name: "GatewayWalletBatched",
      version: "1",
      chainId,
      verifyingContract,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  };

  let signature: string;
  try {
    signature = await eth.request({
      method: "eth_signTypedData_v4",
      params: [buyer, JSON.stringify(typedData)],
    });
  } catch (err: any) {
    if (err?.code === 4001) {
      throw new Error("Signature request rejected in wallet.");
    }
    throw new Error(err?.message ?? "Wallet signing failed.");
  }

  // Step 3: submit the signed payload as the Payment-Signature header.
  // Circle's real Gateway API (not just this backend) requires `resource`
  // at the top level too - discovered by testing against the real backend
  // with a syntactically-valid-but-fake signature, which surfaced
  // `"paymentPayload.resource: Required"` from the actual verify call.
  const paymentPayload = {
    x402Version: paymentRequired.x402Version,
    resource: paymentRequired.resource,
    accepted: requirements,
    payload: { signature, authorization },
  };

  const payRes = await fetch(payUrl, {
    method: "GET",
    headers: { "Payment-Signature": base64Encode(paymentPayload) },
  });

  if (!payRes.ok) {
    const body = await payRes.json().catch(() => ({}));
    throw new Error(body?.error ?? body?.detail ?? `Payment failed (${payRes.status}).`);
  }

  const result = (await payRes.json()) as WalletPayResult;
  return result;
}
