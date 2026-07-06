/**
 * Single-row app settings (auto-execute mode). PAPER-ONLY; off by default.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { settings, type Settings } from "../db/schema";

/** Returns the settings row, creating the default (auto OFF) row if none exists. */
export async function getSettings(): Promise<Settings> {
  const [row] = await db.select().from(settings).limit(1);
  if (row) return row;
  const [created] = await db.insert(settings).values({}).returning();
  return created;
}

export interface SettingsPatch {
  autoExecute?: boolean;
  autoMinConfidence?: number;
  maxAutoTradesPerDay?: number;
  autoManage?: boolean;
  weeklyGoal?: number;
  riskTolerance?: string;
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const current = await getSettings();
  const [updated] = await db
    .update(settings)
    .set({
      ...(patch.autoExecute !== undefined ? { autoExecute: patch.autoExecute } : {}),
      ...(patch.autoMinConfidence !== undefined ? { autoMinConfidence: String(patch.autoMinConfidence) } : {}),
      ...(patch.maxAutoTradesPerDay !== undefined ? { maxAutoTradesPerDay: patch.maxAutoTradesPerDay } : {}),
      ...(patch.autoManage !== undefined ? { autoManage: patch.autoManage } : {}),
      ...(patch.weeklyGoal !== undefined ? { weeklyGoal: String(patch.weeklyGoal) } : {}),
      ...(patch.riskTolerance !== undefined ? { riskTolerance: patch.riskTolerance } : {}),
      updatedAt: new Date(),
    })
    .where(eq(settings.id, current.id))
    .returning();
  return updated;
}
