/**
 * Seed the scanner universe, tagged per strategy profile:
 *   - sniper_swing : large/mega-cap US names (SBv1 / SniperBot Master).
 *   - sbv2         : SAME mega-cap list as SBv1 (apples-to-apples head-to-head).
 *   - qqq_0dte     : QQQ only.
 *   - zones_legacy : the previous cheap ($5-65) list, kept for its shadow track.
 * Idempotent: clears and re-inserts. Run: npm run seed:universe
 */
import "dotenv/config";
import { db } from "../src/db";
import { universe } from "../src/db/schema";

// Large / mega-cap US names for SniperBot Master.
const SNIPER = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","GOOG","META","AVGO","TSLA","NFLX","ORCL","CRM","ADBE","AMD","CSCO","INTC","QCOM","TXN","IBM","NOW","INTU","AMAT","MU","LRCX","KLAC","ADI","PANW","CRWD","SNOW","PLTR","UBER","ABNB","SHOP","ANET","DELL","SMCI","ARM","MSTR","MRVL","APP",
  "DIS","CMCSA","T","VZ","TMUS","WBD","SPOT","NKE","SBUX","MCD","BKNG","MAR","HD","LOW","TGT","COST","WMT","TJX","F","GM","RIVN",
  "PG","KO","PEP","PM","MO","MDLZ","CL","KHC",
  "JPM","BAC","WFC","C","GS","MS","SCHW","AXP","V","MA","BX","KKR","COIN","HOOD","SOFI","PYPL",
  "UNH","JNJ","LLY","PFE","MRK","ABBV","TMO","ABT","BMY","AMGN","GILD","CVS","ISRG","MRNA",
  "CAT","DE","BA","GE","HON","UNP","UPS","FDX","LMT","RTX","GEV",
  "XOM","CVX","COP","SLB","EOG","OXY","MPC","KMI",
  "LIN","FCX","NEM","NUE","NEE","DUK","SO","AMT","PLD","SPG","O",
];

// QQQ 0DTE — single ticker.
const QQQ = ["QQQ"];

// Cheap ($5-65) liquid optionable names — the shelved legacy zone track.
const ZONES = [
  "INTC","CSCO","HPQ","HPE","WDC","PLTR","PATH","SOUN","BBAI","IONQ","RGTI","U","RBLX","PINS","SNAP","DBX","NU","AFRM","UPST","PYPL","XYZ",
  "F","GM","BAC","WFC","C","KEY","HBAN","RF","USB","ALLY","SOFI","HOOD","FITB","KMI","ET",
  "CCL","NCLH","AAL","UAL","DAL","LUV","JBLU","KSS","M","WBA","CVS","KHC","CAG","TAP",
  "T","VZ","WBD","PARA","CMCSA","FUBO",
  "KGC","GOLD","NEM","FCX","CLF","AA","X","VALE","RIG","HAL","SLB","DVN","MOS","AR","CVE","SU","OXY","APA","WMB","BTU","RRC",
  "GME","AMC","TLRY","CGC","MARA","RIOT","CLSK","HUT","WULF","PLUG","RUN","CHPT","QS","RIVN","LCID","NIO","XPEV","LI","GRAB","JOBY","ACHR","RKLB","ASTS",
  "GDX","GDXJ","SLV","EEM","FXI","EWZ","KRE","ARKK","UNG","SPY",
];

async function main() {
  const rows: { symbol: string; profileId: string; rank: number }[] = [];
  const add = (list: string[], profileId: string) => {
    const seen = new Set<string>();
    list.forEach((s, i) => {
      const sym = s.toUpperCase();
      if (seen.has(`${profileId}:${sym}`)) return;
      seen.add(`${profileId}:${sym}`);
      rows.push({ symbol: sym, profileId, rank: i + 1 });
    });
  };
  add(SNIPER, "sniper_swing");
  add(SNIPER, "sbv2"); // SBv2 shares SBv1's universe for a clean comparison
  add(QQQ, "qqq_0dte");
  add(ZONES, "zones_legacy");

  await db.delete(universe);
  await db.insert(universe).values(rows.map((r) => ({ ...r, active: true })));
  const counts = rows.reduce<Record<string, number>>((m, r) => ((m[r.profileId] = (m[r.profileId] ?? 0) + 1), m), {});
  console.log(`seeded ${rows.length} symbols:`, counts);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
