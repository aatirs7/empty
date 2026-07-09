import { getUnderlyingPrice } from "@/lib/alpaca";
import { predict } from "@/lib/predict";
import { selectByEV, type EvContract } from "@/lib/ev";
import { getProfile, contractForTimeframe } from "@/lib/profiles";
import { getLatestScan } from "@/lib/queries";

// Live QQQ prediction. Reads the zones the scanner ALREADY computed (fast DB
// read) rather than re-fetching months of intraday bars on every page load — the
// prior version did 3 paginated bar pulls + zone builds and took ~28s, which
// timed out on Vercel. Predictions + one EV lookup are quick. All numbers come
// from the reaction DB with a sample size; nothing is model-generated.
export default async function QqqPrediction() {
  const profile = getProfile("qqq_0dte");
  const [spot, scan] = await Promise.all([
    getUnderlyingPrice("QQQ").catch(() => null),
    getLatestScan("qqq_0dte"),
  ]);
  if (spot == null) {
    return <p className="text-xs text-muted text-center">QQQ quote unavailable right now.</p>;
  }

  // One candidate per timeframe (nearest to its edge), with a real direction+zone.
  const cands = (scan?.candidates ?? []).filter((c) => (c.direction === "call" || c.direction === "put") && c.zone);
  const byTf = new Map<string, (typeof cands)[number]>();
  for (const c of cands) {
    const prev = byTf.get(c.timeframe);
    if (!prev || Number(c.distanceToEdgePct) < Number(prev.distanceToEdgePct)) byTf.set(c.timeframe, c);
  }
  // Keep the profile's timeframe order (15min, 1h, 4h).
  const ordered = profile.zoneTimeframes.map((z) => byTf.get(z.timeframe)).filter((c): c is (typeof cands)[number] => !!c);

  const rows = await Promise.all(
    ordered.map(async (c) => ({
      tf: c.timeframe,
      dir: c.direction as "call" | "put",
      distance: Number(c.distanceToEdgePct),
      pred: await predict("QQQ", spot, c.timeframe, c.direction as "call" | "put", c.approach ?? "", 0),
    })),
  );
  if (rows.length === 0) return <p className="text-xs text-muted text-center">No QQQ zone in play right now.</p>;

  const primary = [...rows].sort((a, b) => a.distance - b.distance)[0];
  let ev: { primary: EvContract | null; aggressive: EvContract | null; conservative: EvContract | null } | null = null;
  try {
    ev = await selectByEV("QQQ", primary.dir, spot, primary.pred, contractForTimeframe(profile, primary.tf));
  } catch {
    ev = null;
  }

  const roleOf = (tf: string) => (tf === "4h" ? "next-day swing" : "same-day 0DTE");

  const contract = (label: string, c: EvContract | null) =>
    c && (
      <div className="flex items-center justify-between text-xs num py-1 border-b border-border last:border-0">
        <span className="text-muted">{label}</span>
        <span>
          ${c.strike} @ ${c.ask} · Δ{c.delta} · EV {Math.round(c.evPct * 100)}%
        </span>
      </div>
    );

  return (
    <div className="space-y-3">
      <div className="bg-panel border border-accent/30 rounded-2xl p-4 text-center">
        <p className="text-xs text-muted">QQQ now</p>
        <p className="text-2xl font-bold num">{spot}</p>
      </div>

      {rows.map((r) => (
        <div key={r.tf} className="bg-panel border border-border rounded-2xl p-4 space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              <span className="capitalize">{r.tf}</span> · {r.pred.bias.replace(/_/g, " ")}
              <span className="text-[10px] text-muted"> · {roleOf(r.tf)}</span>
            </p>
            <span className={`text-xs num ${r.pred.lowConfidence ? "text-muted" : "text-accent"}`}>
              {r.pred.probability}% · n={r.pred.sampleSize}
            </span>
          </div>
          <p className="text-xs text-muted num">
            Expected +{r.pred.expectedMovePct}% ({r.pred.expectedMovePts} pts) in {r.pred.expectedHoldLabel}
          </p>
          <p className="text-[11px] text-muted num">
            Safe {r.pred.targetSafe ?? "—"} · Main {r.pred.targetMain ?? "—"} · Stretch {r.pred.targetStretch ?? "—"}
            {r.pred.lowConfidence ? " · LOW SAMPLE" : ""}
          </p>
        </div>
      ))}

      {ev && (ev.primary || ev.aggressive || ev.conservative) && (
        <div className="bg-panel border border-border rounded-2xl p-4">
          <p className="text-sm font-medium mb-1">Best-value contracts ({roleOf(primary.tf)})</p>
          {contract("Primary", ev.primary)}
          {contract("Aggressive", ev.aggressive)}
          {contract("Conservative", ev.conservative)}
        </div>
      )}

      <p className="text-[11px] text-muted text-center leading-relaxed">
        Predicts QQQ from {rows.length} timeframe(s) of historical reactions, then picks the highest expected-value
        contract. Every number is from the reaction database with its sample size — none are model-generated.
      </p>
    </div>
  );
}
