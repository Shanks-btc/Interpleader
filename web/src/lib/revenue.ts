export interface RevenueResponse {
  sellerAddress: string;
  gatewayTotal: string;
  gatewayAvailable: string;
}

const REVENUE_API_URL = process.env.QUOTE_API_URL ?? "http://localhost:3000";

// Server-side fetch, same reasoning as getActivity()/getPricing() - avoids
// the browser CORS issue entirely and stays live (no build-time cache).
export async function getRevenue(): Promise<RevenueResponse | null> {
  try {
    const res = await fetch(`${REVENUE_API_URL}/revenue`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as RevenueResponse;
  } catch {
    return null;
  }
}
