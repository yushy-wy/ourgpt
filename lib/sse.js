export class SSEParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buf = "";
  }

  push(text) {
    this.buf += text;
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buf))) {
      const raw = this.buf.slice(0, match.index);
      this.buf = this.buf.slice(match.index + match[0].length);
      this.dispatch(raw);
    }
  }

  dispatch(raw) {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      this.onEvent({ type: "done" });
      return;
    }
    try {
      this.onEvent(JSON.parse(data));
    } catch {
      // 上游偶尔会发非 JSON 的心跳，忽略即可
    }
  }
}
