export const ACTIVITY_API_URL = process.env.QUOTE_API_URL ?? "http://localhost:3000";

export const TOOL_LABELS: Record<string, string> = {
  get_btc_cycle_regime: "BTC Cycle Regime",
  get_entry_risk: "Entry Risk",
  get_lth_behavior: "LTH Behavior",
  compare_to_2021_top: "Compare to 2021 Top",
  get_nupl_sentiment: "NUPL Sentiment",
};

export interface ActivityRecord {
  quoteId: string | null;
  negotiationId: string;
  round: number;
  tool: string;
  decision: "accepted" | "countered" | "rejected";
  agreedPrice: number | null;
  createdAt: string;
  state: "OPEN" | "PROCESSING" | "FULFILLED" | null;
  payerAddress: string | null;
}

// Server-side fetch (runs on the Next.js server, not in the browser) so this
// isn't subject to the real backend's CORS policy the way a client-side
// fetch would be. cache: "no-store" keeps this live on every request rather
// than baking a snapshot in at build time.
export async function getActivity(limit = 100): Promise<ActivityRecord[]> {
  try {
    const res = await fetch(`${ACTIVITY_API_URL}/activity?limit=${limit}`, { cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()) as ActivityRecord[];
  } catch {
    return [];
  }
}

// Collapses raw /activity rows (one per round) down to one row per
// negotiation session - the latest round for that negotiationId - since
// /activity is already sorted newest-first, the first occurrence of a given
// negotiationId in the array is that session's most recent (final) state.
export function summarizeSessions(rows: ActivityRecord[]): ActivityRecord[] {
  const seen = new Set<string>();
  const sessions: ActivityRecord[] = [];
  for (const row of rows) {
    if (!seen.has(row.negotiationId)) {
      seen.add(row.negotiationId);
      sessions.push(row);
    }
  }
  return sessions;
}
