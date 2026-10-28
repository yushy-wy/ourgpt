import fs from "node:fs";
const f = process.argv[2];
const s = fs.readFileSync(f).toString("latin1");
for (const w of ["byok_model_profiles","account_profiles"]) {
  const i = s.indexOf("CREATE TABLE " + w);
  console.log("===== " + w + " ===== idx=" + i);
  if (i >= 0) console.log(s.slice(i, i + 2000).replace(/[^\x20-\x7E\n]/g, ""));
}
