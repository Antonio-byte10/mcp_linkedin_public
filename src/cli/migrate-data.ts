// npm run migrate-data: moves what an older version kept in the code folder (data/, .edge-profile/, .chrome-profile/)
// into the data folder (LINKEDIN_DATA_DIR, default %LOCALAPPDATA%\mcp-linkedin). Run it with Claude Desktop/Code closed.
import path from "node:path";
import { config } from "../config.js";
import { profileLocked } from "../browser/profileLock.js";
import { migrateLegacyData } from "../store/migrateData.js";

console.log(`Code folder: ${config.root}\nData folder: ${config.dataDir}`);
const r = migrateLegacyData({ root: config.root, dataDir: config.dataDir, inUse: [config.profileDir, path.dirname(config.dbPath)], profileLocked });
for (const m of r.moved) console.log(`moved    ${m}`);
for (const s of r.skipped) console.log(`SKIPPED  ${s.item}: ${s.reason}`);
if (!r.moved.length && !r.skipped.length) console.log("Nothing to move: no data/, .edge-profile/ or .chrome-profile/ in the code folder.");
process.exitCode = r.skipped.length ? 1 : 0;
