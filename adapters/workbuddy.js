import { readWorkBuddyTokens } from "../scripts/workbuddy-auth.mjs";

const ENDPOINT = "https://copilot.tencent.com/v2/chat/completions";
const MODELS_ENDPOINT = "https://copilot.tencent.com/v2/enterprises/personal/models";
const USER_AGENT = "WorkBuddy/2.165.0";

let tokenCache = null;

async function accessToken() {
  if (tokenCache && tokenCache.expiresAt - 60_000 > Date.now()) return tokenCache.accessToken;
  const t = await readWorkBuddyTokens();
  tokenCache = { accessToken: t.accessToken, expiresAt: t.expiresAt || Date.now() + 10 * 60_000 };
  return t.accessToken;
}

function contentParts(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const p of content) {
    if (p?.type === "input_text" || p?.type === "output_text" || p?.type === "text") parts.push({ type: "text", text: p.text ?? "" });
    else if (p?.type === "input_image" && p.image_url) parts.push({ type: "image_url", image_url: { url: p.image_url } });
  }
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

const BLOCKED_TERMS = [
  [/Codex CLI/g, "the CLI agent"],
  [/Codex/g, "the agent"],
  [/OpenAI/g, "the provider"],
];

function sanitize(value) {
  if (typeof value === "string") return BLOCKED_TERMS.reduce((s, [re, rep]) => s.replace(re, rep), value);
  if (Array.isArray(value)) return value.map((p) => (p?.type === "text" ? { ...p, text: sanitize(p.text) } : p));
  return value;
}

export function toChatRequest(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      messages.push({ role: "assistant", content: "", tool_calls: pending });
      pending = [];
    };
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "message") {
        flush();
        const role = item.role === "developer" ? "system" : item.role || "user";
        messages.push({ role, content: contentParts(item.content) });
      } else if (item.type === "function_call") {
        pending.push({ id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } });
      } else if (item.type === "function_call_output") {
        flush();
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
        });
      }
    }
    flush();
  }

  for (const m of messages) {
    m.content = sanitize(m.content);
    if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) tc.function.arguments = sanitize(tc.function.arguments);
  }

  const req = { model: body.model, messages, stream: true };
  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = body.tools
      .filter((t) => t?.type === "function" && t.name)
      .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (!req.tools.length) delete req.tools;
  }
  if (body.tool_choice !== undefined && req.tools) {
    req.tool_choice = typeof body.tool_choice === "string" ? body.tool_choice : body.tool_choice?.name || "auto";
  }
  if (body.parallel_tool_calls !== undefined) req.parallel_tool_calls = body.parallel_tool_calls;
  if (body.max_output_tokens) req.max_tokens = body.max_output_tokens;
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  return req;
}

function mapUsage(u) {
  if (!u) return null;
  return {
    input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.prompt_tokens || 0) + (u.completion_tokens || 0),
  };
}

export function createResponseStream(upstreamBody, model, responseId) {
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const base = {
    id: responseId,
    object: "response",
    created_at: now,
    model,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
  };

  return new ReadableStream({
    async start(controller) {
      const send = (event, data) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      send("response.created", { type: "response.created", response: { ...base, status: "in_progress", output: [] } });
      send("response.in_progress", { type: "response.in_progress", response: { ...base, status: "in_progress", output: [] } });

      const output = [];
      let outIndex = 0;
      let text = "";
      let textItem = null;
      const tools = new Map();
      let usage = null;
      let finishReason = null;

      const closeText = () => {
        if (!textItem) return;
        send("response.output_text.done", { type: "response.output_text.done", item_id: textItem.id, output_index: textItem.index, content_index: 0, text });
        send("response.content_part.done", {
          type: "response.content_part.done",
          item_id: textItem.id,
          output_index: textItem.index,
          content_index: 0,
          part: { type: "output_text", text, annotations: [] },
        });
        const item = { id: textItem.id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
        send("response.output_item.done", { type: "response.output_item.done", output_index: textItem.index, item });
        output.push(item);
        textItem = null;
      };

      const reader = upstreamBody.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
            const raw = buf.slice(0, cut);
            buf = buf.slice(cut + (buf[cut] === "\r" ? 4 : 2));
            const line = raw.split(/\r?\n/).find((l) => l.startsWith("data:"));
            if (!line) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let chunk;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }
            if (chunk.usage) usage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta || {};

            if (delta.content) {
              if (!textItem) {
                closeToolItems(false);
                const id = `msg_${Math.random().toString(36).slice(2, 10)}`;
                textItem = { id, index: outIndex++ };
                send("response.output_item.added", {
                  type: "response.output_item.added",
                  output_index: textItem.index,
                  item: { id, type: "message", status: "in_progress", role: "assistant", content: [] },
                });
                send("response.content_part.added", {
                  type: "response.content_part.added",
                  item_id: id,
                  output_index: textItem.index,
                  content_index: 0,
                  part: { type: "output_text", text: "", annotations: [] },
                });
              }
              text += delta.content;
              send("response.output_text.delta", {
                type: "response.output_text.delta",
                item_id: textItem.id,
                output_index: textItem.index,
                content_index: 0,
                delta: delta.content,
              });
            }

            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
              closeText();
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                let entry = tools.get(idx);
                if (!entry) {
                  entry = { id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: "", args: "", index: outIndex++, started: false };
                  tools.set(idx, entry);
                }
                if (tc.function?.name) entry.name += tc.function.name;
                if (!entry.started && entry.name) {
                  entry.started = true;
                  send("response.output_item.added", {
                    type: "response.output_item.added",
                    output_index: entry.index,
                    item: { id: `fc_${entry.id}`, type: "function_call", status: "in_progress", arguments: "", call_id: entry.id, name: entry.name },
                  });
                }
                if (tc.function?.arguments) {
                  entry.args += tc.function.arguments;
                  send("response.function_call_arguments.delta", {
                    type: "response.function_call_arguments.delta",
                    item_id: `fc_${entry.id}`,
                    output_index: entry.index,
                    delta: tc.function.arguments,
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        closeText();
        for (const [, e] of tools) closeTool(e);
        send("response.failed", {
          type: "response.failed",
          response: { ...base, status: "failed", output, error: { message: String(err.message || err), type: "upstream_error" } },
        });
        controller.close();
        return;
      }

      function closeTool(e) {
        send("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: `fc_${e.id}`,
          output_index: e.index,
          arguments: e.args,
        });
        const item = { id: `fc_${e.id}`, type: "function_call", status: "completed", arguments: e.args, call_id: e.id, name: e.name };
        send("response.output_item.done", { type: "response.output_item.done", output_index: e.index, item });
        output.push(item);
      }

      function closeToolItems(all) {
        if (!all) return;
        for (const [, e] of tools) closeTool(e);
        tools.clear();
      }

      closeText();
      closeToolItems(true);
      output.sort((a, b) => 0);

      send("response.completed", {
        type: "response.completed",
        response: {
          ...base,
          status: "completed",
          output,
          usage: mapUsage(usage) || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          incomplete_details: finishReason === "length" ? { reason: "max_output_tokens" } : null,
        },
      });
      controller.close();
    },
  });
}

export async function listWorkBuddyModels() {
  const token = await accessToken();
  const res = await fetch(MODELS_ENDPOINT, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`models endpoint HTTP ${res.status}`);
  const j = await res.json();
  const models = new Set();
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    for (const [k, v] of Object.entries(o)) {
      if (k === "models" && Array.isArray(v)) v.forEach((m) => typeof m === "string" && models.add(m));
      else walk(v);
    }
  };
  walk(j);
  return [...models];
}

export default {
  name: "workbuddy",

  async listModels() {
    return listWorkBuddyModels();
  },

  capabilities: { responses: false, tools: true, streaming: true, stateful: false },

  async chat({ body, upstream, signal }) {
    const token = await accessToken();
    const req = toChatRequest({ ...body, model: body.model });
    console.log(
      "[workbuddy] shape:" +
        JSON.stringify({
          roles: req.messages.map((m) => m.role),
          tools: (req.tools || []).map((t) => t.function.name),
          keys: Object.keys(req),
          sysLen: typeof req.messages[0]?.content === "string" ? req.messages[0].content.length : 0,
          toolNames: (req.messages.find((m) => m.tool_calls)?.tool_calls || []).map((t) => t.function.name),
        }),
    );
    const res = await fetch(upstream.endpoint || ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(req),
      signal,
    });

    if (!res.ok) return res;

    const id = `resp_wb_${Date.now().toString(36)}`;

    if (body.stream === false) {
      const reader = createResponseStream(res.body, body.model, id).getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      const at = buf.lastIndexOf("event: response.completed");
      const line = at >= 0 ? buf.slice(at).split("\n").find((l) => l.startsWith("data: ")) : null;
      const payload = line
        ? JSON.parse(line.slice(6))
        : { response: { id, object: "response", status: "completed", model: body.model, output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
      return new Response(JSON.stringify(payload.response), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response(createResponseStream(res.body, body.model, id), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  },
};
