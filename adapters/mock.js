function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function lastUserText(input) {
  if (typeof input === "string") return input;
  const items = Array.isArray(input) ? input : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.role === "user") {
      if (typeof it.content === "string") return it.content;
      const parts = Array.isArray(it.content) ? it.content : [];
      const text = parts.filter((p) => p?.type === "input_text" || p?.type === "text").map((p) => p.text).join("");
      if (text) return text;
    }
    if (it?.type === "function_call_output") return "__TOOL_OUTPUT__";
  }
  return "";
}

function pickTool(body) {
  const names = (Array.isArray(body.tools) ? body.tools : []).map((t) => t?.name).filter(Boolean);
  return names.includes("get_goal") ? "get_goal" : names[0] || "shell";
}

export default {
  name: "mock",
  capabilities: { responses: true, tools: true, streaming: true, stateful: false },

  async chat({ body }) {
    console.log(`[mock] tools=${(body.tools || []).map((t) => t?.name || t?.type).join("|")}`);
    const wantsTools = body.model === "mock-tools";
    const said = lastUserText(body.input);
    const done = said === "__TOOL_OUTPUT__";

    let text;
    let toolCall = null;
    if (wantsTools && !done) {
      const name = pickTool(body);
      toolCall = {
        name,
        arguments: name === "get_goal" ? "{}" : JSON.stringify({ cmd: "echo mock-ok" }),
      };
      text = "";
    } else {
      text = done
        ? "Mock upstream: tool call completed, task done."
        : `Mock upstream received: ${String(said).slice(0, 200)}`;
    }

    const now = Math.floor(Date.now() / 1000);
    const id = `resp_mock_${Date.now().toString(36)}`;
    const usage = { input_tokens: 42, output_tokens: 7, total_tokens: 49 };

    const baseResponse = {
      id,
      object: "response",
      created_at: now,
      status: "in_progress",
      model: body.model,
      output: [],
      parallel_tool_calls: true,
      tool_choice: "auto",
      tools: [],
    };

    if (body.stream === false) {
      const item = toolCall
        ? {
            id: `fc_${Date.now().toString(36)}`,
            type: "function_call",
            status: "completed",
            arguments: toolCall.arguments,
            call_id: `call_${Date.now().toString(36)}`,
            name: toolCall.name,
          }
        : {
            id: `msg_${Date.now().toString(36)}`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
          };
      return new Response(JSON.stringify({ ...baseResponse, status: "completed", output: [item], usage }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const chunks = [];
    chunks.push(sse("response.created", { type: "response.created", response: baseResponse }));
    chunks.push(sse("response.in_progress", { type: "response.in_progress", response: baseResponse }));

    if (toolCall) {
      const item = {
        id: `fc_${Date.now().toString(36)}`,
        type: "function_call",
        status: "in_progress",
        arguments: "",
        call_id: `call_${Date.now().toString(36)}`,
        name: toolCall.name,
      };
      chunks.push(sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item }));
      chunks.push(
        sse("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: 0,
          delta: toolCall.arguments,
        }),
      );
      chunks.push(
        sse("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: 0,
          arguments: toolCall.arguments,
        }),
      );
      const finished = { ...item, status: "completed", arguments: toolCall.arguments };
      chunks.push(sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: finished }));
      chunks.push(
        sse("response.completed", {
          type: "response.completed",
          response: { ...baseResponse, status: "completed", output: [finished], usage },
        }),
      );
    } else {
      const itemId = `msg_${Date.now().toString(36)}`;
      chunks.push(
        sse("response.output_item.added", {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
        }),
      );
      chunks.push(
        sse("response.content_part.added", {
          type: "response.content_part.added",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      );
      chunks.push(
        sse("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: text,
        }),
      );
      chunks.push(
        sse("response.output_text.done", {
          type: "response.output_text.done",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          text,
        }),
      );
      chunks.push(
        sse("response.content_part.done", {
          type: "response.content_part.done",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text, annotations: [] },
        }),
      );
      const item = {
        id: itemId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      chunks.push(sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }));
      chunks.push(
        sse("response.completed", {
          type: "response.completed",
          response: { ...baseResponse, status: "completed", output: [item], usage },
        }),
      );
    }

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) {
          controller.enqueue(enc.encode(c));
          await new Promise((r) => setTimeout(r, 15));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  },
};
