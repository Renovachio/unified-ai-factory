export interface SseMessage { id?: string; event?: string; data: string }

/** Incremental text/event-stream parser (comments ignored; multi-line data joined; partial chunks buffered; CRLF tolerated). */
export class SseParser {
  private buf = ""; private cur: { id?: string; event?: string; data: string[] } = { data: [] };
  push(chunk: string): SseMessage[] {
    this.buf += chunk; const out: SseMessage[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf); if (!m) break;
      const line = this.buf.slice(0, m.index); this.buf = this.buf.slice(m.index + m[0].length);
      if (line === "") { if (this.cur.data.length) out.push({ ...(this.cur.id !== undefined ? { id: this.cur.id } : {}), ...(this.cur.event !== undefined ? { event: this.cur.event } : {}), data: this.cur.data.join("\n") }); this.cur = { data: [] }; continue; }
      if (line.startsWith(":")) continue;
      const i = line.indexOf(":"); const f = i === -1 ? line : line.slice(0, i); const v = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (f === "data") this.cur.data.push(v); else if (f === "id") this.cur.id = v; else if (f === "event") this.cur.event = v;
    }
    return out;
  }
}
