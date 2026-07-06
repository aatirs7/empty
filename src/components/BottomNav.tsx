"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

function Icon({ name }: { name: string }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "h-6 w-6",
  };
  if (name === "today")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  if (name === "positions")
    return (
      <svg {...common}>
        <path d="M4 20V10M12 20V4M20 20v-7" />
      </svg>
    );
  if (name === "log")
    return (
      <svg {...common}>
        <path d="M4 6h16M4 12h16M4 18h10" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M3 17l6-6 4 4 7-7" />
      <path d="M17 8h4v4" />
    </svg>
  );
}

const tabs = [
  { href: "/", label: "Today", icon: "today" },
  { href: "/positions", label: "Positions", icon: "positions" },
  { href: "/log", label: "Log", icon: "log" },
  { href: "/pnl", label: "P&L", icon: "pnl" },
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
              className={`flex flex-col items-center justify-center gap-1 py-3 min-h-[68px] transition-colors ${
                active ? "text-accent" : "text-muted"
              }`}
            >
              <Icon name={t.icon} />
              <span className={`text-xs ${active ? "font-medium" : ""}`}>{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
