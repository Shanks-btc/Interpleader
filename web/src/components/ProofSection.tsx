import { TOOL_LABELS, SELLER_TOOLS, getActivity, type ActivityRecord } from "@/lib/activity";

// Prioritize a genuinely FULFILLED (paid + delivered) record; fall back to
// the most recent accepted-but-unpaid one. activity is already sorted
// newest-first, so .find() gives the most recent match in each case.
function pickLatestSettlement(activity: ActivityRecord[], tools: string[]): ActivityRecord | undefined {
  const scoped = activity.filter((a) => tools.includes(a.tool));
  const fulfilled = scoped.find((a) => a.state === "FULFILLED");
  const accepted = scoped.find((a) => a.decision === "accepted");
  return fulfilled ?? accepted;
}

function ProviderCard({ providerName, record }: { providerName: string; record?: ActivityRecord }) {
  if (!record) {
    return (
      <div className="w-full min-w-0 rounded-2xl border border-subtle bg-surface-gradient p-6 text-center text-sm text-ink-body">
        No settled {providerName} negotiations yet — try the live demo below to create one.
      </div>
    );
  }

  const isFulfilled = record.state === "FULFILLED";

  return (
    <div className="w-full min-w-0 rounded-2xl border border-[rgba(139,124,246,0.28)] bg-surface-gradient p-6 text-left shadow-glow">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/20 text-success">
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M4 10.5l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="min-w-0 truncate text-xs font-semibold tracking-wide text-ink-label">
          Deal Completed
        </span>
      </div>

      <h3 className="mt-4 min-w-0 truncate font-display text-lg font-bold text-ink-heading">
        {TOOL_LABELS[record.tool] ?? record.tool}
      </h3>
      <p className="mt-1 min-w-0 truncate text-xs text-ink-label">
        Provider: {providerName}
      </p>

      <p className="mt-4 min-w-0 break-words font-display text-3xl font-bold text-ink-heading">
        ${record.agreedPrice} <span className="text-base font-medium text-ink-body">USDC</span>
      </p>

      <div className="mt-6 flex min-w-0 items-center gap-2 border-t border-subtle pt-4">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping-slow rounded-full bg-success opacity-70" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
        </span>
        <span className="min-w-0 truncate text-xs font-bold uppercase tracking-wide text-success">
          {isFulfilled ? "Intelligence Delivered" : "Negotiation Settled"}
        </span>
      </div>

      <p className="mt-3 min-w-0 truncate text-[11px] text-ink-label">
        Negotiation {record.negotiationId.slice(0, 8)}… ·{" "}
        {new Date(record.createdAt).toLocaleString()}
      </p>
    </div>
  );
}

export default async function ProofSection() {
  // 100, matching the Dashboard's own window - a narrower fetch risked a
  // burst of one provider's traffic pushing the other's older (but still
  // real) settlements out of the window entirely, making its card fall
  // back to "no data yet" when real data actually exists further back.
  const activity = await getActivity(100);

  return (
    <section className="relative w-full overflow-hidden border-t border-subtle px-4 py-12 sm:px-6 sm:py-14 lg:px-8 lg:py-16">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center text-center">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-label">
          Proof, not promises
        </span>
        <h2 className="mt-4 w-full text-balance break-words font-display text-2xl font-bold text-ink-heading sm:text-3xl">
          Real negotiations, rendered from the live backend.
        </h2>
        <p className="mt-3 w-full max-w-xl text-balance break-words text-sm leading-relaxed text-ink-body sm:text-base">
          These cards are rendered from <code>GET /activity</code> on the running
          Valiquo server — not static demo data.
        </p>

        <div className="mt-10 grid w-full max-w-3xl min-w-0 grid-cols-1 gap-6 sm:grid-cols-2">
          {Object.entries(SELLER_TOOLS).map(([providerName, tools]) => (
            <ProviderCard
              key={providerName}
              providerName={providerName}
              record={pickLatestSettlement(activity, tools)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
