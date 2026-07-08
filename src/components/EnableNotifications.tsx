"use client";
import { useEffect, useState } from "react";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

type State = "unknown" | "unsupported" | "default" | "granted" | "denied" | "subscribing" | "error";

export default function EnableNotifications() {
  const [state, setState] = useState<State>("unknown");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setState("unsupported");
      return;
    }
    setState(Notification.permission as State);
  }, []);

  async function enable() {
    try {
      setState("subscribing");
      setMsg("");
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm as State);
        return;
      }
      const { key } = await fetch("/api/push/vapid").then((r) => r.json());
      if (!key) {
        setState("error");
        setMsg("Server is missing its notification key.");
        return;
      }
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
        }));
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sub),
      });
      setState("granted");
      setMsg("Notifications on. You'll get an alert whenever a trade is placed or sold.");
    } catch (e) {
      setState("error");
      setMsg(e instanceof Error ? e.message : "Couldn't enable notifications.");
    }
  }

  async function test() {
    setMsg("Sending a test…");
    const r = await fetch("/api/push/test", { method: "POST" }).then((x) => x.json());
    setMsg(r.sent > 0 ? "Test sent — check your notifications." : "No devices subscribed yet.");
  }

  if (state === "unsupported") {
    return (
      <p className="text-xs text-muted leading-relaxed">
        Notifications aren&apos;t supported on this browser. On iPhone, add Vega to your home screen first, then open it
        from there.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {state === "granted" ? (
        <>
          <p className="text-sm text-up">Notifications are on.</p>
          <button onClick={test} className="text-xs text-accent">
            Send a test notification →
          </button>
        </>
      ) : state === "denied" ? (
        <p className="text-xs text-muted leading-relaxed">
          Notifications are blocked for Vega. Enable them in your browser / site settings, then reload this page.
        </p>
      ) : (
        <button
          onClick={enable}
          disabled={state === "subscribing"}
          className="w-full rounded-xl bg-accent text-white py-2.5 text-sm font-semibold disabled:opacity-50"
        >
          {state === "subscribing" ? "Enabling…" : "Enable trade notifications"}
        </button>
      )}
      {msg && <p className="text-xs text-muted leading-relaxed">{msg}</p>}
    </div>
  );
}
