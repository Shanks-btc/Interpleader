import type { Metadata } from "next";
import Nav from "@/components/Nav";
import ProofSection from "@/components/ProofSection";
import StatCard from "@/components/StatCard";
import DecisionsChart from "@/components/DecisionsChart";
import ActivityTable from "@/components/ActivityTable";
import NegotiationSection from "@/components/NegotiationSection";
import ToolBreakdown from "@/components/ToolBreakdown";
import AnimatedNumber from "@/components/AnimatedNumber";
import PricingTable from "@/components/PricingTable";
import SavingsCallout from "@/components/SavingsCallout";
import SettlementFooter from "@/components/SettlementFooter";
import { getActivity, summarizeSessions, TOOL_LABELS } from "@/lib/activity";
import { getPricing } from "@/lib/pricing";
import { getRevenue } from "@/lib/revenue";

export const metadata: Metadata = {
  title: "Dashboard — Valiquo",
  description: "Live negotiation activity from the real Valiquo backend — metadata only, never the paid intelligence data itself.",
};

export default async function DashboardPage() {
  const rows = await getActivity(100);
  const sessions = summarizeSessions(rows);
  const pricing = await getPricing();
  const revenue = await getRevenue();

  const total = sessions.length;
  const acceptedSessions = sessions.filter((s) => s.decision === "accepted");
  const counteredSessions = sessions.filter((s) => s.decision === "countered");
  const rejectedSessions = sessions.filter((s) => s.decision === "rejected");
  const acceptanceRate = total > 0 ? Math.round((acceptedSessions.length / total) * 100) : 0;

  const toolCounts = new Map<string, number>();
  for (const s of sessions) {
    toolCounts.set(s.tool, (toolCounts.get(s.tool) ?? 0) + 1);
  }
  let mostQueriedTool: string | null = null;
  let mostQueriedCount = 0;
  for (const [tool, count] of toolCounts) {
    if (count > mostQueriedCount) {
      mostQueriedTool = tool;
      mostQueriedCount = count;
    }
  }

  const acceptedPrices = acceptedSessions
    .map((s) => s.agreedPrice)
    .filter((p): p is number => p !== null);
  const avgPrice =
    acceptedPrices.length > 0
      ? acceptedPrices.reduce((a, b) => a + b, 0) / acceptedPrices.length
      : null;

  // Average savings vs. real list (ask) price, computed only from deals
  // where both a real accepted agreedPrice and that tool's real askPrice
  // (from /pricing) are known.
  const askPriceByTool = new Map(pricing?.tools.map((t) => [t.tool, t.askPrice]) ?? []);
  const savingsPercents = acceptedSessions
    .map((s) => {
      const ask = askPriceByTool.get(s.tool);
      if (ask === undefined || ask <= 0 || s.agreedPrice === null) return null;
      return ((ask - s.agreedPrice) / ask) * 100;
    })
    .filter((p): p is number => p !== null);
  const avgSavingsPct =
    savingsPercents.length > 0
      ? Math.round(savingsPercents.reduce((a, b) => a + b, 0) / savingsPercents.length)
      : null;

  const perToolStats = Object.entries(TOOL_LABELS).map(([tool, label]) => {
    const toolSessions = sessions.filter((s) => s.tool === tool);
    const count = toolSessions.length;
    const acceptedCount = toolSessions.filter((s) => s.decision === "accepted").length;
    const acceptanceRate = count > 0 ? Math.round((acceptedCount / count) * 100) : null;
    return { tool, label, count, acceptanceRate };
  });

  const recentRows = rows.slice(0, 20);

  return (
    <>
      <Nav />
      <main className="w-full max-w-full">
        <section className="relative w-full overflow-hidden px-4 py-12 sm:px-6 sm:py-14 lg:px-8 lg:py-16">
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center text-center">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-label">
              Live activity
            </span>
            <h1 className="mt-4 w-full text-balance break-words font-display text-3xl font-bold text-ink-heading sm:text-4xl">
              Every negotiation, straight from the backend.
            </h1>
            <p className="mt-4 w-full max-w-xl text-balance break-words text-sm leading-relaxed text-ink-body sm:text-base">
              Every negotiation Valiquo settles is logged here — this is metadata about
              how prices got agreed, never the paid intelligence data itself.
            </p>
          </div>

          <div className="mx-auto mt-10 grid w-full max-w-6xl grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total negotiations" value={<AnimatedNumber target={total} />} />
            <StatCard
              label="Acceptance rate"
              value={<AnimatedNumber target={acceptanceRate} suffix="%" />}
              sublabel={total > 0 ? `${acceptedSessions.length} of ${total} accepted` : "no data yet"}
            />
            <StatCard
              label="Most-queried tool"
              value={mostQueriedTool ? TOOL_LABELS[mostQueriedTool] ?? mostQueriedTool : "—"}
              sublabel={
                mostQueriedTool
                  ? `${mostQueriedCount} negotiation${mostQueriedCount === 1 ? "" : "s"}`
                  : undefined
              }
            />
            <StatCard
              label="Average agreed price"
              value={
                avgPrice !== null ? (
                  <AnimatedNumber target={avgPrice} prefix="$" decimals={4} />
                ) : (
                  "—"
                )
              }
              sublabel={
                avgPrice !== null
                  ? `across ${acceptedPrices.length} accepted deal${acceptedPrices.length === 1 ? "" : "s"}`
                  : "no accepted deals yet"
              }
            />
          </div>

          <SavingsCallout avgSavingsPct={avgSavingsPct} dealCount={savingsPercents.length} />

          <p className="mx-auto mt-6 w-full max-w-xl text-balance break-words text-center text-xs text-ink-label">
            {rows.length !== total
              ? `${total} negotiation session${total === 1 ? "" : "s"} from ${rows.length} quote request${rows.length === 1 ? "" : "s"} — one session can span multiple rounds before it settles.`
              : `${total} negotiation session${total === 1 ? "" : "s"}, one quote request each so far.`}
          </p>
        </section>

        <ProofSection />

        <section className="relative w-full overflow-hidden border-t border-subtle px-4 py-12 sm:px-6 sm:py-14 lg:px-8 lg:py-16">
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center text-center">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-label">
              Seller revenue
            </span>
            <h2 className="mt-4 w-full text-balance break-words font-display text-2xl font-bold text-ink-heading sm:text-3xl">
              Real settled USDC, straight from Circle Gateway.
            </h2>
            <p className="mt-3 w-full max-w-xl text-balance break-words text-sm leading-relaxed text-ink-body sm:text-base">
              Not a database total — this is the seller&apos;s live Circle Gateway balance,
              independently verifiable on-chain.
            </p>
          </div>
          <div className="mx-auto mt-10 grid w-full max-w-sm grid-cols-1">
            <StatCard
              label="Seller Revenue (Gateway Balance)"
              value={
                revenue ? (
                  <AnimatedNumber target={Number(revenue.gatewayTotal)} prefix="$" decimals={6} />
                ) : (
                  "—"
                )
              }
              sublabel={
                revenue
                  ? `$${Number(revenue.gatewayAvailable).toFixed(6)} available to withdraw`
                  : "backend unreachable"
              }
            />
          </div>
        </section>

        <section className="relative w-full overflow-hidden border-t border-subtle px-4 py-12 sm:px-6 sm:py-14 lg:px-8 lg:py-16">
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center text-center">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-label">
              Decisions breakdown
            </span>
            <h2 className="mt-4 w-full text-balance break-words font-display text-2xl font-bold text-ink-heading sm:text-3xl">
              How negotiations actually resolve.
            </h2>
          </div>
          <div className="mx-auto mt-10 w-full max-w-2xl">
            <DecisionsChart
              counts={{
                accepted: acceptedSessions.length,
                countered: counteredSessions.length,
                rejected: rejectedSessions.length,
              }}
            />
          </div>
        </section>

        <section className="relative w-full overflow-hidden border-t border-subtle px-4 py-12 sm:px-6 sm:py-14 lg:px-8 lg:py-16">
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center text-center">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-label">
              Per-tool breakdown
            </span>
            <h2 className="mt-4 w-full text-balance break-words font-display text-2xl font-bold text-ink-heading sm:text-3xl">
              Every tool, queried or not.
            </h2>
          </div>
          <div className="mx-auto mt-10 w-full max-w-2xl">
            <ToolBreakdown stats={perToolStats} />
          </div>
        </section>

        <section className="relative w-full overflow-hidden border-t border-subtle px-4 py-12 sm:px-6 sm:py-14 lg:px-8 lg:py-16">
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center text-center">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-label">
              Pricing transparency
            </span>
            <h2 className="mt-4 w-full text-balance break-words font-display text-2xl font-bold text-ink-heading sm:text-3xl">
              The real floor and ask, per tool.
            </h2>
            <p className="mt-3 w-full max-w-xl text-balance break-words text-sm leading-relaxed text-ink-body sm:text-base">
              Straight from the backend&apos;s own pricing config — the same numbers
              /quote negotiates against.
            </p>
          </div>
          <div className="mx-auto mt-10 w-full max-w-3xl">
            <PricingTable tools={pricing?.tools ?? []} />
          </div>
        </section>

        <section className="relative w-full overflow-hidden border-t border-subtle px-4 py-12 sm:px-6 sm:py-14 lg:px-8 lg:py-16">
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center text-center">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-label">
              Recent activity
            </span>
            <h2 className="mt-4 w-full text-balance break-words font-display text-2xl font-bold text-ink-heading sm:text-3xl">
              Last {recentRows.length} negotiation event{recentRows.length === 1 ? "" : "s"}.
            </h2>
          </div>
          <div className="mx-auto mt-10 w-full max-w-5xl">
            <ActivityTable rows={recentRows} />
          </div>
        </section>

        <NegotiationSection />
      </main>
      <SettlementFooter sellerAddress={pricing?.sellerAddress ?? null} network={pricing?.network ?? null} />
    </>
  );
}
