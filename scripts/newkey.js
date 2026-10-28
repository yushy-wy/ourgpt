import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "config", "keys.json");

function detectLanIp() {
  const skip = /vmware|vethernet|wsl|loopback|hyper-v|virtualbox|tap|tun/i;
  const privateIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal && privateIp.test(a.address)) candidates.push(a.address);
    }
  }
  return candidates.sort((x, y) => (x.startsWith("10.") ? -1 : 0) - (y.startsWith("10.") ? -1 : 0))[0] || "127.0.0.1";
}

const user = process.argv[2];
if (!user || !/^[a-z0-9_-]{2,24}$/i.test(user)) {
  console.error("usage: node scripts/newkey.js <user>   (2-24 chars, a-z 0-9 _ -)");
  process.exit(1);
}

const keys = JSON.parse(fs.readFileSync(file, "utf8"));
const key = `sk-ourgpt-${user.toLowerCase()}-${crypto.randomBytes(6).toString("hex")}`;
keys[key] = { user };
fs.writeFileSync(file, JSON.stringify(keys, null, 2) + "\n");

const port = process.env.PORT || 8080;
const base = process.env.OURGPT_BASE || `http://${detectLanIp()}:${port}/v1`;

console.log(`user: ${user}`);
console.log(`key:  ${key}`);
console.log(`\nadd to the user's ~/.codex/config.toml:\n`);
console.log(`model_provider = "ourgpt"

[model_providers.ourgpt]
name = "OurGPT"
base_url = "${base}"
env_key = "OURGPT_API_KEY"
wire_api = "responses"`);
console.log(`\nand set OURGPT_API_KEY=${key}`);
