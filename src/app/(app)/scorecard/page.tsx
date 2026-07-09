import { computeScorecard, type ProfileScore } from "@/lib/scorecard";
import { PageTitle } from "@/components/ui";
import { usd } from "@/lib/format";

export const dynamic = "force-dynamic";

const pct = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

function ProfileCard({ p }: { p: ProfileScore }) {
  const s = p.strategy;
  const netTone = s.netPnl >= 0 ? "text-up" : "text-down";
  return (
    <div className="bg-panel border border-border rounded-2xl p-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{p.label}</p>
        {s.n > 0 && p.beatsBaseline != null && (
          <span className={`text-[11px] font-medium ${p.beatsBaseline ? "text-up" : "text-down"}`}>
            {p.beatsBaseline ? "beats baseline" : "trails baseline"}
          </span>
        )}
      </div>
      {s.n === 0 ? (
        <p className="text-xs text-muted">
          No closed setups yet{p.openShadows > 0 ? ` · ${p.openShadows} open` : ""}. Metrics build as shadows resolve.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">Net P&amp;L (1 contract)</span>
            <span className={`num font-semibold ${netTone}`}>{usd(s.netPnl)}</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs num pt-1">
            <div>
              <p className="text-muted">setups</p>
              <p>{s.n}</p>
            </div>
            <div>
              <p className="text-muted">win</p>
              <p>{Math.round(s.winRate * 100)}%</p>
            </div>
            <div>
              <p className="text-muted">avg</p>
              <p className={s.avgReturnPct >= 0 ? "text-up" : "text-down"}>{pct(s.avgReturnPct)}</p>
            </div>
          </div>
          <div className="flex justify-between text-[11px] text-muted num pt-1 border-t border-border">
            <span>avg winner <span className="text-up">{pct(s.avgWinnerPct)}</span></span>
            <span>avg loser <span className="text-down">{pct(s.avgLoserPct)}</span></span>
          </div>
          <div className="flex justify-between text-[11px] text-muted num">
            <span>baseline ({p.profileId === "qqq_0dte" ? "QQQ" : "SPY"})</span>
            <span>
              n{p.baseline.n} · {pct(p.baseline.avgReturnPct)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export default async function ScorecardPage() {
  const s = await computeScorecard();
  const anyData = s.profiles.some((p) => p.strategy.n > 0 || p.openShadows > 0);

  return (
    <div className="space-y-4">
      <PageTitle title="Scorecard" subtitle="per-strategy, shadow-only — never blended" />

      {!anyData ? (
        <p className="text-sm text-muted text-center py-8">
          No shadow outcomes yet. Each strategy&apos;s valid setups are shadowed mechanically and appear here as they
          resolve.
        </p>
      ) : (
        s.profiles.map((p) => <ProfileCard key={p.profileId} p={p} />)
      )}

      <p className="text-[11px] text-muted text-center leading-relaxed">
        Each strategy is measured on its OWN track: every valid setup is shadowed mechanically (enter at the ask, exit at
        the bid on the profile&apos;s TP/SL/expiry rule) and compared to its own baseline (SPY for swings, QQQ for 0DTE).
        Tracks are never blended, and this never reads the live auto-bought trades. API cost to date ${s.apiCost.toFixed(2)}. Not financial advice.
      </p>
    </div>
  );
}
