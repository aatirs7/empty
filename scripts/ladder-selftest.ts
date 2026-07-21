/**
 * Ladder self-test — pure assertions over `ladderPlan` (no DB, no broker, no network).
 * Run: npx tsx scripts/ladder-selftest.ts
 *
 * Covers QQQ Manual's owner-specified ladder (2026-07-21) rung by rung, plus the
 * SB15M legacy config, so a change to one can't silently alter the other.
 */
import "dotenv/config"; // monitor.ts pulls in the db module, which requires DATABASE_URL
import { ladderPlan } from "../src/lib/monitor";
import { getProfile } from "../src/lib/profiles";

const MANUAL = getProfile("qqq_manual").exit;
const SB15M = getProfile("sb15m").exit;

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`);
}

// --- QQQ Manual: 5 contracts in -------------------------------------------------
const base = { exit: MANUAL, entryQty: 5, trims: [] as number[], heldQty: 5 };

// 1. Flat / small gain: no action, base stop -25%.
{
  const p = ladderPlan({ ...base, ret: 0.1, peak: 0.1 });
  check("no action below +50%", p.close === "" && p.trim === null, p);
  check("base stop is -25%", p.stop === -0.25, p.stop);
}

// 2. Before +50%, -25% sells ALL 5.
{
  const p = ladderPlan({ ...base, ret: -0.25, peak: 0.2 });
  check("-25% closes everything before any trim", p.close !== "" && p.trim === null, p);
}
{
  const p = ladderPlan({ ...base, ret: -0.24, peak: 0.2 });
  check("-24% does NOT close", p.close === "", p);
}

// 3. At +50%: sell 2, stop -> breakeven.
{
  const p = ladderPlan({ ...base, ret: 0.5, peak: 0.5 });
  check("+50% trims 2", p.trim?.qty === 2 && p.trim?.atPct === 0.5, p.trim);
  check("+50% trim moves the stop to breakeven", p.trim?.newStop === 0, p.trim);
  check("+50% is a trim, not a close", p.close === "", p);
}

// 4. After the +50% trim (3 held): stop is breakeven, and a fade to 0 sells all 3.
{
  const held = { ...base, trims: [0.5], heldQty: 3 };
  check("stop is breakeven after trim 1", ladderPlan({ ...held, ret: 0.2, peak: 0.55 }).stop === 0);
  const p = ladderPlan({ ...held, ret: 0, peak: 0.55 });
  check("fade to breakeven closes the remaining 3", p.close.includes("breakeven") && p.trim === null, p);
  check("still open at +10% after trim 1", ladderPlan({ ...held, ret: 0.1, peak: 0.55 }).close === "");
}

// 5. At +75%: sell 1, stop -> +25%.
{
  const p = ladderPlan({ ...base, trims: [0.5], heldQty: 3, ret: 0.75, peak: 0.75 });
  check("+75% trims 1", p.trim?.qty === 1 && p.trim?.atPct === 0.75, p.trim);
  check("+75% trim moves the stop to +25%", p.trim?.newStop === 0.25, p.trim);
}

// 6. After the +75% trim (2 held): a fade back to +25% sells everything left.
{
  const held = { ...base, trims: [0.5, 0.75], heldQty: 2 };
  check("stop is +25% after trim 2", ladderPlan({ ...held, ret: 0.4, peak: 0.8 }).stop === 0.25);
  const p = ladderPlan({ ...held, ret: 0.25, peak: 0.8 });
  check("fade to +25% closes the final 2", p.close !== "" && p.trim === null, p);
  check("+30% still holds", ladderPlan({ ...held, ret: 0.3, peak: 0.8 }).close === "");
}

// 7. At +100%: sell the final 2.
{
  const p = ladderPlan({ ...base, trims: [0.5, 0.75], heldQty: 2, ret: 1.0, peak: 1.0 });
  check("+100% closes the rest", p.close.includes("take-profit") && p.trim === null, p);
}

// 8. A gap straight to +100% closes the whole lot (one action per update).
{
  const p = ladderPlan({ ...base, ret: 1.2, peak: 1.2 });
  check("gap to +120% closes all 5 at once", p.close !== "" && p.trim === null, p);
}

// 9. The ratchet never loosens: peak past a rung keeps the tighter stop after a fade.
{
  const p = ladderPlan({ ...base, trims: [0.5], heldQty: 3, ret: -0.2, peak: 0.6 });
  check("stop cannot fall back to -25% once +50% printed", p.stop === 0 && p.close !== "", p);
}

// 10. Removed exits stay removed for QQQ Manual.
{
  const p = ladderPlan({ ...base, ret: 0.1, peak: 0.1, nearTargetLevel: 999, timedOutMin: 999 });
  check("next-level target + no-bounce timeout are disabled", p.close === "", p);
}

// 11. End-of-day flatten still applies.
{
  const p = ladderPlan({ ...base, ret: 0.1, peak: 0.1, eodFlatten: true });
  check("EOD flatten closes the position", p.close.includes("end-of-day"), p);
}

// 12. One action per update: a trim is never returned alongside a close.
{
  const p = ladderPlan({ ...base, ret: 0.5, peak: 0.5, eodFlatten: true });
  check("close wins over trim in the same update", p.close !== "" && p.trim === null, p);
}

// 13. Partial fills scale the tranches proportionally (should not happen — the
//     5-lot is all-or-nothing — but the math must stay sane if it ever does).
{
  const p = ladderPlan({ exit: MANUAL, entryQty: 3, trims: [], heldQty: 3, ret: 0.5, peak: 0.5 });
  check("3-contract fill trims 1 at +50%", p.trim?.qty === 1, p.trim);
}

// --- SB 15M: ONE contract, −20% → breakeven at +40% (no sell) → +100% ------------
{
  const b = { exit: SB15M, entryQty: 1, trims: [] as number[], heldQty: 1 };
  check("SB15M base stop is -20%", ladderPlan({ ...b, ret: 0, peak: 0 }).stop === -0.2);
  const stopped = ladderPlan({ ...b, ret: -0.2, peak: 0.1 });
  check("SB15M -20% closes the contract", stopped.close !== "" && stopped.trim === null, stopped);
  check("SB15M -19% holds", ladderPlan({ ...b, ret: -0.19, peak: 0.1 }).close === "");

  // +40% is a stop ratchet, NOT a profit-take: keep holding the single contract.
  const at40 = ladderPlan({ ...b, ret: 0.4, peak: 0.4 });
  check("SB15M does NOT sell at +40%", at40.close === "" && at40.trim === null, at40);
  check("SB15M stop moves to breakeven at +40%", at40.stop === 0, at40.stop);
  check("SB15M stop is still -20% at +39%", ladderPlan({ ...b, ret: 0.39, peak: 0.39 }).stop === -0.2);

  // Once breakeven is armed it never reverts, and a reversal exits at breakeven.
  const back = ladderPlan({ ...b, ret: 0, peak: 0.6 });
  check("SB15M reversal after +40% exits at breakeven", back.close.includes("breakeven"), back);
  check("SB15M stop never reverts to -20%", ladderPlan({ ...b, ret: -0.1, peak: 0.5 }).stop === 0);

  // +100% sells the whole contract.
  const target = ladderPlan({ ...b, ret: 1.0, peak: 1.0 });
  check("SB15M sells everything at +100%", target.close.includes("take-profit") && target.trim === null, target);
  check("SB15M holds at +99%", ladderPlan({ ...b, ret: 0.99, peak: 0.99 }).close === "");

  // Day-trade guarantee + the exits the spec does NOT have.
  check("SB15M flattens at the close", ladderPlan({ ...b, ret: 0.2, peak: 0.45, eodFlatten: true }).close.includes("end-of-day"));
  const none = ladderPlan({ ...b, ret: 0.2, peak: 0.2, nearTargetLevel: 999, timedOutMin: 999 });
  check("SB15M has no target/timeout exits", none.close === "", none);
}

console.log(`${pass}/${pass + fails.length} ladder assertions passed`);
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`);
  process.exit(1);
}
