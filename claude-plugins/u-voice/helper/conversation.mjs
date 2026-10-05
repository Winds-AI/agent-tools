/**
 * Transcript/history handling adapted from the read-only Pi voice reference
 * at pi-voice/mac/src/conversation.mjs.
 */
export function cleanText(text) {
  return String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

export function transcriptDelta(event) {
  if (event?.type === "input_transcript.added" && typeof event.item?.text === "string") {
    return { role: "U", delta: event.item.text };
  }
  if (event?.type === "output_transcript.added" && typeof event.item?.text === "string") {
    return { role: "A", delta: event.item.text };
  }
  return undefined;
}

export class Conversation {
  constructor() {
    this.fragments = [];
    this.nextSequence = 1;
    this.totalBytes = 0;
  }

  add(event, sessionId) {
    const delta = transcriptDelta(event);
    if (!delta) return undefined;
    const fragment = {
      role: delta.role,
      delta: cleanText(delta.delta),
      sessionId,
      sequence: this.nextSequence++,
    };
    this.fragments.push(fragment);
    this.totalBytes += Buffer.byteLength(fragment.delta);
    while (this.fragments.length > 1200 || this.totalBytes > 120_000) {
      const removed = this.fragments.shift();
      this.totalBytes -= Buffer.byteLength(removed.delta);
    }
    return fragment;
  }

  rows(fragments = this.fragments) {
    const rows = [];
    for (const fragment of [...fragments].sort((a, b) => a.sequence - b.sequence)) {
      const last = rows.at(-1);
      if (last && last.role === fragment.role && last.sessionId === fragment.sessionId) {
        last.text += fragment.delta;
      } else {
        rows.push({ role: fragment.role, text: fragment.delta, sessionId: fragment.sessionId });
      }
    }
    return rows.filter((row) => row.text.trim());
  }

  text(fragments = this.fragments) {
    return this.rows(fragments).map((row) => row.role + ": " + row.text.trim()).join("\n");
  }

  history(latestFinal = "") {
    const rows = this.rows();
    if (latestFinal) {
      rows.push({
        role: "A",
        text: "Claude Code's latest result (reference only; full answer is in the terminal):\n" + latestFinal,
      });
    }
    let bytes = 0;
    const kept = [];
    for (let index = rows.length - 1; index >= 0 && kept.length < 60; index--) {
      let text = rows[index].text;
      const available = 6000 - bytes;
      if (available < 100) break;
      while (Buffer.byteLength(text) > available) {
        text = text.slice(Math.max(1, Math.floor(text.length / 8)));
      }
      bytes += Buffer.byteLength(text);
      kept.unshift({
        type: "message",
        role: rows[index].role === "U" ? "user" : "assistant",
        content: [{ type: rows[index].role === "U" ? "input_text" : "output_text", text }],
      });
    }
    return kept;
  }
}

export function contextChunks(text, maxBytes = 400) {
  const chunks = [];
  let chunk = "";
  for (const character of cleanText(text)) {
    if (Buffer.byteLength(chunk + character) > maxBytes) {
      if (chunk) chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
