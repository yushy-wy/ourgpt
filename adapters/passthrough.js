export default {
  name: "passthrough",
  capabilities: { responses: true, tools: true, streaming: true, stateful: false },

  async chat({ body, upstream, signal }) {
    const key = process.env[upstream.api_key_env];
    if (!key) throw new Error(`missing env ${upstream.api_key_env}`);

    const payload = { ...body };
    // DeepSeek 的 Responses 实现是无状态的，这些字段它不接受
    delete payload.previous_response_id;
    delete payload.conversation;
    if ("store" in payload) payload.store = false;

    const url = `${upstream.base_url.replace(/\/+$/, "")}/responses`;
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: body.stream ? "text/event-stream" : "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
      signal,
    });
  },
};
