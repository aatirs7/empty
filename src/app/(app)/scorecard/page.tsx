import { computeScorecard, type ProfileScore } from "@/lib/scorecard";
import { PageTitle } from "@/components/ui";
import { usd } from "@/lib/format";

export const dynamic = "force-dynamic";

const pct = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-foreground";
  return (
    <div className="text-center">
      <p className="text-[11px] text-muted">{label}</p>
      <p className={`num text-sm ${color}`}>{value}</p>
    </div>
  );
}

function ProfileCard({ p }: { p: ProfileScore }) {
  const netTone = p.netPnl >= 0 ? "text-up" : "text-down";
  return (
    <div className="bg-panel border border-border rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{p.label}</p>
        <span className="text-[11px] text-muted">
          {p.openCount} open{p.openCount > 0 ? ` · ${usd(p.unrealizedPnl)} unrealized` : ""}
        </span>
      </div>

      <div className="text-center">
        <p className="text-xs text-muted">Net P&amp;L (account)</p>
        <p className={`text-3xl font-bold num ${netTone}`}>
          {p.netPnl >= 0 ? "+" : ""}
          {usd(p.netPnl)}
        </p>
      </div>

      {p.closed === 0 ? (
        <p className="text-xs text-muted text-center">No closed trades yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2 pt-1 border-t border-border">
            <Stat label="trades" value={String(p.closed)} />
            <Stat label="win rate" value={`${Math.round(p.winRate * 100)}%`} />
            <Stat label="realized" value={usd(p.realizedPnl)} tone={p.realizedPnl >= 0 ? "up" : "down"} />
            <Stat label="avg hold" value={`${p.avgHoldDays}d`} />
          </div>
          <div className="grid grid-cols-4 gap-2">
            <Stat label="wins" value={String(p.wins)} tone="up" />
            <Stat label="losses" value={String(p.losses)} tone="down" />
            <Stat label="avg win" value={pct(p.avgWinPct)} tone="up" />
            <Stat label="avg loss" value={pct(p.avgLossPct)} tone="down" />
          </div>
          <div className="flex justify-between text-[11px] text-muted num pt-1 border-t border-border">
            <span>best {usd(p.bestPnl)}</span>
            <span>worst {usd(p.worstPnl)}</span>
            <span>API cost {usd(p.apiCost)}</span>
          </div>
        </>
      )}
    </div>
  );
}

export default async function ScorecardPage() {
  const s = await computeScorecard();

  return (
    <div className="space-y-4">
      <PageTitle title="Scorecard" subtitle="your real trading activity, per account" />

      {s.profiles.map((p) => (
        <ProfileCard key={p.profileId} p={p} />
      ))}

      <p className="text-[11px] text-muted text-center leading-relaxed">
        A summary of your ACTUAL trades on each strategy&apos;s paper account. Net P&amp;L is the real account equity
        change (realized + unrealized) from Alpaca — the source of truth. Win rate, average win/loss, and hold time are
        computed from your real closed trades. Not a simulation. Not financial advice.
      </p>
    </div>
  );
}
