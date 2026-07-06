"use client";
import { useRouter } from "next/navigation";

export default function LogoutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await fetch("/api/logout", { method: "POST" });
        router.replace("/login");
        router.refresh();
      }}
      className="w-full rounded-2xl border border-border py-3 text-sm text-down"
    >
      Sign out
    </button>
  );
}
