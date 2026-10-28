import fs from "node:fs";
import path from "node:path";

export class Ledger {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  write(entry) {
    fs.appendFileSync(this.file, JSON.stringify(entry) + "\n");
  }

  readAll() {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  summary({ user, date } = {}) {
    const rows = new Map();
    for (const e of this.readAll()) {
      if (user && e.user !== user) continue;
      const day = e.ts ? new Date(e.ts).toLocaleDateString("sv-SE") : "";
      if (date && day !== date) continue;
      const k = `${e.user}\u0000${day}`;
      const r = rows.get(k) || {
        user: e.user,
        date: day,
        requests: 0,
        errors: 0,
        input_tokens: 0,
        output_tokens: 0,
        by_upstream: {},
      };
      r.requests += 1;
      if (e.status !== 200) r.errors += 1;
      r.input_tokens += e.usage?.input_tokens || 0;
      r.output_tokens += e.usage?.output_tokens || 0;
      const up = (r.by_upstream[e.upstream] ||= { requests: 0, input_tokens: 0, output_tokens: 0 });
      up.requests += 1;
      up.input_tokens += e.usage?.input_tokens || 0;
      up.output_tokens += e.usage?.output_tokens || 0;
      rows.set(k, r);
    }
    return [...rows.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  }
}
