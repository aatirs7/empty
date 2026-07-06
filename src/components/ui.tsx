// Presentational helpers — no hooks, usable in server or client components.

export function PricedInTag({ value }: { value: string | null }) {
  const map: Record<string, string> = {
    underdone: "bg-up/15 text-up",
    overdone: "bg-amber-500/15 text-amber-400",
    priced_in: "bg-zinc-500/15 text-zinc-300",
    unclear: "bg-zinc-500/15 text-zinc-400",
  };
  const key = value ?? "unclear";
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${map[key] ?? map.unclear}`}>
      {key.replace("_", " ")}
    </span>
  );
}

export function Confidence({ value }: { value: string | number | null }) {
  const p = Math.max(0, Math.min(100, Math.round(Number(value ?? 0) * 100)));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 rounded-full bg-border overflow-hidden">
        <div className="h-full bg-foreground/70" style={{ width: `${p}%` }} />
      </div>
      <span className="text-xs text-muted num">{p}%</span>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "text-muted",
    approved: "text-amber-400",
    filled: "text-up",
    rejected: "text-muted",
    expired: "text-muted",
  };
  return <span className={`text-xs ${map[status] ?? "text-muted"}`}>{status}</span>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted text-center py-12">{children}</p>;
}

export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="text-xs text-muted num mt-1">{subtitle}</p>}
    </div>
  );
}
