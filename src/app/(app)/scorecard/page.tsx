import { computeScorecard, type Bucket } from "@/lib/scorecard";
import { PageTitle } from "@/components/ui";
import { usd } from "@/lib/format";

export const dynamic = "force-dynamic";

function pct(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
}

function BucketRow({ b }: { b: Bucket }) {
  const tone = b.avgReturnPct > 0 ? "text-up" : b.avgReturnPct < 0 ? "text-down" : "text-muted";
  return (
    <div className="flex items-center justify-between text-sm py-1.5 border-b border-border last:border-0">
      <span className="capitalize">{b.label.replace(/_/g, " ")}</span>
      <span className="flex items-center gap-3 num text-xs">
        <span className="text-muted">n{b.n}</span>
        <span className="text-muted">{Math.round(b.winRate * 100)}%</span>
        <span className={`${tone} w-14 text-right`}>{pct(b.avgReturnPct)}</span>
      </span>
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="bg-panel border border-border rounded-2xl p-4">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="text-[11px] text-muted mb-1">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

export default async function ScorecardPage() {
  const s = await computeScorecard();
  const netTone = s.netAfterCost >= 0 ? "text-up" : "text-down";

  return (
    <div className="space-y-4">
      <PageTitle title="Scorecard" subtitle="paper-month go / no-go" />

      {s.overall.n === 0 ? (
        <p className="text-sm text-muted text-center py-8">
          No closed shadow trades yet. Metrics appear as shadow outcomes accumulate through the month.
        </p>
      ) : (
        <>
          <div className="bg-panel border border-accent/30 rounded-2xl p-5 text-center">
            <p className="text-xs text-muted">Net after API cost</p>
            <p className={`text-3xl font-bold num mt-1 ${netTone}`}>{usd(s.netAfterCost)}</p>
            <p className="text-xs text-muted mt-1 num">
              {usd(s.overall.netPnl)} shadows − ${s.apiCost.toFixed(2)} API
            </p>
            <p className="text-sm mt-2">
              Beats dumb baseline:{" "}
              <span className={s.beatsBaseline ? "text-up" : "text-down"}>
                {s.beatsBaseline == null ? "n/a" : s.beatsBaseline ? "YES" : "NO"}
              </span>
            </p>
          </div>

          <Card title="Overall" hint={`${s.overall.n} closed · win ${Math.round(s.overall.winRate * 100)}%`}>
            <div className="flex justify-between text-sm">
              <span className="text-muted">avg winner</span>
              <span className="num text-up">{pct(s.overall.avgWinnerPct)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">avg loser</span>
              <span className="num text-down">{pct(s.overall.avgLoserPct)}</span>
            </div>
          </Card>

          <Card title="Priced-in read" hint="does 'underdone' beat 'priced in'?">
            {s.pricedIn.map((b) => (
              <BucketRow key={b.label} b={b} />
            ))}
          </Card>

          <Card title="Confidence calibration" hint="higher confidence should win more">
            {s.confidence.map((b) => (
              <BucketRow key={b.label} b={b} />
            ))}
          </Card>

          <Card title="By strategy variant">
            {s.variants.map((b) => (
              <BucketRow key={b.label} b={b} />
            ))}
          </Card>

          <Card title="Baseline (SPY ATM call)">
            <BucketRow b={s.baseline} />
          </Card>
        </>
      )}

      <p className="text-[11px] text-muted text-center">
        {s.counts.totalProposals} proposals ({s.counts.realTrades} real, {s.counts.noTrades} no-trade) ·{" "}
        {s.counts.openShadows} shadows still open. Shadows enter at the ask, exit at the bid on +50% / −40% / expiry.
        Not financial advice.
      </p>
    </div>
  );
}
