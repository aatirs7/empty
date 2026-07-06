import Link from "next/link";
import AutoBanner from "@/components/AutoBanner";
import BottomNav from "@/components/BottomNav";
import LogoutButton from "@/components/LogoutButton";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col pb-16">
      <header className="sticky top-0 z-10 flex items-center justify-between px-4 h-14 border-b border-border bg-background/90 backdrop-blur">
        <Link href="/" className="font-semibold tracking-tight text-lg">
          Vega
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/settings" aria-label="Settings" className="text-muted text-xl leading-none">
            ⚙
          </Link>
          <LogoutButton />
        </div>
      </header>
      <AutoBanner />
      <main className="flex-1 w-full max-w-xl mx-auto px-4 py-4">{children}</main>
      <BottomNav />
    </div>
  );
}
