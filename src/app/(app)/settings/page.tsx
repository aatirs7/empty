import Link from "next/link";
import { getSettings } from "@/lib/settings";
import SettingsForm from "@/components/SettingsForm";
import ThemeToggle from "@/components/ThemeToggle";
import WatchlistEditor from "@/components/WatchlistEditor";
import LogoutButton from "@/components/LogoutButton";
import { PageTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = await getSettings();
  return (
    <div className="space-y-5">
      <PageTitle title="Settings" />
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
      <Link
        href="/handoff"
        className="block bg-panel border border-border rounded-2xl p-4 text-center text-sm text-accent"
      >
        Handoff doc &rarr;
        <span className="block text-[11px] text-muted mt-0.5">Context to paste into any chat</span>
      </Link>
      <LogoutButton />
    </div>
  );
}
