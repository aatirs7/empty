import Link from "next/link";
import { getLatestRun } from "@/lib/queries";
import ProposalActions from "@/components/ProposalActions";
import PullToRefresh from "@/components/PullToRefresh";
import { StatusPill, Empty, PageTitle } from "@/components/ui";
import { plainVerdict, confidenceLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const data = await getLatestRun();
  if (!data) return <Empty>No research yet. Vega runs each weekday, early in the morning.</Empty>;
  const { run, proposals } = data;
  const trades = proposals.filter((p) => p.strategy !== "no_trade");

  return (
    <div className="space-y-5">
      <PullToRefresh />
      <PageTitle title="Today" subtitle={run.runDate} />

      <p className="text-center text-sm text-muted leading-relaxed">
        Vega looked at {proposals.length} {proposals.length === 1 ? "stock" : "stocks"} this morning and found{" "}
        <span className="text-foreground font-medium">
          {trades.length === 0 ? "no clear opportunities" : `${trades.length} possible ${trades.length === 1 ? "trade" : "trades"}`}
        </span>
        .{trades.length === 0 && " That's normal — most days there's no edge, and sitting out is a fine choice."}
      </p>

      {run.marketContext && (
        <details className="bg-panel border border-border rounded-2xl p-4 text-center">
          <summary className="text-xs text-muted cursor-pointer list-none select-none">Today&apos;s market mood ▾</summary>
          <p className="text-sm text-muted mt-2 leading-relaxed">{run.marketContext}</p>
        </details>
      )}

      <div className="space-y-3">
        {proposals.map((p) => {
          const isTrade = p.strategy !== "no_trade";
          const verdict = plainVerdict(p.strategy, p.symbol);
          const toneClass = verdict.tone === "up" ? "text-up" : verdict.tone === "down" ? "text-down" : "text-muted";
          const plain = p.plainExplanation || p.rationale;
          return (
            <div key={p.id} className="bg-panel border border-border rounded-2xl p-5 text-center space-y-3">
              <div>
                <div className="text-xl font-bold tracking-tight">{p.symbol}</div>
                <div className={`text-sm font-medium ${toneClass}`}>{verdict.title}</div>
              </div>

              {plain && <p className="text-sm text-muted leading-relaxed">{plain}</p>}

              {isTrade && (p.strikeHint || p.expiryHint) && (
                <p className="text-xs text-muted num">
                  {p.strikeHint} · {p.expiryHint}
                </p>
              )}

              <div className="text-xs text-muted">
                {confidenceLabel(p.confidence)} · <span className="num">{Math.round(Number(p.confidence) * 100)}%</span> sure
              </div>

              {isTrade && p.status === "pending" ? (
                <div className="pt-1 space-y-2">
                  <ProposalActions id={p.id} />
                  <Link href={`/proposal/${p.id}`} className="block text-xs text-accent">
                    See what you could make or lose →
                  </Link>
                </div>
              ) : isTrade ? (
                <div className="flex items-center justify-center gap-3">
                  <StatusPill status={p.status} />
                  <Link href={`/proposal/${p.id}`} className="text-xs text-accent">
                    Details →
                  </Link>
                </div>
              ) : (
                <Link href={`/proposal/${p.id}`} className="text-xs text-accent">
                  Why sit out? →
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
