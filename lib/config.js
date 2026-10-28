import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

export function loadConfig() {
  const keysPath = path.join(root, "config", "keys.json");
  if (!fs.existsSync(keysPath)) {
    fs.copyFileSync(path.join(root, "config", "keys.example.json"), keysPath);
  }
  const keys = readJson("config/keys.json");
  const upstreams = readJson("config/upstreams.json");

  const modelIndex = new Map();
  for (const [name, up] of Object.entries(upstreams)) {
    for (const model of up.models || []) {
      if (modelIndex.has(model)) {
        throw new Error(`model "${model}" declared by both ${modelIndex.get(model).name} and ${name}`);
      }
      modelIndex.set(model, { ...up, name });
    }
  }

  return {
    root,
    port: Number(process.env.PORT || 8080),
    host: process.env.HOST || "0.0.0.0",
    keys,
    upstreams,
    modelIndex,
    ledgerFile: path.join(root, "data", "ledger.jsonl"),
  };
}
