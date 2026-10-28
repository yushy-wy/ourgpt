import { readWorkBuddyTokens } from "./workbuddy-auth.mjs";

const t = await readWorkBuddyTokens();
console.log("account:", t.uid, "| domain:", t.domain, "| expires:", new Date(t.expiresAt).toISOString());

const baseHeaders = {
  authorization: `Bearer ${t.accessToken}`,
  "content-type": "application/json",
  accept: "application/json",
  "user-agent": "WorkBuddy/2.165.0",
};

const HOST = "https://copilot.tencent.com";

for (const p of ["/v3/config", "/v2/enterprises/personal/models"]) {
  try {
    const res = await fetch(HOST + p, { headers: baseHeaders, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    console.log(`\n== ${p} -> ${res.status} (${text.length}B)`);
    console.log(text.slice(0, 400));
  } catch (err) {
    console.log(`\n== ${p} -> ERROR ${err.message}`);
  }
}
