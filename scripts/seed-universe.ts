/**
 * Seed the scanner universe with ~200 large-cap, liquid US names. Idempotent:
 * clears and re-inserts. Edit the list here or manage `universe` rows directly.
 *
 * Run: npm run seed:universe
 */
import "dotenv/config";
import { db } from "../src/db";
import { universe } from "../src/db/schema";

const SYMBOLS = [
  // Mega-cap tech / comms
  "AAPL","MSFT","NVDA","AMZN","GOOGL","GOOG","META","AVGO","TSLA","NFLX","ORCL","CRM","ADBE","AMD","CSCO","INTC","QCOM","TXN","IBM","NOW","INTU","AMAT","MU","LRCX","KLAC","ADI","SNPS","CDNS","MRVL","PANW","CRWD","FTNT","DDOG","SNOW","PLTR","UBER","ABNB","SHOP","SQ","PYPL","MDB","NET","ANET","DELL","HPQ","SMCI","ARM","MSTR",
  // Comm/media/consumer internet
  "DIS","CMCSA","T","VZ","TMUS","WBD","SPOT","ROKU","PINS","SNAP",
  // Consumer disc / retail
  "HD","LOW","NKE","SBUX","MCD","CMG","BKNG","MAR","TGT","COST","WMT","DG","DLTR","ROST","TJX","LULU","ORLY","AZO","YUM","F","GM","RIVN","LCID",
  // Consumer staples
  "PG","KO","PEP","PM","MO","MDLZ","CL","KMB","GIS","KHC","STZ","MNST","KDP","HSY",
  // Financials
  "JPM","BAC","WFC","C","GS","MS","SCHW","BLK","AXP","V","MA","SPGI","CB","PGR","USB","PNC","TFC","COF","BX","KKR","AMP","MET","AIG","ICE","CME","COIN","HOOD",
  // Health care
  "UNH","JNJ","LLY","PFE","MRK","ABBV","TMO","ABT","DHR","BMY","AMGN","GILD","CVS","CI","ELV","ISRG","MDT","SYK","BSX","REGN","VRTX","ZTS","HCA","MRNA","BIIB",
  // Industrials / transport
  "CAT","DE","BA","GE","HON","UNP","UPS","FDX","LMT","RTX","GD","NOC","MMM","EMR","ETN","ITW","CSX","NSC","WM","PH","ROP","GEV","PCAR",
  // Energy
  "XOM","CVX","COP","SLB","EOG","MPC","PSX","VLO","OXY","WMB","KMI","HAL","DVN","FANG",
  // Materials / utilities / real estate
  "LIN","SHW","APD","FCX","NEM","NUE","DOW","NEE","DUK","SO","AEP","D","EXC","SRE","AMT","PLD","EQIX","CCI","SPG","O",
  // Broad ETFs (context + SPY baseline)
  "SPY","QQQ","IWM","DIA",
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
