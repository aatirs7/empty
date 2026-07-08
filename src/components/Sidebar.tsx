"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { navTabs, NavIcon, isActive } from "./BottomNav";
import HeaderThemeToggle from "./HeaderThemeToggle";
import WhatsNewButton from "./WhatsNewButton";

// Desktop-only left rail. Hidden on mobile (mobile keeps its top header + bottom nav).
export default function Sidebar() {
  const path = usePathname();
  return (
    <aside className="hidden lg:flex flex-col w-60 shrink-0 border-r border-border h-dvh sticky top-0 px-4 py-7">
      <div className="px-3 mb-9">
        <span className="text-2xl font-bold tracking-tight">Vega</span>
        <p className="text-[11px] text-muted mt-0.5">Paper options</p>
      </div>

      <nav className="flex flex-col gap-1">
        {navTabs.map((t) => {
          const active = isActive(path, t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${
                active ? "bg-panel text-accent font-medium" : "text-muted hover:text-foreground hover:bg-panel"
              }`}
            >
              <NavIcon name={t.icon} className="h-5 w-5" />
              {t.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex items-center gap-2 px-2 pt-4 border-t border-border">
        <HeaderThemeToggle />
        <WhatsNewButton />
        <Link href="/settings" aria-label="Settings" className="text-muted ml-auto p-1">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Link>
      </div>
    </aside>
  );
}
