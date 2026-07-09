/**
 * Per-profile runtime toggles (auto-execute / auto-manage). Seeded from each
 * profile's `autoDefault` on first read. This replaces the single global
 * settings.autoExecute for the trading path so profiles run independently.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { profileSettings, type ProfileSettingsRow } from "../db/schema";
import { getProfile } from "./profiles";

export async function getProfileSettings(profileId: string): Promise<ProfileSettingsRow> {
  const [row] = await db.select().from(profileSettings).where(eq(profileSettings.profileId, profileId)).limit(1);
  if (row) return row;
  const p = getProfile(profileId);
  await db
    .insert(profileSettings)
    .values({ profileId, autoExecute: p.autoDefault, autoManage: p.autoDefault })
    .onConflictDoNothing({ target: profileSettings.profileId });
  const [created] = await db.select().from(profileSettings).where(eq(profileSettings.profileId, profileId)).limit(1);
  return created;
}

export async function setProfileAuto(
  profileId: string,
  patch: { autoExecute?: boolean; autoManage?: boolean },
): Promise<void> {
  await getProfileSettings(profileId); // ensure the row exists
  await db
    .update(profileSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(profileSettings.profileId, profileId));
}
