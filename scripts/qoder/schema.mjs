import fs from "node:fs";
const f = process.argv[2];
const s = fs.readFileSync(f).toString("latin1");
const want = ["byok_model_profiles","byok_model_credentials","account_profiles","app_settings","chat_model_preferences","byok_model_capability_metadata"];
for (const w of want) {
  const re = new RegExp("CREATE TABLE [`\"]?" + w + "[\\s\\S]{0,900}?\\)\\s*", "i");
  const m = s.match(re);
  console.log("===== " + w + " =====");
  console.log(m ? m[0].slice(0, 900).replace(/[^\x20-\x7E\n]/g, "") : "(not found)");
}
