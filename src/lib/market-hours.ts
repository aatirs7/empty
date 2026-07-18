/**
 * Zero-cost market-hours precheck — pure clock math, NO network and NO database.
 *
 * Used as the FIRST gate in live-session paths (the every-minute monitor cron) so
 * out-of-session invocations return immediately and Neon can scale to zero. This is
 * deliberately a slightly WIDER window (9:25–16:05 ET) than the trading session:
 * inside it, the Alpaca clock remains the truth (it also catches holidays); outside
 * it, no US equity session can possibly be open, so nothing else needs to run.
 *
 * Scheduled once-a-day jobs (nightly scan, vet, 8:45 reminder, 16:10 report) are
 * intentionally NOT gated by this — they're whitelisted schedules, not polling.
 */
const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function inEtTradingWindow(d: Date = new Date()): boolean {
  const parts = ET_FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("weekday");
  if (day === "Sat" || day === "Sun") return false;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return minutes >= 9 * 60 + 25 && minutes <= 16 * 60 + 5; // 9:25–16:05 ET
}
