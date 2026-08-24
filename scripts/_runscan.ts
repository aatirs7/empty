import "dotenv/config"; import { runScan } from "../src/lib/scanner";
(async()=>{ const r = await runScan(); console.log("=== scan results ==="); for(const s of r) console.log(`  ${s.profileId}: scanned=${s.scanned} candidates=${s.candidates} valid=${s.validSetups}`); process.exit(0); })();
