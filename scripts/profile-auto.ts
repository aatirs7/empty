/**
 * Flip a strategy profile's auto-trading on/off (per-profile, PAPER-ONLY). The
 * live monitor reads profile_settings.autoExecute / autoManage per profile, so this
 * is how you enable a profile that ships auto-OFF (e.g. SBv2) once you're ready to
 * let it trade its own paper account — no redeploy needed.
 *
 * Usage:
 *   npm run profile-auto -- sbv2 on          # auto-buy + auto-manage ON
 *   npm run profile-auto -- sbv2 off         # both OFF (back to shadow-only)
 *   npm run profile-auto -- sbv2 buy-only    # auto-buy ON, auto-manage OFF
 *   npm run profile-auto                      # print current state for all profiles
 */
import "dotenv/config";
import { setProfileAuto, getProfileSettings } from "../src/lib/profile-settings";
import { PROFILE_IDS, getProfile } from "../src/lib/profiles";

async function main() {
  if (process.env.TRADING_MODE && process.env.TRADING_MODE !== "paper") {
    throw new Error(`GUARDRAIL: TRADING_MODE must be "paper", got "${process.env.TRADING_MODE}".`);
  }
  const [pid, state] = process.argv.slice(2);

  if (!pid) {
    console.log("Current per-profile auto state:");
    for (const id of PROFILE_IDS) {
      const s = await getProfileSettings(id);
      console.log(`  ${id.padEnd(14)} auto-buy=${s.autoExecute}  auto-manage=${s.autoManage}  (${getProfile(id).label})`);
    }
    return;
  }
  if (!PROFILE_IDS.includes(pid as (typeof PROFILE_IDS)[number])) {
    throw new Error(`Unknown profile "${pid}". One of: ${PROFILE_IDS.join(", ")}`);
  }

  const patch =
    state === "on" ? { autoExecute: true, autoManage: true } :
    state === "off" ? { autoExecute: false, autoManage: false } :
    state === "buy-only" ? { autoExecute: true, autoManage: false } :
    null;
  if (!patch) throw new Error(`state must be one of: on | off | buy-only (got "${state ?? ""}")`);

  await setProfileAuto(pid, patch);
  const s = await getProfileSettings(pid);
  console.log(`${pid} (${getProfile(pid).label}): auto-buy=${s.autoExecute}, auto-manage=${s.autoManage}. PAPER-ONLY.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
