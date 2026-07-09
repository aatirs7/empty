import { getUnderlyingPrice, getStockBars, getIntradayBars } from "@/lib/alpaca";
import { buildZoneSetup } from "@/lib/strategy";
import { predict } from "@/lib/predict";
import { selectByEV, type EvContract } from "@/lib/ev";
import { getProfile, contractForTimeframe } from "@/lib/profiles";
import { ALPACA_TF, SCAN_LOOKBACK_MIN } from "@/lib/timeframes";

// Live QQQ prediction: predict the underlying first (from the reaction DB, per
// timeframe), then show the expected-value contracts. All numbers carry a sample
// size; nothing is model-generated.
export default async function QqqPrediction() {
  const profile = getProfile("qqq_0dte");
  const spot = await getUnderlyingPrice("QQQ").catch(() => null);
  if (spot == null) {
    return <p className="text-xs text-muted text-center">QQQ quote unavailable right now.</p>;
  }

  const rows: { tf: string; dir: "call" | "put"; distance: number; pred: Awaited<ReturnType<typeof predict>> }[] = [];
  for (const ztf of profile.zoneTimeframes) {
    try {
      const bars =
        ztf.timeframe === "daily"
          ? await getStockBars("QQQ", 4000)
          : await getIntradayBars("QQQ", ALPACA_TF[ztf.timeframe], SCAN_LOOKBACK_MIN[ztf.timeframe]);
      const setup = buildZoneSetup(bars, { ...profile.strategy, zone: ztf.opts });
      if (!setup.direction || !setup.active_zone) continue;
      const pred = await predict("QQQ", spot, ztf.timeframe, setup.direction, setup.approach ?? "", 0);
      rows.push({ tf: ztf.timeframe, dir: setup.direction, distance: setup.distance_to_edge_pct ?? 999, pred });
    } catch {
      /* skip this timeframe */
    }
  }
  if (rows.length === 0) return <p className="text-xs text-muted text-center">No QQQ zone in play right now.</p>;

  const primary = [...rows].sort((a, b) => a.distance - b.distance)[0];
  let ev: { primary: EvContract | null; aggressive: EvContract | null; conservative: EvContract | null } | null = null;
  try {
    ev = await selectByEV("QQQ", primary.dir, spot, primary.pred, contractForTimeframe(profile, primary.tf));
  } catch {
    ev = null;
  }

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
            <p className="text-sm font-medium capitalize">
              {r.tf} · {r.pred.bias.replace(/_/g, " ")}
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
          <p className="text-sm font-medium mb-1">Best-value 0DTE contracts</p>
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
