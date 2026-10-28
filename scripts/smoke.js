const BASE = process.env.OURGPT_BASE || "http://127.0.0.1:8080";
const KEY = process.env.OURGPT_KEY || "sk-ourgpt-dev-001";

async function call(model, input, extra = {}) {
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, input, stream: true, ...extra }),
  });
  if (!res.ok) {
    console.log(`FAIL ${model}: HTTP ${res.status} ${await res.text()}`);
    return null;
  }
  const text = await res.text();
  const events = text
    .split(/\r?\n\r?\n/)
    .map((raw) => raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""))
    .filter(Boolean)
    .map((d) => {
      try {
        return JSON.parse(d);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const types = events.map((e) => e.type);
  const completed = events.find((e) => e.type === "response.completed");
  console.log(`OK   ${model}: ${res.status} events=${events.length} ${Date.now() - started}ms`);
  console.log(`     types: ${[...new Set(types)].join(" → ")}`);
  console.log(`     usage: ${JSON.stringify(completed?.response?.usage)}`);
  return { events, completed };
}

console.log("== health");
console.log(await (await fetch(`${BASE}/health`)).text());

console.log("\n== models");
console.log(await (await fetch(`${BASE}/v1/models`)).text());

console.log("\n== text response");
await call("mock-codex", "hello from smoke test");

console.log("\n== tool call response");
const tool = await call("mock-tools", "run a command", {
  tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: { command: { type: "array" } } } }],
});
const fc = tool?.completed?.response?.output?.find((o) => o.type === "function_call");
console.log(`     function_call: ${fc ? `${fc.name} ${fc.arguments}` : "NONE"}`);

console.log("\n== auth rejected (no key)");
const bad = await fetch(`${BASE}/v1/responses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "mock-codex", input: "x" }),
});
console.log(`status=${bad.status} (expect 401)`);

console.log("\n== unknown model");
const unknown = await call("no-such-model", "x");
console.log(unknown === null ? "     rejected as expected" : "     UNEXPECTED");

console.log("\n== ledger");
console.log(await (await fetch(`${BASE}/admin/ledger`)).text());
