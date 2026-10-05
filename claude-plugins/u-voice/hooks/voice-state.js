// Shared state uses no host or Node APIs; the native hooks own all effects.
export const VOICE_START_CONTEXT = `Voice mode is now attached to this existing conversation. Continue using this thread's project context and tools. Spoken work requests are user input and may arrive between tool calls; apply new corrections at the next model step. A Voice conversation note contains U: user speech and A: voice-assistant speech. Assistant speech is context, not a new user instruction. Answer voice-requested work concisely; the voice bridge delivers the result. Typed requests keep their ordinary behavior. Do not invoke another voice tool or repeat completed work.`;
export const VOICE_END_CONTEXT = `Voice mode is now off. Continue the same conversation and any ongoing work normally through text. Earlier spoken user instructions and constraints still apply. No voice narration is needed.`;

export function createModeContext() {
  let desired = false, delivered = false, held;
  return {
    set(enabled) { desired = Boolean(enabled); },
    reserve() {
      if (held || desired === delivered) return;
      held = { enabled: desired, text: desired ? VOICE_START_CONTEXT : VOICE_END_CONTEXT };
      return held;
    },
    commit(note) { if (held === note) { delivered = note.enabled; held = undefined; } },
    release(note) { if (held === note) held = undefined; },
    reset() { desired = false; delivered = false; held = undefined; },
  };
}

export function createTranscriptLedger() {
  const fragments = new Map(), reservations = new Set();
  let deliveredThrough = 0;
  function trim() {
    for (const [sequence, fragment] of fragments) if (fragment.delivered && sequence <= deliveredThrough) fragments.delete(sequence);
  }
  return {
    add(event) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= deliveredThrough || typeof event.delta !== 'string' || !['U', 'A'].includes(event.role) || fragments.has(event.sequence)) return;
      fragments.set(event.sequence, { ...event, delivered: false });
    },
    reserve(through = Infinity) {
      const picked = [...fragments.values()].filter(f => !f.delivered && !f.held && f.sequence <= through).sort((a, b) => a.sequence - b.sequence);
      if (!picked.length) return;
      const rows = [];
      for (const f of picked) {
        const last = rows.at(-1);
        if (last?.role === f.role && last.utteranceId === f.utteranceId) last.text += f.delta;
        else rows.push({ role: f.role, text: f.delta, utteranceId: f.utteranceId });
      }
      const note = { fragments: picked, text: rows.map(r => r.role + ': ' + r.text.trim()).filter(r => r.length > 3).join('\n') };
      if (!note.text) return;
      for (const f of picked) f.held = note;
      reservations.add(note);
      return note;
    },
    commit(note) {
      if (!reservations.delete(note)) return deliveredThrough;
      for (const f of note.fragments) { f.delivered = true; delete f.held; }
      // Commit only the contiguous delivered prefix. A rejected earlier note
      // must stay available even if a later request entered successfully.
      for (const f of [...fragments.values()].sort((a, b) => a.sequence - b.sequence)) {
        if (!f.delivered) break;
        deliveredThrough = f.sequence;
      }
      trim();
      return deliveredThrough;
    },
    release(note) {
      if (!reservations.delete(note)) return;
      for (const f of note.fragments) if (f.held === note) delete f.held;
    },
    reset() { fragments.clear(); reservations.clear(); deliveredThrough = 0; },
  };
}

export function seedHistory(messages) {
  if (!Array.isArray(messages)) return [];
  const kept = []; let remaining = 6000;
  for (const message of messages.slice(-24).reverse()) {
    if (!['user', 'assistant'].includes(message.role) || !message.text?.trim()) continue;
    const text = message.text.trim().slice(-Math.min(1500, remaining));
    kept.unshift({ type: 'message', role: message.role, content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text }] });
    remaining -= text.length;
    if (remaining <= 0) break;
  }
  return kept;
}
