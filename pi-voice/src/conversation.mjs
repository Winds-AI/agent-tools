/** @typedef {{role: "U" | "A", delta: string, sequence: number, sessionId?: string, start_ms?: number, end_ms?: number}} Fragment */

export function cleanText(text) {
  return String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

export class Conversation {
  constructor(fragments = /** @type {Fragment[]} */ ([])) {
    this.fragments = fragments
      .filter(
        (f) =>
          f &&
          (f.role === "U" || f.role === "A") &&
          typeof f.delta === "string",
      )
      .map((f) => ({ ...f }));
    this.nextSequence =
      this.fragments.reduce((last, f) => Math.max(last, f.sequence || 0), 0) +
      1;
  }
  add(event, sessionId) {
    const role =
      event.type === "session.input_transcript.delta"
        ? "U"
        : event.type === "session.output_transcript.delta"
          ? "A"
          : undefined;
    if (!role || typeof event.delta !== "string") return;
    const fragment = {
      role,
      delta: cleanText(event.delta),
      start_ms: event.start_ms,
      end_ms: event.end_ms,
      sessionId,
      sequence: this.nextSequence++,
    };
    this.fragments.push(fragment);
    return fragment;
  }
  rows(fragments = this.fragments) {
    // Fragments remain exact and ordered per speaker; temporal groups are display-only.
    const rows = [];
    for (const f of [...fragments].sort((a, b) => {
      if (a.sessionId !== b.sessionId) return a.sequence - b.sequence;
      return (
        (a.start_ms ?? a.sequence) - (b.start_ms ?? b.sequence) ||
        a.sequence - b.sequence
      );
    })) {
      const last = rows.at(-1);
      if (last && last.role === f.role && last.sessionId === f.sessionId)
        last.text += f.delta;
      else rows.push({ role: f.role, text: f.delta, sessionId: f.sessionId });
    }
    return rows.filter((r) => r.text.trim());
  }
  text(fragments = this.fragments) {
    return this.rows(fragments)
      .map((r) => r.role + ": " + r.text.trim())
      .join("\n");
  }
  history(extra = "") {
    const rows = this.rows();
    if (extra)
      rows.push({
        role: "A",
        text:
          "Pi's most recent result (reference only; full answer is in the terminal):\n" +
          extra,
      });
    // Conservative byte budget stays below the API's 8,192-token / 128-message limit.
    let bytes = 0;
    const kept = [];
    for (let i = rows.length - 1; i >= 0 && kept.length < 60; i--) {
      const row = rows[i];
      let text = row.text;
      const available = 6500 - bytes;
      if (available < 100) break;
      while (Buffer.byteLength(text) > available)
        text = text.slice(Math.max(1, Math.floor(text.length / 8)));
      bytes += Buffer.byteLength(text);
      kept.unshift({
        type: "message",
        role: row.role === "U" ? "user" : "assistant",
        content: [
          { type: row.role === "U" ? "input_text" : "output_text", text },
        ],
      });
    }
    return kept;
  }
}
export function contextChunks(text, maxBytes = 400) {
  const chunks = [];
  let chunk = "";
  for (const char of cleanText(text)) {
    if (Buffer.byteLength(chunk + char) > maxBytes) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
