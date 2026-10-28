import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const REFRESH_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

const cache = new Map();

function resolveAuthFile(p) {
  if (!p) return path.join(os.homedir(), ".codex", "auth.json");
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

function jwtExpMs(token) {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const exp = JSON.parse(json).exp;
    return exp ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function readTokens(file) {
  const p = resolveAuthFile(file);
  if (!fs.existsSync(p)) {
    throw new Error(`no ChatGPT login at ${p} — run "codex login" on a machine that can reach chatgpt.com, then copy auth.json here`);
  }
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  const tokens = data.tokens || {};
  if (!tokens.access_token && !tokens.refresh_token) {
    throw new Error(`${p} has no OAuth tokens (API-key login only?) — ChatGPT subscription proxying needs an OAuth login`);
  }
  return tokens;
}

async function refreshTokens(refreshToken) {
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error(`token refresh returned no access_token: ${text.slice(0, 200)}`);
  return data;
}

async function getAuth(key) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp - 60_000 > now) return hit;

  const tokens = readTokens(key);
  let access = tokens.access_token;
  let accountId = tokens.account_id;
  let exp = access ? jwtExpMs(access) : 0;

  if (!access || exp - 60_000 <= now) {
    if (!tokens.refresh_token) throw new Error("access token expired and no refresh_token available");
    const fresh = await refreshTokens(tokens.refresh_token);
    access = fresh.access_token;
    exp = jwtExpMs(access);
    if (fresh.id_token) {
      try {
        const claims = JSON.parse(Buffer.from(fresh.id_token.split(".")[1], "base64").toString("utf8"));
        const authClaim = claims["https://api.openai.com/auth"] || {};
        accountId = authClaim.chatgpt_account_id || accountId;
      } catch {
        // id_token 解析失败不影响主流程，沿用旧 account_id
      }
    }
  }

  if (!accountId) {
    throw new Error("cannot determine chatgpt_account_id from auth.json or refreshed id_token");
  }

  const entry = { access, accountId, exp: exp || now + 30 * 60_000 };
  cache.set(key, entry);
  return entry;
}

export default {
  name: "chatgpt",
  capabilities: { responses: true, tools: true, streaming: true, stateful: false },

  async chat({ body, upstream, signal }) {
    const auth = await getAuth(upstream.auth_file);

    const payload = { ...body };
    delete payload.previous_response_id;
    delete payload.conversation;

    return fetch(upstream.endpoint || CODEX_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: body.stream === false ? "application/json" : "text/event-stream",
        authorization: `Bearer ${auth.access}`,
        "chatgpt-account-id": auth.accountId,
        "openai-beta": "responses=experimental",
        originator: "codex_cli_rs",
        session_id: crypto.randomUUID(),
        "user-agent": "codex_cli_rs/0.162.1",
      },
      body: JSON.stringify(payload),
      signal,
    });
  },
};
