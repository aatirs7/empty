"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (res.ok) {
      router.replace("/");
      router.refresh();
    } else {
      setError("Wrong password.");
      setPassword("");
    }
  }

  return (
    <main className="min-h-dvh flex flex-col items-center justify-center px-6">
      <Image src="/icons/icon-192.png" alt="Vega" width={72} height={72} className="rounded-2xl mb-5" priority />
      <h1 className="text-xl font-semibold tracking-tight">Vega</h1>
      <p className="text-muted text-sm mb-8">Pre-market options research · paper only</p>
      <form onSubmit={submit} className="w-full max-w-xs flex flex-col gap-3">
        <input
          type="password"
          inputMode="text"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-xl bg-panel border border-border px-4 py-3 text-base outline-none focus:border-muted"
        />
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-xl bg-accent py-3 font-medium text-white disabled:opacity-40"
        >
          {busy ? "…" : "Enter"}
        </button>
        {error && <p className="text-down text-sm text-center">{error}</p>}
      </form>
    </main>
  );
}
