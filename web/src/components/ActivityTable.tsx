import { TOOL_LABELS, type ActivityRecord } from "@/lib/activity";

const DECISION_COLOR: Record<ActivityRecord["decision"], string> = {
  accepted: "#4ade80",
  countered: "#fbbf24",
  rejected: "#f87171",
};

export default function ActivityTable({ rows }: { rows: ActivityRecord[] }) {
  if (rows.length === 0) {
    return (
      <div className="w-full rounded-2xl border border-subtle bg-surface-gradient p-6 text-center text-sm text-ink-body">
        No negotiations yet — try the live demo below to create some.
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 overflow-x-auto rounded-2xl border border-subtle bg-surface-gradient shadow-glow">
      <table className="w-full min-w-[680px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-subtle text-xs uppercase tracking-wide text-ink-label">
            <th className="px-4 py-3 font-medium">Timestamp</th>
            <th className="px-4 py-3 font-medium">Tool</th>
            <th className="px-4 py-3 font-medium">Decision</th>
            <th className="px-4 py-3 font-medium">Agreed price</th>
            <th className="px-4 py-3 font-medium">Round</th>
            <th className="px-4 py-3 font-medium">Payer</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={`${row.negotiationId}-${row.round}-${i}`}
              className={i !== rows.length - 1 ? "border-b border-subtle" : undefined}
            >
              <td className="whitespace-nowrap px-4 py-3 text-xs text-ink-label">
                {new Date(row.createdAt).toLocaleString()}
              </td>
              <td className="min-w-0 max-w-[200px] truncate px-4 py-3 text-ink-heading">
                {TOOL_LABELS[row.tool] ?? row.tool}
              </td>
              <td className="px-4 py-3">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: DECISION_COLOR[row.decision] }}
                  />
                  <span className="capitalize text-ink-body">{row.decision}</span>
                </span>
              </td>
              <td className="whitespace-nowrap px-4 py-3 tabular-nums text-ink-heading">
                {row.agreedPrice !== null ? `$${row.agreedPrice}` : "—"}
              </td>
              <td className="whitespace-nowrap px-4 py-3 tabular-nums text-ink-body">{row.round}</td>
              <td className="whitespace-nowrap px-4 py-3">
                {row.payerAddress ? (
                  <a
                    href={`https://testnet.arcscan.app/address/${row.payerAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={row.payerAddress}
                    className="text-xs font-medium text-accent-light underline underline-offset-2 transition-colors hover:text-ink-heading"
                  >
                    Verify →
                  </a>
                ) : (
                  <span className="text-xs text-ink-label">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
