import { getRunsLog, getCostTotals } from "@/lib/queries";
import { usd, labelStrategy } from "@/lib/format";
import { Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function LogPage() {
  const [runs, cost] = await Promise.all([getRunsLog(30), getCostTotals()]);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Log</h1>
        <span className="text-xs text-muted num">MTD cost {usd(cost.monthToDate)}</span>
      </div>

      {runs.length === 0 ? (
        <Empty>No runs yet.</Empty>
      ) : (
        <div className="space-y-2">
          {runs.map(({ run, proposals, orders }) => (
            <details key={run.id} className="bg-panel border border-border rounded-xl px-3 py-2.5">
              <summary className="flex items-center justify-between cursor-pointer list-none">
                <span className="text-sm num">
                  Run #{run.id} · {run.runDate}{" "}
                  <span className={run.status === "complete" ? "text-muted" : "text-down"}>({run.status})</span>
                </span>
                <span className="text-xs text-muted num">{usd(Number(run.costEstimate), 4)}</span>
              </summary>
              <div className="mt-3 space-y-2">
                {run.marketContext && <p className="text-xs text-muted">{run.marketContext}</p>}
                {proposals.map((p) => (
                  <div key={p.id} className="flex justify-between text-xs">
                    <span>
                      {p.symbol} · {p.strategy === "no_trade" ? "no trade" : labelStrategy(p.strategy)}
                    </span>
                    <span className="text-muted">{p.status}</span>
                  </div>
                ))}
                {orders.length > 0 && (
                  <div className="pt-1 border-t border-border space-y-1">
                    {orders.map((o) => (
                      <div key={o.id} className="text-[11px] text-muted num">
                        order {o.contractSymbol} · {o.status} · {o.executionMode} · max loss {usd(Number(o.maxLoss), 0)}
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-[11px] text-muted num">
                  {run.searchCount ?? 0} searches · {run.inputTokens ?? 0} in / {run.outputTokens ?? 0} out
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
