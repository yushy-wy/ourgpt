import fs from "node:fs";
import path from "node:path";
// minimal sqlite3 reader via node:sqlite
let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); }
catch (e) { console.log("NO node:sqlite ->", e.message); process.exit(2); }
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const tables = process.argv.slice(3);
for (const t of tables) {
  console.log("\n===== " + t + " =====");
  try {
    const rows = db.prepare(`SELECT * FROM ${t}`).all();
    console.log("rows:", rows.length);
    for (const r of rows.slice(0, 20)) console.log(JSON.stringify(r));
  } catch (e) { console.log("ERR", e.message); }
}
