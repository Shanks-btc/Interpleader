export interface ToolPricing {
  tool: string;
  costFloor: number;
  askPrice: number;
  requiredArgs: string[];
}

export interface PricingResponse {
  sellerAddress: string;
  network: string;
  tools: ToolPricing[];
}

const PRICING_API_URL = process.env.QUOTE_API_URL ?? "http://localhost:3000";

// Server-side fetch, same reasoning as getActivity() in lib/activity.ts -
// avoids the browser CORS issue entirely and stays live (no build-time cache).
export async function getPricing(): Promise<PricingResponse | null> {
  try {
    const res = await fetch(`${PRICING_API_URL}/pricing`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as PricingResponse;
  } catch {
    return null;
  }
}
