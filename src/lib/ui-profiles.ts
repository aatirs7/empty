/**
 * UI-visible tradeable profiles (legacy Zones is excluded from the UI).
 *
 * Plain (non-"use client") module so BOTH server components and the client
 * `ProfileTabs` can import the ids/labels. Do NOT export these from a client
 * component — Next replaces a client module's non-component exports with client
 * references on the server, so `UI_PROFILE_IDS.includes(...)` would blow up.
 */
export const UI_PROFILE_TABS = [
  { id: "sniper_swing", label: "SniperBot" },
  { id: "qqq_0dte", label: "QQQ 0DTE" },
] as const;

export const UI_PROFILE_IDS: string[] = UI_PROFILE_TABS.map((t) => t.id);

/** Validate a ?profile= param, falling back to the main profile. */
export function resolveUiProfile(p: string | undefined | null): string {
  return p && UI_PROFILE_IDS.includes(p) ? p : "sniper_swing";
}
