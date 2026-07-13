"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { UI_PROFILE_TABS, DEFAULT_UI_PROFILE } from "@/lib/ui-profiles";

export default function ProfileTabs() {
  const path = usePathname();
  const current = useSearchParams().get("profile") ?? DEFAULT_UI_PROFILE;
  return (
    <div className="flex gap-1.5 justify-center flex-wrap">
      {UI_PROFILE_TABS.map((t) => (
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
