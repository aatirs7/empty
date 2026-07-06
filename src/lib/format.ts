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
