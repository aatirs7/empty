import { getLatestScan } from "@/lib/queries";
import { PageTitle, Empty } from "@/components/ui";
import { companyName } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SetupsPage() {
  const scan = await getLatestScan();
  if (!scan) {
    return (
      <div className="space-y-5">
        <PageTitle title="Setups" />
        <Empty>No scan has run yet. The scanner runs after each market close.</Empty>
      </div>
    );
  }

  const valid = scan.candidates.filter((c) => c.setupValid);
  const watching = scan.candidates.filter((c) => !c.setupValid);

  return (
    <div className="space-y-5">
      <PageTitle title="Setups" subtitle={`scan ${scan.runDate}`} />

      <p className="text-center text-sm text-muted leading-relaxed">
        The latest scan checked <span className="text-foreground font-medium">{scan.candidates.length}</span> approaching
        stocks and found{" "}
        <span className="text-foreground font-medium">
          {valid.length} {valid.length === 1 ? "ready setup" : "ready setups"}
        </span>{" "}
        to trade at the next open.
      </p>

      {valid.length === 0 ? (
        <Empty>No ready setups from the latest scan. That&apos;s normal on quiet days.</Empty>
      ) : (
        <div className="space-y-3">
          {valid.map((c) => {
            const z = c.zone as { bottom: number; top: number } | null;
            const isCall = c.direction === "call";
            return (
              <div key={c.id} className="bg-panel border border-accent/30 rounded-2xl p-4 text-center space-y-1">
                <div className="text-lg font-bold tracking-tight">
                  {c.symbol} <span className="text-sm text-muted font-normal">{companyName(c.symbol)}</span>
                </div>
                <div className={`text-sm font-medium ${isCall ? "text-up" : "text-down"}`}>
                  {isCall ? `Bet ${c.symbol} bounces up` : `Bet ${c.symbol} gets pushed down`}
                </div>
                {z && (
                  <div className="text-xs text-muted num">
                    zone {z.bottom}–{z.top} · {Number(c.distanceToEdgePct).toFixed(2)}% from the edge
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {watching.length > 0 && (
        <details className="bg-panel border border-border rounded-2xl p-4">
          <summary className="text-sm text-muted cursor-pointer list-none select-none">
            {watching.length} more approaching (not tapped yet) ▾
          </summary>
          <div className="mt-3 space-y-1.5">
            {watching.slice(0, 50).map((c) => {
              const z = c.zone as { bottom: number; top: number } | null;
              return (
                <div key={c.id} className="flex justify-between text-xs num">
                  <span>
                    {c.symbol} <span className="text-muted">{c.direction}</span>
                  </span>
                  <span className="text-muted">
                    {z ? `${z.bottom}–${z.top}` : ""} · {Number(c.distanceToEdgePct).toFixed(1)}%
                  </span>
                </div>
              );
            })}
          </div>
        </details>
      )}

      <p className="text-[11px] text-muted text-center leading-relaxed">
        The scanner runs after each close and finds zone taps for the next session. Ready setups are what Vega may
        auto-buy at the open, up to your buying power. Distance is how far price is from the zone edge.
      </p>
    </div>
  );
}
