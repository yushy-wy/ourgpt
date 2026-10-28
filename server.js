import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { loadConfig } from "./lib/config.js";
import { Ledger } from "./lib/ledger.js";
import { SSEParser } from "./lib/sse.js";
import { getAdapter } from "./adapters/index.js";

let config = loadConfig();
const ledger = new Ledger(config.ledgerFile);

function isAllowedSource(ip) {
  if (process.env.ALLOW_ANY === "1") return true;
  const clean = (ip || "").replace(/^::ffff:/, "");
  if (clean === "127.0.0.1" || clean === "::1") return true;
  const [a, b] = clean.split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function authenticate(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!match) return null;
  const key = match[1].trim();
  const rec = config.keys[key];
  return rec ? { key, user: rec.user } : null;
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function decodeBody(req, buf) {
  const enc = (req.headers["content-encoding"] || "").toLowerCase();
  if (!enc) return buf;
  if (enc.includes("gzip")) return zlib.gunzipSync(buf);
  if (enc.includes("deflate")) return zlib.inflateSync(buf);
  if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
  if (enc.includes("zstd") && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buf);
  throw new Error(`unsupported content-encoding: ${enc}`);
}

function log(line) {
  console.log(`${new Date().toISOString()} ${line}`);
}

const startedAt = new Date().toISOString();

function lanIps() {
  const skip = /vmware|vethernet|wsl|loopback|hyper-v|virtualbox|tap|tun/i;
  const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal && priv.test(a.address)) out.push(a.address);
    }
  }
  return out;
}

function isLocalSource(ip) {
  const clean = (ip || "").replace(/^::ffff:/, "");
  return clean === "127.0.0.1" || clean === "::1";
}

async function handleModels(res) {
  const models = [...config.modelIndex.keys()].map((id) => ({
    id,
    object: "model",
    created: 0,
    owned_by: "ourgpt",
  }));
  sendJson(res, 200, { object: "list", data: models });
}

async function handleResponses(req, res) {
  const started = Date.now();
  const auth = authenticate(req);
  if (!auth) {
    sendJson(res, 401, { error: { message: "invalid api key", type: "invalid_request_error" } });
    return;
  }

  let body;
  let raw;
  try {
    raw = await readBody(req);
    body = JSON.parse(decodeBody(req, raw).toString("utf8"));
  } catch (err) {
    const b = raw || Buffer.alloc(0);
    log(
      `400 bad body: ${err.message} len=${b.length} cl=${req.headers["content-length"] || "-"} te=${req.headers["transfer-encoding"] || "-"} head=${JSON.stringify(b.slice(0, 160).toString("utf8"))} mid=${JSON.stringify(b.slice(41560, 41760).toString("utf8"))}`,
    );
    sendJson(res, 400, { error: { message: `bad request: ${err.message}`, type: "invalid_request_error" } });
    return;
  }

  const upstream = config.modelIndex.get(body.model);
  if (!upstream) {
    sendJson(res, 404, { error: { message: `unknown model: ${body.model}`, type: "invalid_request_error" } });
    return;
  }

  const entry = {
    ts: new Date().toISOString(),
    user: auth.user,
    key: `…${auth.key.slice(-4)}`,
    upstream: upstream.name,
    model: body.model,
    status: 0,
    usage: null,
    duration_ms: 0,
    error: null,
  };

  const upstreamAbort = new AbortController();
  res.on("close", () => upstreamAbort.abort());

  let upstreamRes;
  try {
    upstreamRes = await getAdapter(upstream.adapter).chat({
      body,
      upstream,
      signal: upstreamAbort.signal,
    });
  } catch (err) {
    entry.status = 502;
    entry.error = String(err.message || err);
    entry.duration_ms = Date.now() - started;
    ledger.write(entry);
    log(`502 ${auth.user} ${body.model} ${entry.error}`);
    if (!res.headersSent) sendJson(res, 502, { error: { message: entry.error, type: "upstream_error" } });
    return;
  }

  const streaming = body.stream !== false;
  if (!streaming || upstreamRes.status !== 200) {
    const text = await upstreamRes.text();
    entry.status = upstreamRes.status;
    entry.duration_ms = Date.now() - started;
    if (upstreamRes.status !== 200) entry.error = text.slice(0, 500);
    else {
      try {
        entry.usage = JSON.parse(text)?.usage || null;
      } catch {
        entry.error = "non-json upstream body";
      }
    }
    ledger.write(entry);
    log(`${entry.status} ${auth.user} ${upstream.name} ${body.model} ${entry.duration_ms}ms`);
    res.writeHead(upstreamRes.status, {
      "content-type": upstreamRes.headers.get("content-type") || "application/json",
    });
    res.end(text);
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const decoder = new TextDecoder();
  const parser = new SSEParser((event) => {
    if (event.type === "response.completed" && event.response?.usage) entry.usage = event.response.usage;
    if (event.type === "response.failed") entry.error = JSON.stringify(event.response?.error || {}).slice(0, 500);
  });

  let bytes = 0;
  try {
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      res.write(Buffer.from(value));
      parser.push(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    if (!entry.error) entry.error = `stream broken: ${String(err.message || err)}`;
  }

  entry.status = entry.error ? 502 : 200;
  entry.duration_ms = Date.now() - started;
  ledger.write(entry);
  log(`${entry.status} ${auth.user} ${upstream.name} ${body.model} ${bytes}B ${entry.duration_ms}ms`);
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const remote = req.socket.remoteAddress || "";
  if (!isAllowedSource(remote)) {
    log(`403 ${remote} ${req.method} ${url.pathname}`);
    sendJson(res, 403, { error: { message: "forbidden: source address not in LAN allowlist" } });
    return;
  }
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, models: [...config.modelIndex.keys()] });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      await handleModels(res);
      return;
    }
    if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
      await handleResponses(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/ledger") {
      sendJson(res, 200, {
        summary: ledger.summary({ user: url.searchParams.get("user") || undefined, date: url.searchParams.get("date") || undefined }),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/reload-models") {
      await refreshDynamicModels();
      sendJson(res, 200, { models: [...config.modelIndex.keys()] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/entries") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 100), 1000);
      const user = url.searchParams.get("user") || undefined;
      const date = url.searchParams.get("date") || undefined;
      const entries = ledger
        .readAll()
        .filter((e) => (!user || e.user === user) && (!date || String(e.ts || "").startsWith(date)))
        .slice(-limit)
        .reverse();
      sendJson(res, 200, { entries });
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/info") {
      const ips = lanIps();
      sendJson(res, 200, {
        port: config.port,
        ips,
        baseUrls: ips.map((ip) => `http://${ip}:${config.port}/v1`),
        startedAt,
        upstreams: Object.entries(config.upstreams).map(([name, up]) => ({ name, adapter: up.adapter })),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/models") {
      const groups = [];
      for (const [name, up] of Object.entries(config.upstreams)) {
        let caps = {};
        try {
          caps = getAdapter(up.adapter).capabilities || {};
        } catch {}
        groups.push({
          upstream: name,
          adapter: up.adapter,
          tools: caps.tools ?? false,
          streaming: caps.streaming ?? true,
          models: [...config.modelIndex.entries()].filter(([, u]) => u.name === name).map(([m]) => m),
        });
      }
      sendJson(res, 200, { groups });
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/keys") {
      if (!isLocalSource(remote)) {
        sendJson(res, 403, { error: { message: "keys are only visible from this machine" } });
        return;
      }
      sendJson(res, 200, {
        keys: Object.entries(config.keys).map(([k, v]) => ({
          masked: `${k.slice(0, 12)}…${k.slice(-4)}`,
          user: v.user,
          createdAt: v.createdAt || null,
        })),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/admin/keys") {
      if (!isLocalSource(remote)) {
        sendJson(res, 403, { error: { message: "keys can only be created from this machine" } });
        return;
      }
      let body;
      try {
        body = JSON.parse(decodeBody(req, await readBody(req)).toString("utf8"));
      } catch {
        sendJson(res, 400, { error: { message: "bad json body" } });
        return;
      }
      const user = String(body.user || "").trim();
      if (!/^[a-z0-9_-]{2,24}$/i.test(user)) {
        sendJson(res, 400, { error: { message: "user must be 2-24 chars: a-z 0-9 _ -" } });
        return;
      }
      const key = `sk-ourgpt-${user.toLowerCase()}-${crypto.randomBytes(6).toString("hex")}`;
      const keysFile = path.join(config.root, "config", "keys.json");
      const next = { ...config.keys, [key]: { user: user.toLowerCase(), createdAt: new Date().toISOString() } };
      fs.writeFileSync(keysFile + ".tmp", JSON.stringify(next, null, 2) + "\n");
      fs.renameSync(keysFile + ".tmp", keysFile);
      config = { ...config, keys: loadConfig().keys };
      log(`key created for ${user.toLowerCase()}`);
      sendJson(res, 200, {
        key,
        user: user.toLowerCase(),
        baseUrls: lanIps().map((ip) => `http://${ip}:${config.port}/v1`),
      });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(config.root, "public", "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
  } catch (err) {
    log(`500 ${req.method} ${url.pathname} ${err.stack || err}`);
    if (!res.headersSent) sendJson(res, 500, { error: { message: String(err.message || err) } });
    else res.end();
  }
});

async function refreshDynamicModels() {
  for (const [name, up] of Object.entries(config.upstreams)) {
    if (!up.dynamic_models) continue;
    try {
      const models = await getAdapter(up.adapter).listModels?.();
      if (!models?.length) continue;
      let added = 0;
      for (const m of models) {
        if (!config.modelIndex.has(m)) {
          config.modelIndex.set(m, { ...up, name });
          added++;
        }
      }
      log(`dynamic models[${name}]: +${added} (total ${models.length})`);
    } catch (err) {
      log(`dynamic models[${name}] failed: ${err.message}`);
    }
  }
}

let reloadTimer = null;
try {
  fs.watch(path.join(config.root, "config", "keys.json"), () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        config = { ...config, keys: loadConfig().keys };
        log(`config reloaded: ${Object.keys(config.keys).length} keys`);
      } catch (err) {
        log(`config reload failed: ${err.message}`);
      }
    }, 120);
  });
} catch (err) {
  log(`config watch unavailable: ${err.message}`);
}

server.listen(config.port, config.host, () => {
  log(`OurGPT listening on http://${config.host}:${config.port}`);
  log(`models: ${[...config.modelIndex.keys()].join(", ")}`);
  const ips = lanIps();
  log(`LAN: ${ips.length ? ips.map((ip) => `http://${ip}:${config.port}/`).join("  ") : "(no private LAN ip detected)"}`);
  refreshDynamicModels();
});
