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

// Parse the expiry date out of an OCC option symbol, e.g. TSLA260724C00435000 -> 2026-07-24.
export function optionExpiryFromOcc(symbol: string): string | null {
  const m = symbol.match(/^[A-Z.]+(\d{2})(\d{2})(\d{2})[CP]\d{8}$/);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : null;
}

export interface OccInfo {
  underlying: string;
  expiry: string; // YYYY-MM-DD
  type: "call" | "put";
  strike: number;
}

export function parseOcc(symbol: string): OccInfo | null {
  const m = symbol.match(/^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  return {
    underlying: m[1],
    expiry: `20${m[2]}-${m[3]}-${m[4]}`,
    type: m[5] === "C" ? "call" : "put",
    strike: parseInt(m[6], 10) / 1000,
  };
}

const COMPANY: Record<string, string> = {
  AAPL: "Apple",
  NVDA: "Nvidia",
  TSLA: "Tesla",
  MSFT: "Microsoft",
  AMD: "AMD",
  AMZN: "Amazon",
  GOOGL: "Google",
  META: "Meta",
  NFLX: "Netflix",
};
export function companyName(ticker: string): string {
  return COMPANY[ticker] ?? ticker;
}

export function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function daysUntil(iso: string): number {
  return Math.ceil((Date.parse(`${iso}T00:00:00Z`) - Date.now()) / 86_400_000);
}

export interface PositionRec {
  text: string;
  tone: "up" | "down" | "muted";
}

// Simple, code-computed rule-of-thumb — NOT financial advice. Combines how far
// the trade is up/down with how close it is to expiry.
export function positionRecommendation(symbol: string, unrealizedPlPc: number | null): PositionRec {
  const expiry = optionExpiryFromOcc(symbol);
  const days = expiry ? Math.ceil((Date.parse(`${expiry}T00:00:00Z`) - Date.now()) / 86_400_000) : Infinity;
  const plPct = (unrealizedPlPc ?? 0) * 100;

  if (days <= 1) return { text: "Expires today or tomorrow — close now, or it may expire worthless.", tone: "down" };
  if (days <= 3) return { text: "Only a few days left — decide soon; value drops fast near expiry.", tone: "down" };
  if (plPct >= 50) return { text: "Up nicely — closing now locks in the gain.", tone: "up" };
  if (plPct <= -50) return { text: "Down a lot — consider cutting the loss before it decays further.", tone: "down" };
  if (days <= 7) return { text: "Getting close to expiry — worth keeping an eye on.", tone: "muted" };
  return { text: "No strong signal — holding a while longer is reasonable.", tone: "muted" };
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
