/**
 * Seed the scanner universe with ~110 cheap, liquid, optionable US names ($5-65),
 * chosen so a $0.50-$1.50 near-the-money contract exists and can be pushed ITM on a
 * zone bounce — the fit for Farrukh's cheap-contract strategy on the $500 account.
 * Mega-caps were dropped: their contracts cost more than the whole account.
 * Idempotent: clears and re-inserts. Run: npm run seed:universe
 */
import "dotenv/config";
import { db } from "../src/db";
import { universe } from "../src/db/schema";

const SYMBOLS = [
  // Tech / semis / software (cheaper, liquid options)
  "INTC","CSCO","HPQ","HPE","WDC","PLTR","PATH","SOUN","BBAI","IONQ","RGTI","U","RBLX","PINS","SNAP","DBX","NU","AFRM","UPST","PYPL","XYZ",
  // Financials (cheaper)
  "F","GM","BAC","WFC","C","KEY","HBAN","RF","USB","ALLY","SOFI","HOOD","FITB","KMI","ET",
  // Consumer / retail / travel (cheaper)
  "CCL","NCLH","AAL","UAL","DAL","LUV","JBLU","KSS","M","WBA","CVS","KHC","CAG","TAP",
  // Comm / media
  "T","VZ","WBD","PARA","CMCSA","FUBO",
  // Energy / materials (cheaper, good volatility)
  "KGC","GOLD","NEM","FCX","CLF","AA","X","VALE","RIG","HAL","SLB","DVN","MOS","AR","CVE","SU","OXY","APA","WMB","BTU","RRC",
  // High-volatility / momentum names (cheap contracts, big % moves)
  "GME","AMC","TLRY","CGC","MARA","RIOT","CLSK","HUT","WULF","PLUG","RUN","CHPT","QS","RIVN","LCID","NIO","XPEV","LI","GRAB","JOBY","ACHR","RKLB","ASTS",
  // Liquid sector/commodity ETFs (clean zones) + SPY (baseline only)
  "GDX","GDXJ","SLV","EEM","FXI","EWZ","KRE","ARKK","XLF","UNG","SPY",
];

async function main() {
  const unique = [...new Set(SYMBOLS.map((s) => s.toUpperCase()))];
  await db.delete(universe);
  await db.insert(universe).values(unique.map((symbol, i) => ({ symbol, rank: i + 1, active: true })));
  console.log(`seeded ${unique.length} symbols into universe`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
