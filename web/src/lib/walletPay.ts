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

const GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS = 7 * 24 * 60 * 60 + 100; // matches SDK constant

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

export async function payWithWallet(payUrl: string): Promise<WalletPayResult> {
  const eth = (window as any).ethereum;
  if (!eth) {
    throw new Error("Install MetaMask (or a compatible wallet) to pay.");
  }

  const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
  const buyer = accounts[0];
  if (!buyer) {
    throw new Error("No wallet account available.");
  }

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

  // Step 2: build + sign the EIP-3009 TransferWithAuthorization exactly like
  // BatchEvmScheme.signAuthorization does.
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
