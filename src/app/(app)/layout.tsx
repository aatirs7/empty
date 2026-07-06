import Link from "next/link";
import AutoBanner from "@/components/AutoBanner";
import BottomNav from "@/components/BottomNav";
import LogoutButton from "@/components/LogoutButton";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col pb-24">
      <header className="sticky top-0 z-10 h-14 border-b border-border bg-background/90 backdrop-blur">
        <div className="relative h-full max-w-xl mx-auto px-4 flex items-center">
          <Link href="/" className="absolute left-1/2 -translate-x-1/2 font-semibold tracking-tight text-lg">
            Vega
          </Link>
          <div className="ml-auto flex items-center gap-4">
            <Link href="/settings" aria-label="Settings" className="text-muted text-xl leading-none">
              ⚙
            </Link>
            <LogoutButton />
          </div>
        </div>
      </header>
      <AutoBanner />
      <main className="flex-1 w-full max-w-xl mx-auto px-4 py-5">{children}</main>
      <BottomNav />
    </div>
  );
}
