import Link from "next/link";
import { getSettings } from "@/lib/settings";

// Always-visible banner while any automation is ON.
export default async function AutoBanner() {
  const s = await getSettings();
  if (!s.autoExecute && !s.autoManage) return null;
  const label =
    s.autoExecute && s.autoManage
      ? "AUTOPILOT ON, Vega is buying and managing paper trades"
      : s.autoExecute
        ? "AUTO-BUY ON, Vega buys paper trades on its own"
        : "AUTO-MANAGE ON, Vega closes paper trades on its own";
  return (
    <Link
      href="/settings"
      className="block bg-accent/15 border-b border-accent/40 text-accent text-xs text-center py-2 px-4"
    >
      ● {label}. Tap to manage or turn off.
    </Link>
  );
}
