import { getProfileCost } from "@/lib/cost";
import { type PortfolioPL } from "@/lib/alpaca";
import { getBroker } from "@/lib/broker";
import { usd } from "@/lib/format";
import { PageTitle } from "@/components/ui";
import GoalProgress from "@/components/GoalProgress";
import AccountBalance from "@/components/AccountBalance";
import ProfileTabs, { UI_PROFILE_IDS } from "@/components/ProfileTabs";

export const dynamic = "force-dynamic";

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-foreground";
  return (
    <div className="bg-panel border border-border rounded-xl p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`text-lg font-semibold num ${color}`}>{value}</p>
    </div>
  );
}

export default async function PnlPage({ searchParams }: { searchParams: Promise<{ profile?: string }> }) {
  const sp = await searchParams;
  const profileId = UI_PROFILE_IDS.includes(sp.profile ?? "") ? (sp.profile as string) : "sniper_swing";
  const cost = await getProfileCost(profileId);
  let pl: PortfolioPL | null = null;
  let plError: string | null = null;
  try {
    pl = await getBroker(profileId).getPortfolioPL();
  } catch (e) {
    plError = e instanceof Error ? e.message : "unavailable";
  }

  const tradePL = pl?.totalPL ?? 0;
  const net = tradePL - cost.total;

  return (
    <div className="space-y-5">
      <PageTitle title="Profit & Loss" />

      <ProfileTabs />

      <AccountBalance profile={profileId} />

      <GoalProgress />

      <div className="bg-panel border border-border rounded-2xl p-5 text-center">
        <p className="text-xs text-muted">Net profit, trade P&amp;L minus API cost</p>
        <p className={`text-4xl font-bold num mt-1 ${net >= 0 ? "text-up" : "text-down"}`}>
          {net >= 0 ? "+" : ""}
          {usd(net)}
        </p>
        <p className="text-xs text-muted mt-1 num">
          {pl ? `${tradePL >= 0 ? "+" : ""}${usd(tradePL)} trades − ${usd(cost.total)} API` : `− ${usd(cost.total)} API cost`}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Trade P&L (paper, all-time)"
          value={pl ? `${tradePL >= 0 ? "+" : ""}${usd(tradePL)}` : "-"}
          tone={pl ? (tradePL >= 0 ? "up" : "down") : undefined}
        />
        <Stat label="API cost (this account)" value={usd(cost.total)} />
        <Stat label="API cost (this month)" value={usd(cost.monthToDate)} />
        <Stat label="Claude calls" value={String(cost.callCount)} />
      </div>

      {plError && <p className="text-xs text-muted">Trade P&amp;L unavailable right now ({plError}).</p>}

      <a href="/scorecard" className="block text-center text-xs text-accent">
        See the paper-month scorecard &rarr;
      </a>

      <p className="text-xs text-muted">
        Paper account. Trade P&amp;L is this account&apos;s paper equity change since it started (realized + unrealized)
        from Alpaca. API cost is only this account&apos;s own Claude spend (SniperBot&apos;s catalyst check; QQQ 0DTE uses
        none), tracked from when per-account billing began. Net is one minus the other, both code-computed.
      </p>
    </div>
  );
}
