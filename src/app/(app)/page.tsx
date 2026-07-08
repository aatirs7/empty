import Link from "next/link";
import { getTodayMonitorTrades, getLatestScanRun, getLatestScan } from "@/lib/queries";
import ProposalActions from "@/components/ProposalActions";
import GoalProgress from "@/components/GoalProgress";
import { StatusPill, PageTitle } from "@/components/ui";
import { plainVerdict, confidenceLabel, stripDash, etDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const [proposals, scanRun, scan] = await Promise.all([getTodayMonitorTrades(), getLatestScanRun(), getLatestScan()]);
  const runDate = scanRun?.runDate ?? new Date().toISOString().slice(0, 10);
  const trades = proposals.filter((p) => p.strategy !== "no_trade");
  const topSetups = (scan?.candidates ?? [])
    .filter((c) => c.setupValid)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, 5);

  return (
    <div className="space-y-5">
      <PageTitle title="Today" subtitle={runDate} />

      <GoalProgress />

      <p className="text-center text-sm text-muted leading-relaxed">
        {scanRun?.marketContext
          ? stripDash(scanRun.marketContext)
          : "Vega scans the market each morning for zone setups."}
        {trades.length > 0 && (
          <>
            {" "}
            <span className="text-foreground font-medium">
              {trades.length} trade{trades.length === 1 ? "" : "s"} placed so far today.
            </span>
          </>
        )}
      </p>

      <Link href="/setups" className="block text-center text-xs text-accent">
        See the latest scan &amp; setups &rarr;
      </Link>

      <div className="space-y-3">
        {proposals.map((p) => {
          const isTrade = p.strategy !== "no_trade";
          const verdict = plainVerdict(p.strategy, p.symbol);
          const toneClass = verdict.tone === "up" ? "text-up" : verdict.tone === "down" ? "text-down" : "text-muted";
          const plain = stripDash(p.plainExplanation || p.rationale);
          return (
            <div key={p.id} className="bg-panel border border-accent/30 rounded-2xl p-5 text-center space-y-3">
              <div className="mx-auto h-1 w-10 rounded-full bg-accent/70" />
              <div>
                <div className="text-xl font-bold tracking-tight">{p.symbol}</div>
                <div className={`text-sm font-medium ${toneClass}`}>{verdict.title}</div>
              </div>

              {plain && <p className="text-sm text-muted leading-relaxed">{plain}</p>}

              {p.zoneRead && (
                <p className="text-xs text-accent/90 leading-relaxed">
                  <span className="uppercase tracking-wide text-[10px] text-muted">Zone</span> {stripDash(p.zoneRead)}
                </p>
              )}

              {isTrade && (p.strikeHint || p.expiryHint) && (
                <p className="text-xs text-muted num">
                  {p.strikeHint} · {p.expiryHint}
                </p>
              )}

              {p.variant === "news_plus_zones" ? (
                <div className="text-xs text-muted">
                  Setup score <span className="num">{Math.round(Number(p.confidence) * 100)}</span>/100
                  {p.createdAt && <span className="num"> · alerted {etDateTime(p.createdAt)}</span>}
                </div>
              ) : (
                <div className="text-xs text-muted">
                  {confidenceLabel(p.confidence)} · <span className="num">{Math.round(Number(p.confidence) * 100)}%</span> sure
                </div>
              )}

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

      {trades.length === 0 && topSetups.length > 0 && (
        <div className="space-y-2">
          <p className="text-center text-xs text-muted leading-relaxed">
            No trades placed yet today. Vega is watching these top setups live and will auto-buy the moment one taps its
            zone.
          </p>
          {topSetups.map((c) => {
            const isCall = c.direction === "call";
            return (
              <Link
                key={c.id}
                href={`/setup/${c.id}`}
                className="flex items-center justify-between bg-panel border border-border rounded-2xl px-4 py-3"
              >
                <span className="text-sm">
                  <span className="font-medium">{c.symbol}</span>{" "}
                  <span className={isCall ? "text-up" : "text-down"}>{isCall ? "bounce up" : "push down"}</span>
                </span>
                <span className="text-xs text-muted num">{c.score != null ? `${c.score}/100` : ""}</span>
              </Link>
            );
          })}
          <Link href="/setups" className="block text-center text-xs text-accent pt-1">
            See all setups →
          </Link>
        </div>
      )}
    </div>
  );
}
