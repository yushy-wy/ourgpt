import { execFile } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP =
  process.env.WORKBUDDY_APP_EXECUTABLE ||
  path.join(os.homedir(), "AppData", "Local", "Programs", "WorkBuddy", "WorkBuddy.exe");
const AUTH_FILE =
  process.argv[2] ||
  path.join(os.homedir(), "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info");

const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
const SYMMETRIC_SCHEME = "sym-v1";
const FORMAT_FIELD = "WBEV1";
const FRAMING_FIELD = 2;

const u32 = (v) => {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(v);
  return b;
};
const lp = (v) => {
  const b = Buffer.from(v, "utf8");
  return Buffer.concat([u32(b.length), b]);
};

function fieldAad(keyId, suite, scheme = SYMMETRIC_SCHEME) {
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    lp(FORMAT_FIELD),
    lp(scheme),
    u32(suite),
    lp(keyId),
    Buffer.from([FRAMING_FIELD]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

function fetchKeyPayload(exe) {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      [
        "-e",
        "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}",
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim()));
        else resolve(stdout);
      },
    );
  });
}

export async function readWorkBuddyTokens({ authFile = AUTH_FILE, appExe = APP } = {}) {
  if (!fs.existsSync(authFile)) throw new Error(`auth file not found: ${authFile}`);
  if (!fs.existsSync(appExe)) throw new Error(`WorkBuddy executable not found: ${appExe}`);

  const payload = JSON.parse(await fetchKeyPayload(appExe));
  const secret = payload.atRestSecretKey;
  if (typeof secret !== "string" || !secret) throw new Error("key payload has no atRestSecretKey");

  const key = createHash("sha256").update(secret, "utf8").digest();
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);

  const openField = (wrapper) => {
    const env = JSON.parse(Buffer.from(wrapper.envelope, "base64").toString("utf8"));
    if (env.keyId !== keyId) throw new Error(`envelope keyId ${env.keyId} != available ${keyId}`);
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(env.nonce, "base64"), { authTagLength: 16 });
    d.setAAD(fieldAad(keyId, env.suite));
    d.setAuthTag(Buffer.from(env.authTag, "base64"));
    return Buffer.concat([d.update(Buffer.from(env.ciphertext, "base64")), d.final()]).toString("utf8");
  };

  const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
  const decode = (v) => (typeof v === "string" ? v : v && v.$wbEncrypted === 1 ? openField(v) : null);

  return {
    accessToken: decode(auth.auth?.accessToken),
    refreshToken: decode(auth.auth?.refreshToken),
    expiresAt: auth.auth?.expiresAt,
    domain: auth.auth?.domain,
    uid: auth.account?.uid,
    accountType: auth.account?.accountType,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const t = await readWorkBuddyTokens();
    console.log(
      JSON.stringify(
        {
          uid: t.uid,
          domain: t.domain,
          expiresAt: t.expiresAt,
          access_len: t.accessToken?.length,
          refresh_len: t.refreshToken?.length,
          access_head: t.accessToken ? t.accessToken.slice(0, 10) + "…" : null,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  }
}
