import Link from "next/link";
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

  const byScore = (a: { score: number | null }, b: { score: number | null }) => (b.score ?? -1) - (a.score ?? -1);
  const valid = scan.candidates.filter((c) => c.setupValid).sort(byScore);
  const watching = scan.candidates.filter((c) => !c.setupValid).sort(byScore);

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
          {valid.map((c, i) => {
            const z = c.zone as { bottom: number; top: number } | null;
            const isCall = c.direction === "call";
            const strong = (c.score ?? 0) >= 80;
            return (
              <Link
                key={c.id}
                href={`/setup/${c.id}`}
                className={`block bg-panel border rounded-2xl p-4 text-center space-y-1 ${strong ? "border-accent" : "border-accent/30"}`}
              >
                <div className="flex items-center justify-center gap-2">
                  {i === 0 && c.score != null && (
                    <span className="text-[10px] uppercase tracking-wide text-accent font-semibold">Top pick</span>
                  )}
                  <div className="text-lg font-bold tracking-tight">
                    {c.symbol} <span className="text-sm text-muted font-normal">{companyName(c.symbol)}</span>
                  </div>
                </div>
                <div className={`text-sm font-medium ${isCall ? "text-up" : "text-down"}`}>
                  {isCall ? `Bet ${c.symbol} bounces up` : `Bet ${c.symbol} gets pushed down`}
                </div>
                {c.score != null && (
                  <div className="text-xs num">
                    <span className={strong ? "text-accent font-medium" : "text-muted"}>
                      Confidence {c.score}/100
                    </span>
                    {c.playbook ? <span className="text-muted"> · {c.playbook}</span> : null}
                  </div>
                )}
                {z && (
                  <div className="text-xs text-muted num">
                    zone {z.bottom}–{z.top} · {Number(c.distanceToEdgePct).toFixed(2)}% from the edge · details →
                  </div>
                )}
              </Link>
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
                <Link key={c.id} href={`/setup/${c.id}`} className="flex justify-between text-xs num">
                  <span>
                    {c.symbol} <span className="text-muted">{c.direction}</span>
                    {c.score != null && <span className="text-muted"> · {c.score}/100</span>}
                  </span>
                  <span className="text-muted">
                    {z ? `${z.bottom}–${z.top}` : ""} · {Number(c.distanceToEdgePct).toFixed(1)}%
                  </span>
                </Link>
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
