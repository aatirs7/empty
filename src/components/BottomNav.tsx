"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/", label: "Today" },
  { href: "/positions", label: "Positions" },
  { href: "/log", label: "Log" },
  { href: "/pnl", label: "P&L" },
];

export default function BottomNav() {
  const path = usePathname();
  return (
    <nav className="fixed bottom-0 inset-x-0 z-10 border-t border-border bg-background/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
      <div className="max-w-xl mx-auto grid grid-cols-4">
        {tabs.map((t) => {
          const active = t.href === "/" ? path === "/" : path.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`py-3 text-center text-xs ${active ? "text-foreground font-medium" : "text-muted"}`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
