// Minimal service worker: makes Vega installable to the homescreen and opens
// full-screen. Data stays live (network), so no aggressive caching — just a
// pass-through fetch handler, which is enough for installability.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // pass-through; the app's data is always fetched live
});
