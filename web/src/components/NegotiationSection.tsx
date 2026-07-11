"use client";

import { useEffect, useState } from "react";
import { payWithWallet } from "@/lib/walletPay";
import { TOOL_LABELS } from "@/lib/activity";
import type { ToolPricing, PricingResponse } from "@/lib/pricing";

const QUOTE_URL =
  process.env.NEXT_PUBLIC_QUOTE_API_URL ?? "http://localhost:3000/quote";
const API_ORIGIN = new URL(QUOTE_URL).origin;
const PRICING_URL = `${API_ORIGIN}/pricing`;

// Used only if /pricing can't be reached on mount - keeps the form usable
// (the /quote calls it makes will surface their own error via the existing
// fetch-failure handling below) rather than rendering an empty dropdown.
const FALLBACK_TOOLS: ToolPricing[] = [
  { tool: "get_btc_cycle_regime", costFloor: 0.003, askPrice: 0.008, requiredArgs: [] },
  { tool: "get_entry_risk", costFloor: 0.0015, askPrice: 0.004, requiredArgs: [] },
  { tool: "get_lth_behavior", costFloor: 0.0015, askPrice: 0.004, requiredArgs: [] },
  { tool: "compare_to_2021_top", costFloor: 0.002, askPrice: 0.005, requiredArgs: [] },
  { tool: "get_nupl_sentiment", costFloor: 0.0015, askPrice: 0.004, requiredArgs: [] },
];

// "ticker1" -> "Ticker 1", "ticker" -> "Ticker" - generic enough for any
// future requiredArgs name without a per-arg label table.
function argLabel(key: string): string {
  if (key === "tickers") return "Tickers (comma-separated, 2-5)";
  const spaced = key.replace(/(\d+)$/, " $1");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// screen_analyst_momentum's "tickers" is the one array-type required arg
// among all 10 tools today (everything else is a single ticker string) -
// stored in argValues as one raw comma-separated string like the other
// text inputs, split into a real array only when building the /quote
// payload. isArgFilled mirrors this for client-side validation so the
// submit button doesn't enable on e.g. a single ticker with no comma.
function splitTickers(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function isArgFilled(key: string, raw: string): boolean {
  if (key === "tickers") return splitTickers(raw).length >= 2;
  return !!raw.trim();
}

function buildArgsPayload(rawArgs: Record<string, string>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawArgs)) {
    payload[key] = key === "tickers" ? splitTickers(value) : value;
  }
  return payload;
}

const PRESETS: Array<{ label: string; tool: string; price: string; args?: Record<string, string> }> = [
  {
    label: "Accept at proposed — BTC Cycle Regime @ $0.006",
    tool: "get_btc_cycle_regime",
    price: "0.006",
  },
  {
    label: "Counter then accept — Entry Risk @ $0.001",
    tool: "get_entry_risk",
    price: "0.001",
  },
  {
    label: "Accept at ask — NUPL Sentiment @ $0.004",
    tool: "get_nupl_sentiment",
    price: "0.004",
  },
  {
    label: "Accept at ask — Squeeze Risk (GME) @ $0.008",
    tool: "get_squeeze_risk",
    price: "0.008",
    args: { ticker: "GME" },
  },
  {
    label: "Accept at ask — Analyst Momentum (PLTR) @ $0.07",
    tool: "get_analyst_momentum",
    price: "0.07",
    args: { ticker: "PLTR" },
  },
];

type QuoteResponse = {
  decision: "accept" | "counter" | "reject";
  reason: string;
  agreedPrice?: number;
  negotiationId?: string;
  round?: number;
  quoteId?: string;
  payUrl?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_ROUNDS = 5;

export default function NegotiationSection() {
  const [tools, setTools] = useState<ToolPricing[]>(FALLBACK_TOOLS);
  const [tool, setTool] = useState(FALLBACK_TOOLS[0].tool);
  const [price, setPrice] = useState("0.006");
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<string[]>([
    "$ valiquo — waiting for a proposal...",
  ]);
  const [pending, setPending] = useState(false);
  const [payState, setPayState] = useState<"idle" | "ready" | "paying" | "settled" | "error">(
    "idle"
  );
  const [agreedPrice, setAgreedPrice] = useState<number | null>(null);
  const [payUrl, setPayUrl] = useState<string | null>(null);
  const [payerAddress, setPayerAddress] = useState<string | null>(null);

  // Live from the backend so newly-added tools (and their requiredArgs)
  // show up automatically - falls back to the hardcoded BTC-only list if
  // the backend is unreachable, so the form stays usable either way.
  useEffect(() => {
    let cancelled = false;
    fetch(PRICING_URL)
      .then((res) => (res.ok ? (res.json() as Promise<PricingResponse>) : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (!cancelled && data.tools.length > 0) setTools(data.tools);
      })
      .catch(() => {
        // Keep FALLBACK_TOOLS - /quote's own fetch-failure handling below
        // already surfaces "backend unreachable" to the user if they submit.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedTool = tools.find((t) => t.tool === tool);
  const requiredArgs = selectedTool?.requiredArgs ?? [];
  const missingArgs = requiredArgs.filter((key) => !isArgFilled(key, argValues[key] ?? ""));

  async function appendLine(text: string) {
    setLines((prev) => [...prev, text]);
    await sleep(450);
  }

  function applyPreset(preset: (typeof PRESETS)[number]) {
    setTool(preset.tool);
    setPrice(preset.price);
    setArgValues(preset.args ?? {});
  }

  async function runNegotiation(selectedTool: string, startPrice: number, args: Record<string, unknown>) {
    setPending(true);
    setPayState("idle");
    setAgreedPrice(null);
    setPayUrl(null);
    setPayerAddress(null);
    setLines([`$ valiquo quote ${selectedTool} --price ${startPrice}`]);

    let currentPrice = startPrice;
    let negotiationId: string | undefined;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      await appendLine(
        round === 1
          ? `> Proposing $${currentPrice}...`
          : `> Re-proposing at $${currentPrice}...`
      );

      let json: QuoteResponse;
      try {
        const res = await fetch(QUOTE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tool: selectedTool,
            proposedPrice: currentPrice,
            negotiationId,
            args,
          }),
        });
        json = await res.json();
      } catch {
        await appendLine(
          "> Error: could not reach Valiquo API at localhost:3000 (is the server running?)"
        );
        setPending(false);
        return;
      }

      negotiationId = json.negotiationId;

      if (json.decision === "reject") {
        await appendLine(`> Rejected — ${json.reason}`);
        setPending(false);
        return;
      }

      if (json.decision === "counter" && typeof json.agreedPrice === "number") {
        await appendLine(
          `> Seller countered at $${json.agreedPrice} — '${json.reason}'`
        );
        currentPrice = json.agreedPrice;
        continue;
      }

      if (json.decision === "accept" && typeof json.agreedPrice === "number") {
        await appendLine(`> Accepted at $${json.agreedPrice} — ${json.reason}`);
        setAgreedPrice(json.agreedPrice);
        setPayUrl(json.payUrl ?? null);
        setPayState("ready");
        setPending(false);
        return;
      }

      await appendLine("> Unexpected response from server.");
      setPending(false);
      return;
    }

    await appendLine(`> Max negotiation rounds (${MAX_ROUNDS}) exceeded.`);
    setPending(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Number(price);
    if (Number.isNaN(parsed) || parsed < 0 || pending || missingArgs.length > 0) return;
    await runNegotiation(tool, parsed, buildArgsPayload(argValues));
  }

  async function handlePay() {
    if (!payUrl) return;
    setPayState("paying");
    await appendLine("> Requesting wallet connection...");

    try {
      const fullPayUrl = payUrl.startsWith("http") ? payUrl : `${API_ORIGIN}${payUrl}`;
      const result = await payWithWallet(fullPayUrl, appendLine);
      await appendLine("> Payment verified and settled on Arc Testnet.");
      if (result.payerAddress) {
        setPayerAddress(result.payerAddress);
        await appendLine(`> Payer: ${result.payerAddress}`);
      }
      await appendLine(`> Data: ${JSON.stringify(result.data)}`);
      setPayState("settled");
    } catch (err: any) {
      await appendLine(`> Payment failed — ${err?.message ?? "unknown error"}`);
      setPayState("error");
    }
  }

  return (
    <section
      id="try-it"
      className="relative w-full overflow-hidden border-t border-subtle bg-[#5b3fd6] px-4 py-12 sm:px-6 sm:py-14 lg:px-8 lg:py-16"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 max-w-full rounded-full bg-white/10 blur-[100px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-24 -right-24 h-72 w-72 max-w-full rounded-full bg-black/10 blur-[100px]"
      />

      <div className="relative mx-auto w-full max-w-5xl">
        <div className="mx-auto max-w-2xl text-center">
          <span className="text-xs font-medium uppercase tracking-wide text-white/70">
            Live demo
          </span>
          <h2 className="mt-4 w-full text-balance break-words font-display text-3xl font-bold text-white sm:text-4xl">
            Try a negotiation yourself.
          </h2>
          <p className="mt-4 w-full text-balance break-words text-sm leading-relaxed text-white/80 sm:text-base">
            Pick a data tool, propose a price, and watch the seller accept,
            counter, or reject it in real time.
          </p>
        </div>

        <div className="mx-auto mt-12 grid w-full grid-cols-1 gap-6 lg:mt-16 lg:grid-cols-2 lg:gap-8">
          <form
            onSubmit={handleSubmit}
            className="w-full min-w-0 rounded-2xl border border-subtle bg-surface-gradient p-6 shadow-glow sm:p-8"
          >
            <div className="flex flex-col gap-2">
              <label
                htmlFor="tool"
                className="text-xs font-medium uppercase tracking-wide text-ink-label"
              >
                Tool
              </label>
              <select
                id="tool"
                value={tool}
                onChange={(e) => {
                  setTool(e.target.value);
                  setArgValues({});
                }}
                className="w-full min-w-0 rounded-lg border border-subtle bg-canvas px-3 py-2 text-sm text-ink-heading"
              >
                {tools.map((t) => (
                  <option key={t.tool} value={t.tool}>
                    {TOOL_LABELS[t.tool] ?? t.tool}
                  </option>
                ))}
              </select>
            </div>

            {requiredArgs.length > 0 && (
              <div className="mt-4 flex flex-col gap-2">
                {requiredArgs.map((key) => (
                  <div key={key} className="flex flex-col gap-2">
                    <label
                      htmlFor={`arg-${key}`}
                      className="text-xs font-medium uppercase tracking-wide text-ink-label"
                    >
                      {argLabel(key)}
                    </label>
                    <input
                      id={`arg-${key}`}
                      type="text"
                      placeholder={
                        key === "tickers"
                          ? "e.g. PLTR, NVDA, AMD, TSLA"
                          : key.startsWith("ticker")
                          ? "e.g. GME"
                          : undefined
                      }
                      value={argValues[key] ?? ""}
                      onChange={(e) =>
                        setArgValues((prev) => ({ ...prev, [key]: e.target.value.toUpperCase() }))
                      }
                      className="w-full min-w-0 rounded-lg border border-subtle bg-canvas px-3 py-2 text-sm text-ink-heading"
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 flex flex-col gap-2">
              <label
                htmlFor="price"
                className="text-xs font-medium uppercase tracking-wide text-ink-label"
              >
                Proposed price (USDC)
              </label>
              <input
                id="price"
                type="number"
                min="0"
                step="0.0001"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-full min-w-0 rounded-lg border border-subtle bg-canvas px-3 py-2 text-sm text-ink-heading"
              />
            </div>

            <button
              type="submit"
              disabled={pending || missingArgs.length > 0}
              className="mt-6 w-full rounded-xl bg-accent-gradient px-6 py-3 text-sm font-semibold text-ink-heading transition-opacity disabled:opacity-50"
            >
              {pending
                ? "Negotiating..."
                : missingArgs.length > 0
                ? `Enter ${missingArgs.map(argLabel).join(", ")}`
                : "Propose price"}
            </button>

            <div className="mt-6 min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-label">
                Or try a preset
              </p>
              <div className="mt-3 flex w-full flex-col gap-2">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className="w-full min-w-0 break-words rounded-lg border border-subtle px-3 py-2 text-left text-xs text-ink-body transition-colors hover:border-strong"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </form>

          <div className="flex w-full min-w-0 flex-col gap-4">
            <div className="w-full max-w-full overflow-hidden rounded-2xl border border-subtle bg-surface-gradient shadow-glow">
              <div className="flex items-center gap-2 border-b border-subtle px-4 py-3">
                <span className="h-3 w-3 shrink-0 rounded-full bg-[#ff5f56]" />
                <span className="h-3 w-3 shrink-0 rounded-full bg-[#ffbd2e]" />
                <span className="h-3 w-3 shrink-0 rounded-full bg-[#27c93f]" />
                <span className="ml-2 min-w-0 truncate text-xs text-ink-label">
                  valiquo — negotiation
                </span>
              </div>
              <div className="h-72 w-full max-w-full overflow-y-auto overflow-x-hidden px-4 py-4 sm:h-80">
                <pre className="w-full max-w-full whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-body sm:text-xs">
                  {lines.join("\n")}
                  {pending ? <span className="animate-pulse">▍</span> : null}
                </pre>

                {payState === "settled" && payerAddress && (
                  <a
                    href={`https://testnet.arcscan.app/address/${payerAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex w-full min-w-0 items-center gap-1.5 truncate rounded-lg border border-success/40 bg-success/10 px-3 py-2 font-mono text-[11px] font-semibold text-success underline underline-offset-2 transition-colors hover:border-success sm:text-xs"
                  >
                    {"> View on Arc Explorer →"}
                  </a>
                )}
              </div>
            </div>

            {payState !== "idle" && agreedPrice !== null && (
              <button
                type="button"
                onClick={handlePay}
                disabled={payState === "paying" || payState === "settled"}
                className="w-full rounded-xl bg-success px-6 py-3 text-sm font-semibold text-[#05060a] transition-opacity disabled:opacity-60"
              >
                {payState === "ready" && `Pay $${agreedPrice} with wallet`}
                {payState === "paying" && "Confirm in wallet..."}
                {payState === "settled" && "Settled ✓"}
                {payState === "error" && "Retry payment"}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
