import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../server.js';
import { VOICE_SYSTEM_SECTION, createTranscriptLedger } from '../voice-state.js';

async function load() {
  const hooks = {};
  let handlers;
  await plugin.setup({
    rpc: { register: async (_definition, value) => { handlers = value; } },
    session: { hook: async (name, fn) => { hooks[name] = fn; } },
  });
  return { hooks, handlers };
}

test('adds the constant voice section to every request', async () => {
  const { hooks } = await load();
  const event = { system: [] };
  hooks.context(event);
  assert.deepEqual(event.system, [{ type: 'text', text: VOICE_SYSTEM_SECTION }]);
});

test('a typed prompt carries pending speech once, and voice prompts never do', async () => {
  const { hooks, handlers } = await load();
  await handlers.pending({ sessionID: 's1', text: 'U: use the blue one', through: 4 });
  const voice = { sessionID: 's1', prompt: { text: '<voice reason="request">…</voice>' }, metadata: { uvoice: 'r1' } };
  hooks.prompt(voice);
  assert.equal(voice.prompt.text, '<voice reason="request">…</voice>');
  const typed = { sessionID: 's1', prompt: { text: 'go ahead' } };
  hooks.prompt(typed);
  assert.equal(typed.prompt.text, '<voice reason="typed">\nU: use the blue one\n</voice>\n\ngo ahead');
  assert.equal(typed.metadata.uvoiceTyped, 4);
  const again = { sessionID: 's1', prompt: { text: 'next' } };
  hooks.prompt(again);
  assert.equal(again.prompt.text, 'next');
});

test('clearing pending speech leaves typed prompts untouched', async () => {
  const { hooks, handlers } = await load();
  await handlers.pending({ sessionID: 's1', text: 'U: hi there', through: 2 });
  await handlers.pending({ sessionID: 's1', text: '', through: 2 });
  const typed = { sessionID: 's1', prompt: { text: 'hello' } };
  hooks.prompt(typed);
  assert.equal(typed.prompt.text, 'hello');
});

test('ledger preview matches what a later commit delivers', () => {
  const ledger = createTranscriptLedger();
  ledger.add({ sequence: 1, role: 'U', delta: 'read the', utteranceId: 'a' });
  ledger.add({ sequence: 2, role: 'U', delta: ' readme', utteranceId: 'a' });
  ledger.add({ sequence: 3, role: 'A', delta: 'On it', utteranceId: 'b' });
  assert.deepEqual(ledger.preview(), { text: 'U: read the readme\nA: On it', through: 3 });
  const held = ledger.reserve(2);
  assert.equal(ledger.commit(held), 2);
  assert.deepEqual(ledger.preview(), { text: 'A: On it', through: 3 });
});
