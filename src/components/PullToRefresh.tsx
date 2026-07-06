"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Silent pull-to-refresh: when already at the top of the page and the user pulls
// down past a threshold, re-fetch the server data. No visible indicator.
export default function PullToRefresh({ threshold = 80 }: { threshold?: number }) {
  const router = useRouter();
  useEffect(() => {
    let startY = 0;
    let pulling = false;

    const onStart = (e: TouchEvent) => {
      if (window.scrollY <= 0) {
        startY = e.touches[0].clientY;
        pulling = true;
      } else {
        pulling = false;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > threshold) {
        pulling = false;
        router.refresh();
      }
    };
    const onEnd = () => {
      pulling = false;
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
    };
  }, [router, threshold]);

  return null;
}
