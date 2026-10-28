import fs from "node:fs";
const f = process.argv[2];
const b = fs.readFileSync(f);
const s = b.toString("latin1");
const tbl = [...new Set([...s.matchAll(/CREATE TABLE [`"]?([a-zA-Z_]+)/g)].map((m) => m[1]))];
console.log("TABLES:", tbl.join(", "));
