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
      <LogoutButton />
    </div>
  );
}
