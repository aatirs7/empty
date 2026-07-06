import { getSettings } from "@/lib/settings";
import SettingsForm from "@/components/SettingsForm";
import ThemeToggle from "@/components/ThemeToggle";
import LogoutButton from "@/components/LogoutButton";
import { PageTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = await getSettings();
  return (
    <div className="space-y-5">
      <PageTitle title="Settings" />
      <ThemeToggle />
      <SettingsForm
        initial={{
          autoExecute: s.autoExecute,
          autoMinConfidence: Number(s.autoMinConfidence),
          maxAutoTradesPerDay: s.maxAutoTradesPerDay,
        }}
      />
      <LogoutButton />
    </div>
  );
}
