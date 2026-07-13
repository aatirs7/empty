/**
 * Activity log writer. Records every monitor decision — a zone crossing that was
 * BOUGHT, SOLD, or SKIPPED (with the reason) — so the daily report can explain the
 * bot's behavior, not just its trades. Best-effort: never breaks a tick.
 */
import { db } from "../db";
import { activityLog } from "../db/schema";

export interface ActivityEntry {
  profileId?: string | null;
  symbol?: string | null;
  kind: "buy" | "sell" | "skip" | "tap"; // "tap" = a zone-tap audit event (not a trade decision)
  direction?: string | null;
  price?: number | null;
  candidateId?: number | null;
  detail?: string | null;
  meta?: unknown;
}

export async function logActivity(entries: ActivityEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const runDate = new Date().toISOString().slice(0, 10);
  try {
    await db.insert(activityLog).values(
      entries.map((e) => ({
        runDate,
        profileId: e.profileId ?? null,
        symbol: e.symbol ?? null,
        kind: e.kind,
        direction: e.direction ?? null,
        price: e.price != null ? String(e.price) : null,
        candidateId: e.candidateId ?? null,
        detail: e.detail ?? null,
        meta: e.meta ?? null,
      })),
    );
  } catch {
    /* logging must never break trading */
  }
}

/** Classify a monitor Fire into an activity kind from its shape. */
export function fireKind(placed: boolean, detail: string): "buy" | "sell" | "skip" {
  if (placed && /^(sold|stopped|closed)/i.test(detail)) return "sell";
  if (placed) return "buy";
  return "skip";
}
