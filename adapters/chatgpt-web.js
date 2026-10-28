const CDP = process.env.CHATGPT_CDP_URL || "http://127.0.0.1:9222";
const TIMEOUT_MS = Number(process.env.CHATGPT_WEB_TIMEOUT_MS || 60000);

let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function openSession() {
  const targets = await (await fetch(`${CDP}/json`)).json();
  const page = targets.find((t) => t.type === "page" && /chatgpt\.com/.test(t.url));
  if (!page) throw new Error("no chatgpt.com tab on CDP port 9222 — start Chrome with --remote-debugging-port=9222 and log in");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`page eval failed: ${JSON.stringify(r.result.exceptionDetails).slice(0, 200)}`);
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

function cleanReply(text) {
  let t = text || "";
  for (const stop of ["最新一条回复", "回答已完成", "ChatGPT 可能会出错"]) {
    const i = t.indexOf(stop);
    if (i >= 0) t = t.slice(0, i);
  }
  return t.trim();
}

async function ask(prompt) {
  const session = await openSession();
  try {
    await session.send("Page.navigate", { url: "https://chatgpt.com/" });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const ready = await session
        .evaluate("!!document.querySelector('div.ProseMirror') && location.pathname === '/'")
        .catch(() => false);
      if (ready) break;
    }
    const marker = prompt.slice(0, 40);
    const sendPrompt = async () => {
      await session.evaluate("document.querySelector('div.ProseMirror')?.focus()");
      await session.send("Input.insertText", { text: prompt });
      await new Promise((r) => setTimeout(r, 300));
      for (const type of ["keyDown", "keyUp"]) {
        await session.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      }
    };

    await sendPrompt();
    let sent = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const text = await session.evaluate("document.body.innerText || ''");
      if (text.includes("你说：") && text.includes(marker)) {
        sent = true;
        break;
      }
    }
    if (!sent) {
      await sendPrompt();
      await new Promise((r) => setTimeout(r, 5000));
    }

    const deadline = Date.now() + TIMEOUT_MS;
    let reply = "";
    let lastCandidate = "";
    let sameCount = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const now = await session.evaluate("document.body.innerText || ''");
      const mi = now.lastIndexOf(marker);
      if (mi < 0) continue;
      const ci = now.indexOf("ChatGPT 说：", mi);
      if (ci < 0) continue;
      const candidate = cleanReply(now.slice(ci + "ChatGPT 说：".length));
      if (!candidate) continue;
      if (candidate === lastCandidate) sameCount++;
      else {
        lastCandidate = candidate;
        sameCount = 0;
      }
      reply = candidate;
      if (now.includes("回答已完成") || sameCount >= 2) break;
    }
    if (!reply) throw new Error("timed out waiting for the page reply");
    return reply;
  } finally {
    session.close();
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p?.type === "input_text" || p?.type === "output_text" || p?.type === "text" ? p.text || "" : ""))
    .join("");
}

const MAX_INSTRUCTIONS = Number(process.env.CHATGPT_WEB_MAX_INSTRUCTIONS || 4000);

function flattenRequest(body) {
  const parts = [];
  if (body.instructions) {
    parts.push(body.instructions.length > MAX_INSTRUCTIONS ? `${body.instructions.slice(0, MAX_INSTRUCTIONS)}\n[instructions truncated]` : body.instructions);
  }
  const input = body.input;
  if (typeof input === "string") parts.push(input);
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "message") {
        const label = item.role === "assistant" ? "Assistant" : item.role === "system" ? "System" : "User";
        parts.push(`${label}: ${textOf(item.content)}`);
      } else if (item.type === "function_call") {
        parts.push(`Assistant called tool ${item.name} with ${item.arguments || "{}"}`);
      } else if (item.type === "function_call_output") {
        const out = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
        parts.push(`Tool ${item.call_id || ""} returned: ${out}`);
      }
    }
  }
  return parts.join("\n\n");
}

function createResponseStream(replyPromise, model, responseId) {
  const enc = new TextEncoder();
  const base = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
  };
  return new ReadableStream({
    async start(controller) {
      const send = (event, data) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      send("response.created", { type: "response.created", response: { ...base, status: "in_progress", output: [] } });
      send("response.in_progress", { type: "response.in_progress", response: { ...base, status: "in_progress", output: [] } });

      let text;
      try {
        text = await replyPromise;
      } catch (err) {
        send("response.failed", {
          type: "response.failed",
          response: { ...base, status: "failed", error: { message: String(err.message || err), type: "upstream_error" }, output: [] },
        });
        controller.close();
        return;
      }

      const itemId = `msg_${Math.random().toString(36).slice(2, 10)}`;
      send("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] } });
      send("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      send("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: text });
      send("response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text });
      send("response.content_part.done", { type: "response.content_part.done", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } });
      send("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] },
      });
      send("response.completed", {
        type: "response.completed",
        response: {
          ...base,
          status: "completed",
          output: [{ id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      });
      controller.close();
    },
  });
}

export default {
  name: "chatgpt-web",
  capabilities: { responses: true, tools: false, streaming: true, stateful: false },

  async chat({ body }) {
    const prompt = flattenRequest(body);
    const reply = serial(() => ask(prompt));
    const responseId = `resp_web_${Date.now().toString(36)}`;

    if (body.stream === false) {
      let text;
      try {
        text = await reply;
      } catch (err) {
        return new Response(JSON.stringify({ error: { message: String(err.message || err), type: "upstream_error" } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: responseId, object: "response", status: "completed", model: body.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response(createResponseStream(reply, body.model, responseId), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  },
};
