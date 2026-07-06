import { getSettings } from "@/lib/settings";
import SettingsForm from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = await getSettings();
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      <SettingsForm
        initial={{
          autoExecute: s.autoExecute,
          autoMinConfidence: Number(s.autoMinConfidence),
          maxAutoTradesPerDay: s.maxAutoTradesPerDay,
        }}
      />
    </div>
  );
}
