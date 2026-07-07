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
      <PageTitle title="Scorecard" subtitle="paper-month go / no-go (shadow-only)" />

      {s.strategy.n === 0 ? (
        <p className="text-sm text-muted text-center py-8">
          No closed zone-setup shadows yet. Metrics appear as shadow outcomes accumulate through the month.
        </p>
      ) : (
        <>
          <div className="bg-panel border border-accent/30 rounded-2xl p-5 text-center">
            <p className="text-xs text-muted">Net after API cost</p>
            <p className={`text-3xl font-bold num mt-1 ${netTone}`}>{usd(s.netAfterCost)}</p>
            <p className="text-xs text-muted mt-1 num">
              {usd(s.strategy.netPnl)} strategy − ${s.apiCost.toFixed(2)} API
            </p>
            <p className="text-sm mt-2">
              Beats dumb baseline:{" "}
              <span className={s.beatsBaseline ? "text-up" : "text-down"}>
                {s.beatsBaseline == null ? "n/a" : s.beatsBaseline ? "YES" : "NO"}
              </span>
            </p>
          </div>

          <Card title="Strategy" hint={`${s.strategy.n} closed zone setups · win ${Math.round(s.strategy.winRate * 100)}%`}>
            <div className="flex justify-between text-sm">
              <span className="text-muted">avg winner</span>
              <span className="num text-up">{pct(s.strategy.avgWinnerPct)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">avg loser</span>
              <span className="num text-down">{pct(s.strategy.avgLoserPct)}</span>
            </div>
          </Card>

          <Card title="By variant">
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
        Shadow-only measurement: every valid zone setup is shadowed mechanically (enter at the ask, exit at the bid on
        +50% / −40% / expiry) and compared to a daily SPY baseline. This never reads the auto-bought or Brain-researched
        trades. {s.counts.setupsShadowed} setups shadowed, {s.counts.openShadows} still open. Not financial advice.
      </p>
    </div>
  );
}
