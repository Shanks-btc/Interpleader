"use client";

import { useState } from "react";
import { payWithWallet } from "@/lib/walletPay";

const QUOTE_URL =
  process.env.NEXT_PUBLIC_QUOTE_API_URL ?? "http://localhost:3000/quote";
const API_ORIGIN = new URL(QUOTE_URL).origin;

const TOOLS = [
  { id: "get_btc_cycle_regime", label: "BTC Cycle Regime" },
  { id: "get_entry_risk", label: "Entry Risk" },
  { id: "get_lth_behavior", label: "LTH Behavior" },
  { id: "compare_to_2021_top", label: "Compare to 2021 Top" },
  { id: "get_nupl_sentiment", label: "NUPL Sentiment" },
];

const PRESETS = [
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
  const [tool, setTool] = useState(TOOLS[0].id);
  const [price, setPrice] = useState("0.006");
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

  async function appendLine(text: string) {
    setLines((prev) => [...prev, text]);
    await sleep(450);
  }

  function applyPreset(preset: (typeof PRESETS)[number]) {
    setTool(preset.tool);
    setPrice(preset.price);
  }

  async function runNegotiation(selectedTool: string, startPrice: number) {
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
    if (Number.isNaN(parsed) || parsed < 0 || pending) return;
    await runNegotiation(tool, parsed);
  }

  async function handlePay() {
    if (!payUrl) return;
    setPayState("paying");
    await appendLine("> Requesting wallet connection...");

    try {
      const fullPayUrl = payUrl.startsWith("http") ? payUrl : `${API_ORIGIN}${payUrl}`;
      await appendLine("> Building and signing payment authorization (EIP-712)...");
      const result = await payWithWallet(fullPayUrl);
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
                onChange={(e) => setTool(e.target.value)}
                className="w-full min-w-0 rounded-lg border border-subtle bg-canvas px-3 py-2 text-sm text-ink-heading"
              >
                {TOOLS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

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
              disabled={pending}
              className="mt-6 w-full rounded-xl bg-accent-gradient px-6 py-3 text-sm font-semibold text-ink-heading transition-opacity disabled:opacity-50"
            >
              {pending ? "Negotiating..." : "Propose price"}
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
