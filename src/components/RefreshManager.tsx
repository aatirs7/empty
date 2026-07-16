"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const THRESHOLD = 70; // px pull to trigger
const AUTO_MS = 120_000; // auto-refresh interval (foreground only; refresh-on-return covers freshness)

// Global: pull-down-to-refresh with a visible spinner, plus periodic auto-refresh
// so every page stays current. Lives in the app shell, so it's on all pages.
//
// PHONE-PERF RULES (2026-07-15 device-drain fix — keep these):
// 1. router.refresh() re-runs EVERY server component on the route (DB + Alpaca
//    work server-side, full RSC payload + reconcile on the phone). It must only
//    fire while the app is actually VISIBLE; when the user returns, one refresh
//    on visibilitychange keeps the "always current when I look" feel.
// 2. The touch listeners are registered ONCE. The pull distance lives in a ref
//    (mirrored to state for render) — the old version had [pull] in the effect
//    deps, so every touchmove frame re-subscribed 3 window listeners (~60x/s
//    during a drag), which is exactly the systemwide keyboard/scroll jank the
//    owner reported.
export default function RefreshManager() {
  const router = useRouter();
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullRef = useRef(0);
  const startY = useRef<number | null>(null);
  const dragging = useRef(false);

  const doRefresh = useCallback(() => {
    setRefreshing(true);
    router.refresh();
    window.setTimeout(() => setRefreshing(false), 900);
  }, [router]);

  useEffect(() => {
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible") doRefresh();
    }, AUTO_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") doRefresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [doRefresh]);

  useEffect(() => {
    const setPullBoth = (v: number) => {
      pullRef.current = v;
      setPull(v);
    };
    const onStart = (e: TouchEvent) => {
      if (window.scrollY <= 0) {
        startY.current = e.touches[0].clientY;
        dragging.current = true;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!dragging.current || startY.current == null) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy > 0 && window.scrollY <= 0) setPullBoth(Math.min(dy * 0.5, 90));
      else if (pullRef.current !== 0) setPullBoth(0);
    };
    const onEnd = () => {
      if (pullRef.current >= THRESHOLD * 0.5) doRefresh();
      setPullBoth(0);
      startY.current = null;
      dragging.current = false;
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
    };
  }, [doRefresh]);

  const show = refreshing || pull > 4;
  const y = refreshing ? 46 : pull;
  const rot = refreshing ? 0 : (pull / (THRESHOLD * 0.5)) * 300;

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 flex justify-center pointer-events-none"
      style={{
        transform: `translateY(${show ? y : -40}px)`,
        opacity: show ? 1 : 0,
        transition: dragging.current ? "none" : "transform 0.25s ease, opacity 0.25s ease",
      }}
      aria-hidden
    >
      <div className="mt-[env(safe-area-inset-top)] h-9 w-9 rounded-full bg-panel border border-border grid place-items-center shadow-md">
        <svg
          viewBox="0 0 24 24"
          className={`h-4 w-4 text-accent ${refreshing ? "animate-spin" : ""}`}
          style={{ transform: refreshing ? undefined : `rotate(${rot}deg)` }}
        >
          <path d="M21 12a9 9 0 1 1-3-6.7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M21 4v4h-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}
