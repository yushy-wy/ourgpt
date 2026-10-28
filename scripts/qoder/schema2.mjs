import fs from "node:fs";
const f = process.argv[2];
const s = fs.readFileSync(f).toString("latin1");
for (const w of ["byok_model_profiles","account_profiles"]) {
  const i = s.indexOf("CREATE TABLE " + w);
  if (i < 0) { console.log(w + ": not found"); continue; }
  console.log("===== " + w + " =====");
  console.log(s.slice(i, i + 2500).replace(/[^\x20-\x7E\n]/g, "").split(/CREATE TABLE /)[0]);
}
