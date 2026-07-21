import Link from "next/link";
import { getSettings } from "@/lib/settings";
import SettingsForm from "@/components/SettingsForm";
import ThemeToggle from "@/components/ThemeToggle";
import WatchlistEditor from "@/components/WatchlistEditor";
import LogoutButton from "@/components/LogoutButton";
import EnableNotifications from "@/components/EnableNotifications";
import { PageTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = await getSettings();
  return (
    <div className="space-y-5">
      <PageTitle title="Settings" />
      <Link
        href="/strategy"
        className="block bg-panel border border-border rounded-2xl p-4 text-center text-sm text-accent"
      >
        How Vega trades &rarr;
        <span className="block text-[11px] text-muted mt-0.5">The strategy, in plain English</span>
      </Link>
      <Link
        href="/backtest"
        className="block bg-panel border border-border rounded-2xl p-4 text-center text-sm text-accent"
      >
        Backtest results &rarr;
        <span className="block text-[11px] text-muted mt-0.5">Strategy replays against history — hit rates, honesty checks</span>
      </Link>
      <div className="bg-panel border border-border rounded-2xl p-4 space-y-2 text-center">
        <p className="text-sm font-medium">Trade notifications</p>
        <p className="text-xs text-muted leading-relaxed">
          Get a push the moment Vega places or sells a trade — even when the app is closed.
        </p>
        <EnableNotifications />
      </div>
      <WatchlistEditor />
      <ThemeToggle />
      <SettingsForm
        initial={{
          autoExecute: s.autoExecute,
          autoMinConfidence: Number(s.autoMinConfidence),
          maxAutoTradesPerDay: s.maxAutoTradesPerDay,
          autoManage: s.autoManage,
          weeklyGoal: Number(s.weeklyGoal),
          riskTolerance: s.riskTolerance,
          perTradeBudget: Number(s.perTradeBudget),
          maxContracts: s.maxContracts,
          maxContractPrice: Number(s.maxContractPrice),
        }}
      />
      <LogoutButton />
    </div>
  );
}
