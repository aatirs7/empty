import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import HeaderThemeToggle from "@/components/HeaderThemeToggle";
import RefreshManager from "@/components/RefreshManager";
import WhatsNew from "@/components/WhatsNew";
import WhatsNewButton from "@/components/WhatsNewButton";
import Sidebar from "@/components/Sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh lg:flex">
      <RefreshManager />
      <WhatsNew />
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile-only top bar; desktop controls live in the sidebar. */}
        <header className="lg:hidden sticky top-0 z-20 bg-background/85 backdrop-blur pt-[env(safe-area-inset-top)]">
          <div className="h-11 max-w-xl mx-auto px-4 flex items-center justify-between">
            <HeaderThemeToggle />
            <div className="flex items-center gap-3">
              <WhatsNewButton />
              <Link href="/settings" aria-label="Settings" className="text-muted p-1 -mr-1">
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </Link>
            </div>
          </div>
        </header>

        {/* Bottom padding clears the fixed bottom nav (nav height + safe area). */}
        <main className="flex-1 w-full max-w-xl lg:max-w-3xl mx-auto px-4 py-4 lg:px-10 lg:py-10 pb-28 lg:pb-10">
          {children}
        </main>
        <BottomNav />
      </div>
    </div>
  );
}
