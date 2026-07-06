import Link from "next/link";
import { getSettings } from "@/lib/settings";

// Always-visible banner while auto-execute is ON.
export default async function AutoBanner() {
  const s = await getSettings();
  if (!s.autoExecute) return null;
  return (
    <Link
      href="/settings"
      className="block bg-accent/15 border-b border-accent/40 text-accent text-xs text-center py-2 px-4"
    >
      ● AUTO-EXECUTE IS ON — auto-places paper trades ≥ {Math.round(Number(s.autoMinConfidence) * 100)}% confidence, up to{" "}
      {s.maxAutoTradesPerDay}/day. Tap to manage or turn off.
    </Link>
  );
}
