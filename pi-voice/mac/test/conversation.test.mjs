import { test } from "node:test";
import assert from "node:assert/strict";
import { Conversation, contextChunks, transcriptDelta } from "../src/conversation.mjs";

test("parses GPT-Live transcript items into deltas", () => {
  assert.deepEqual(
    transcriptDelta({ type: "input_transcript.added", item: { text: " hello" } }),
    { role: "U", delta: " hello" },
  );
  assert.deepEqual(
    transcriptDelta({ type: "output_transcript.added", item: { text: " hi" } }),
    { role: "A", delta: " hi" },
  );
  assert.equal(transcriptDelta({ type: "turn.done", turn: { role: "user" } }), undefined);
});

test("groups fragments by speaker and renders U/A text", () => {
  const conversation = new Conversation();
  conversation.add({ type: "input_transcript.added", item: { text: " fix the" } }, "s1");
  conversation.add({ type: "input_transcript.added", item: { text: " login" } }, "s1");
  conversation.add({ type: "output_transcript.added", item: { text: " sure" } }, "s1");
  conversation.add({ type: "input_transcript.added", item: { text: " now" } }, "s1");
  assert.equal(conversation.text(), "U: fix the login\nA: sure\nU: now");
});

test("restores fragments and continues the sequence", () => {
  const conversation = new Conversation([{ role: "U", delta: "earlier", sequence: 7, sessionId: "s0" }]);
  const fragment = conversation.add({ type: "output_transcript.added", item: { text: "later" } }, "s1");
  assert.equal(fragment.sequence, 8);
  assert.equal(conversation.text(), "U: earlier\nA: later");
});

test("builds seeded history with role-appropriate content types", () => {
  const conversation = new Conversation();
  conversation.add({ type: "input_transcript.added", item: { text: "hello" } }, "s1");
  conversation.add({ type: "output_transcript.added", item: { text: "hi" } }, "s1");
  const history = conversation.history("Pi result");
  assert.equal(history.length, 3);
  assert.equal(history[0].role, "user");
  assert.equal(history[0].content[0].type, "input_text");
  assert.equal(history[1].role, "assistant");
  assert.equal(history[1].content[0].type, "output_text");
  assert.match(history[2].content[0].text, /Pi result/);
});

test("chunks context appends under the realtime byte limit", () => {
  const chunks = contextChunks("a".repeat(1000), 100);
  assert.ok(chunks.length >= 10);
  for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk) <= 100);
  assert.equal(chunks.join(""), "a".repeat(1000));
});
