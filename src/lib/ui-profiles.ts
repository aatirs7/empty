/**
 * UI-visible tradeable profiles (legacy Zones is excluded from the UI).
 *
 * Plain (non-"use client") module so BOTH server components and the client
 * `ProfileTabs` can import the ids/labels. Do NOT export these from a client
 * component — Next replaces a client module's non-component exports with client
 * references on the server, so `UI_PROFILE_IDS.includes(...)` would blow up.
 */
// qqq_0dte was PAUSED + hidden 2026-07-15 (account handed to qqq_manual); it stays
// shadow-measured but has no tab, no report section, no scorecard track shown.
export const UI_PROFILE_TABS = [
  { id: "sbv2", label: "SBv2" },
  { id: "sbv3", label: "SBv3" },
  { id: "sniper_swing", label: "SBv1" },
  { id: "qqq_manual", label: "QQQ Manual" },
] as const;

export const UI_PROFILE_IDS: string[] = UI_PROFILE_TABS.map((t) => t.id);

/** The default UI profile (first tab) when no ?profile= is given. */
export const DEFAULT_UI_PROFILE: string = UI_PROFILE_TABS[0].id;

/** Validate a ?profile= param, falling back to the default (first) tab. */
export function resolveUiProfile(p: string | undefined | null): string {
  return p && UI_PROFILE_IDS.includes(p) ? p : DEFAULT_UI_PROFILE;
}
