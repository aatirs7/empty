"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

// The tradeable profiles shown in the UI switcher (legacy Zones is excluded).
// Labels hardcoded so this stays a light client component (no server imports).
const TABS = [
  { id: "sniper_swing", label: "SniperBot" },
  { id: "qqq_0dte", label: "QQQ 0DTE" },
];

export const UI_PROFILE_IDS = TABS.map((t) => t.id);

export default function ProfileTabs() {
  const path = usePathname();
  const current = useSearchParams().get("profile") ?? "sniper_swing";
  return (
    <div className="flex gap-1.5 justify-center flex-wrap">
      {TABS.map((t) => (
        <Link
          key={t.id}
          href={`${path}?profile=${t.id}`}
          className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
            t.id === current ? "border-accent text-accent" : "border-border text-muted"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
