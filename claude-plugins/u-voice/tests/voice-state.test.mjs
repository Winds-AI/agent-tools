import test from 'node:test';
import assert from 'node:assert/strict';
import { createModeContext, createTranscriptLedger, seedHistory, VOICE_START_CONTEXT, VOICE_END_CONTEXT } from '../hooks/voice-state.js';

test('mode transitions reserve once, retry rejection, and keep the latest pending state', () => {
  const mode = createModeContext();
  assert.equal(mode.reserve(), undefined);
  mode.set(true); const start = mode.reserve();
  assert.equal(start.text, VOICE_START_CONTEXT); assert.equal(mode.reserve(), undefined);
  mode.release(start); const retry = mode.reserve();
  mode.set(false); mode.commit(retry);
  const end = mode.reserve(); assert.equal(end.text, VOICE_END_CONTEXT);
  mode.commit(end); assert.equal(mode.reserve(), undefined);
  mode.set(true); mode.set(false); assert.equal(mode.reserve(), undefined);
});

test('transcript reservations avoid overlapping payloads and retain rejected earlier context', () => {
  const ledger = createTranscriptLedger();
  ledger.add({ role: 'U', sequence: 1, delta: 'Fix the parser', utteranceId: 'u1' });
  const first = ledger.reserve();
  ledger.add({ role: 'A', sequence: 2, delta: 'Sure', utteranceId: 'a1' });
  const second = ledger.reserve();
  assert.equal(second.text, 'A: Sure'); assert.equal(ledger.commit(second), 0);
  ledger.release(first); const retry = ledger.reserve();
  assert.equal(retry.text, 'U: Fix the parser'); assert.equal(ledger.commit(retry), 2);
  assert.equal(ledger.reserve(), undefined);
});

test('caption snapshots include reserved speech and remove only committed fragments', () => {
  const ledger = createTranscriptLedger();
  ledger.add({ role: 'U', sequence: 1, delta: 'Fix parser', utteranceId: 'u1' });
  const first = ledger.reserve(1);
  ledger.add({ role: 'U', sequence: 2, delta: ' and keep the API', utteranceId: 'u1' });
  assert.deepEqual(ledger.pendingCaptions(), [{ role: 'U', text: 'Fix parser and keep the API', utteranceId: 'u1' }]);
  ledger.commit(first);
  assert.deepEqual(ledger.pendingCaptions(), [{ role: 'U', text: ' and keep the API', utteranceId: 'u1' }]);
  ledger.add({ role: 'U', sequence: 1, delta: 'Fix parser', utteranceId: 'u1' });
  assert.equal(ledger.pendingCaptions()[0].text, ' and keep the API', 'duplicate delivered fragments stay hidden');
  const second = ledger.reserve();
  assert.equal(second.text, 'U: and keep the API', 'rendering does not consume or reserve speech');
  ledger.release(second);
  assert.equal(ledger.pendingCaptions().length, 1);
  ledger.commit(ledger.reserve());
  assert.deepEqual(ledger.pendingCaptions(), []);
});

test('out-of-order acceptance clears later captions while retaining rejected earlier speech', () => {
  const ledger = createTranscriptLedger();
  ledger.add({ role: 'U', sequence: 1, delta: 'Earlier constraint', utteranceId: 'u1' });
  const first = ledger.reserve();
  ledger.add({ role: 'A', sequence: 2, delta: 'Later response', utteranceId: 'a1' });
  const second = ledger.reserve();
  assert.equal(ledger.commit(second), 0);
  assert.deepEqual(ledger.pendingCaptions(), [{ role: 'U', text: 'Earlier constraint', utteranceId: 'u1' }]);
  ledger.release(first);
  assert.equal(ledger.pendingCaptions().length, 1);
  ledger.commit(ledger.reserve());
  assert.deepEqual(ledger.pendingCaptions(), []);
  ledger.add({ role: 'U', sequence: 3, delta: 'New speech', utteranceId: 'u2' });
  ledger.reset();
  assert.deepEqual(ledger.pendingCaptions(), []);
});

test('history seed keeps text and omits tool results and private thinking', () => {
  const seed = seedHistory([{ role: 'user', text: 'Existing request', toolResults: [{ text: 'PRIVATE_RESULT' }] }, { role: 'assistant', text: 'Existing answer', thinking: 'PRIVATE_THINKING' }]);
  assert.deepEqual(seed.map(item => item.role), ['user', 'assistant']);
  assert.doesNotMatch(JSON.stringify(seed), /PRIVATE/);
  assert.ok(JSON.stringify(seedHistory([{ role: 'user', text: 'x'.repeat(15000) }])).length < 7000);
});
