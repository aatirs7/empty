export function usd(n: number | string | null | undefined, dp = 2): string {
  if (n == null || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function pct(n: number | string | null | undefined): string {
  if (n == null) return "—";
  return `${Math.round(Number(n) * 100)}%`;
}

export function labelStrategy(s: string | null): string {
  if (s === "long_call") return "Long call";
  if (s === "long_put") return "Long put";
  return "No trade";
}

// Plain-English verdict for a layman (no options jargon).
export function plainVerdict(strategy: string | null, symbol: string): { title: string; tone: "up" | "down" | "muted" } {
  if (strategy === "long_call") return { title: `Bet that ${symbol} goes up`, tone: "up" };
  if (strategy === "long_put") return { title: `Bet that ${symbol} goes down`, tone: "down" };
  return { title: "Sit this one out", tone: "muted" };
}

export function confidenceLabel(conf: number | string | null): string {
  const c = Number(conf ?? 0);
  if (c < 0.34) return "Low confidence";
  if (c < 0.67) return "Medium confidence";
  return "High confidence";
}

export function plainPricedIn(v: string | null): string {
  switch (v) {
    case "underdone":
      return "the market under-reacted, so there may be room left to move";
    case "overdone":
      return "the market over-reacted";
    case "priced_in":
      return "the news is already baked into the price";
    default:
      return "unclear right now";
  }
}
