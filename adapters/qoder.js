import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const STRIP_ENV = [
  "QODER_AGENT_SDK_ENTRYPOINT",
  "QODER_AGENT_SDK_DAEMON",
  "QODER_AGENT_SDK_VERSION",
  "QODER_SDK_AUTH_PAYLOAD_FILE",
];

function cliEnv() {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  return env;
}

function cliCommand() {
  const bundle =
    process.env.QODER_CLI_BUNDLE ||
    (process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "@qodercn-ai", "qoderclicn", "bundle", "qoderclicn.js")
      : "");
  if (bundle && fs.existsSync(bundle)) return { cmd: process.execPath, prefix: [bundle] };
  return { cmd: "qodercn", prefix: [] };
}

function spawnCli(args, signal) {
  const { cmd, prefix } = cliCommand();
  const child = spawn(cmd, [...prefix, ...args], {
    shell: prefix.length === 0 && process.platform === "win32",
    windowsHide: true,
    env: cliEnv(),
  });
  const onAbort = () => child.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  const cleanup = () => signal?.removeEventListener("abort", onAbort);
  return { child, cleanup };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p?.type === "input_text" || p?.type === "output_text" || p?.type === "text" ? p.text || "" : ""))
    .join("");
}

function flattenRequest(body) {
  const parts = [];
  if (body.instructions) parts.push(body.instructions);
  const input = body.input;
  if (typeof input === "string") {
    parts.push(input);
  } else if (Array.isArray(input)) {
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

export function createResponseStream({ child, cleanup }, model, responseId) {
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

      const itemId = `msg_${Math.random().toString(36).slice(2, 10)}`;
      let sent = "";
      let started = false;
      let usage = null;
      let credits = null;
      let error = null;
      let finalText = "";

      const startItem = () => {
        if (started) return;
        started = true;
        send("response.output_item.added", {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
        });
        send("response.content_part.added", {
          type: "response.content_part.added",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      };

      const pushChunk = (text) => {
        if (!text || text === sent) return;
        let delta;
        if (sent && text.startsWith(sent)) {
          delta = text.slice(sent.length);
          sent = text;
        } else if (sent && sent.endsWith(text)) {
          return;
        } else {
          delta = text;
          sent += text;
        }
        if (!delta) return;
        startItem();
        send("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta });
      };

      const handleLine = (line) => {
        if (!line.trim()) return;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
          const text = ev.message.content.filter((p) => p?.type === "text").map((p) => p.text || "").join("");
          if (text) pushChunk(text);
        } else if (ev.type === "result") {
          if (ev.is_error) error = (ev.errors || []).join("; ") || ev.subtype || "qoder cli error";
          if (typeof ev.result === "string" && ev.result) finalText = ev.result;
          if (ev.usage) {
            usage = {
              input_tokens: ev.usage.input_tokens ?? 0,
              output_tokens: ev.usage.output_tokens ?? 0,
              total_tokens: (ev.usage.input_tokens ?? 0) + (ev.usage.output_tokens ?? 0),
            };
          }
          if (typeof ev.total_credits === "number") credits = ev.total_credits;
        }
      };

      try {
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of child.stdout) {
          buf += decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            handleLine(buf.slice(0, idx).trim());
            buf = buf.slice(idx + 1);
          }
        }
        if (buf.trim()) handleLine(buf.trim());
        await new Promise((resolve) => (child.exitCode != null ? resolve() : child.once("close", resolve)));
      } catch (err) {
        error = String(err.message || err);
      } finally {
        cleanup();
      }

      if (!sent && finalText) pushChunk(finalText);

      if (error) {
        send("response.failed", {
          type: "response.failed",
          response: { ...base, status: "failed", error: { message: error, type: "upstream_error" }, output: [] },
        });
        controller.close();
        return;
      }

      if (started) {
        send("response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text: sent });
        send("response.content_part.done", {
          type: "response.content_part.done",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: sent, annotations: [] },
        });
        send("response.output_item.done", {
          type: "response.output_item.done",
          output_index: 0,
          item: { id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: sent, annotations: [] }] },
        });
      }

      const output = started
        ? [{ id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: sent, annotations: [] }] }]
        : [];

      send("response.completed", {
        type: "response.completed",
        response: {
          ...base,
          status: "completed",
          output,
          usage: usage ? { ...usage, credits } : { input_tokens: 0, output_tokens: 0, total_tokens: 0, credits },
        },
      });
      controller.close();
    },
  });
}

export async function listQoderModels(signal) {
  const { child, cleanup } = spawnCli(["--list-models"], signal);
  let out = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of child.stdout) out += decoder.decode(chunk, { stream: true });
    await new Promise((resolve) => (child.exitCode != null ? resolve() : child.once("close", resolve)));
  } finally {
    cleanup();
  }
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== "MODEL");
}

export default {
  name: "qoder",
  capabilities: { responses: true, tools: false, streaming: true, stateful: false },

  async listModels() {
    return listQoderModels();
  },

  async chat({ body, signal }) {
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--tools",
      "",
      "--no-session-persistence",
      "--permission-mode",
      "dont_ask",
    ];
    if (body.model && body.model !== "auto") args.push("--model", body.model);

    const task = spawnCli(args, signal);
    const responseId = `resp_qoder_${Date.now().toString(36)}`;

    const input = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: flattenRequest(body) }] },
    };
    task.child.stdin.on("error", () => {});
    task.child.stdin.write(JSON.stringify(input) + "\n");
    task.child.stdin.end();

    if (body.stream === false) {
      const reader = createResponseStream(task, body.model, responseId).getReader();
      const dec = new TextDecoder();
      let all = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        all += dec.decode(value, { stream: true });
      }
      const at = all.lastIndexOf("event: response.completed");
      const line = at >= 0 ? all.slice(at).split("\n").find((l) => l.startsWith("data: ")) : null;
      const payload = line
        ? JSON.parse(line.slice(6))
        : { response: { id: responseId, object: "response", status: "completed", model: body.model, output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
      return new Response(JSON.stringify(payload.response), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response(createResponseStream(task, body.model, responseId), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  },
};
