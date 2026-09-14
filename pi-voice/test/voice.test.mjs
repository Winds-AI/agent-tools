import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VoiceSession, VOICE_PROMPT } from "../src/voice.mjs";
import { Conversation, contextChunks } from "../src/conversation.mjs";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
class FakeLive extends EventEmitter {
  constructor() {
    super();
    this.sessionId = "live-test";
    this.sent = [];
    this.appends = [];
    this.socket = { bufferedAmount: 0 };
  }
  async start(session) {
    this.session = session;
    return { id: this.sessionId, model: "gpt-live-1" };
  }
  send(e) {
    this.sent.push(e);
    return true;
  }
  append(...args) {
    this.appends.push(args);
  }
  async close() {
    this.closed = true;
    return { finalized: true, seconds: 4 };
  }
}
function fixture(extra = {}) {
  const calls = [],
    persisted = [],
    connections = [],
    notices = [],
    media = [];
  const voice = new VoiceSession({
    key: "test-placeholder",
    delegateDelay: 5,
    submit: (text) => calls.push(text),
    status: () => {},
    notify: (...x) => notices.push(x),
    persist: (...x) => persisted.push(x),
    connectionFactory: () => {
      const c = new FakeLive();
      c.sessionId = "s" + connections.length;
      connections.push(c);
      return c;
    },
    mediaFactory: (opts) => {
      const m = {
        opts,
        played: [],
        closed: false,
        backlogMs: 0,
        playbackUntil: 0,
        connect() {
          this.connected = true;
        },
        sleep() {
          this.sleeping = true;
        },
        play(x) {
          this.played.push(x);
        },
        async close() {
          this.closed = true;
        },
      };
      media.push(m);
      return m;
    },
    ...extra,
  });
  // Existing conversational tests begin after the local listener detects speech.
  const enable = voice.start.bind(voice);
  voice.start = async () => {
    await enable();
    voice.wake();
    await voice.opening;
  };
  const event = (e) => connections.at(-1).emit("event", e);
  const input = (delta, start = 0, end = 100) =>
    event({
      type: "session.input_transcript.delta",
      delta,
      start_ms: start,
      end_ms: end,
    });
  const assistant = (delta, start = 0, end = 100) =>
    event({
      type: "session.output_transcript.delta",
      delta,
      start_ms: start,
      end_ms: end,
    });
  const delegate = (id = "d1", offset = 1000) =>
    event({
      type: "session.delegation.created",
      delegation: { id, target: "client" },
      offset_ms: offset,
    });
  return {
    voice,
    calls,
    persisted,
    connections,
    notices,
    media,
    event,
    input,
    assistant,
    delegate,
  };
}
test("no session or microphone until explicitly unmuted; exact model and client delegation", async () => {
  const f = fixture();
  assert.equal(f.connections.length, 0);
  assert.equal(f.voice.phase, "muted");
  await f.voice.toggle();
  assert.equal(f.connections[0].session.model, "gpt-live-1");
  assert.deepEqual(f.connections[0].session.delegation, { type: "client" });
  assert.equal(f.connections[0].session.instructions, VOICE_PROMPT);
  assert.equal(f.media.length, 1);
  assert.equal(f.calls.length, 0);
  await f.voice.shutdown();
});
test("speech is conversational until delegation; roles preserved; duplicate delegation submits once", async () => {
  const f = fixture();
  await f.voice.start();
  f.input("Can we discuss ");
  f.input("a design?", 100, 300);
  f.assistant("Of course.", 310, 600);
  await wait(15);
  assert.equal(f.calls.length, 0);
  f.input("Implement the small option.", 650, 900);
  f.delegate();
  f.delegate();
  await wait(30);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /U: Can we discuss a design\?/);
  assert.match(f.calls[0], /A: Of course\./);
  await f.voice.shutdown();
});
test("delegation waits for late transcript and ignores empty repeated handoff", async () => {
  const f = fixture();
  await f.voice.start();
  f.delegate();
  await wait(15);
  assert.equal(f.calls.length, 0);
  f.input("Run the tests.");
  await wait(25);
  assert.equal(f.calls.length, 1);
  f.delegate("d2");
  await wait(20);
  assert.equal(f.calls.length, 1);
  await f.voice.shutdown();
});
test("mute closes media and billing; reconnect restores history without redispatch", async () => {
  const f = fixture();
  await f.voice.start();
  f.input("Remember the blue button.");
  f.assistant("Understood.", 200, 400);
  await f.voice.toggle();
  assert.equal(f.voice.phase, "muted");
  assert.equal(f.connections[0].closed, true);
  assert.equal(f.media[0].closed, true);
  assert.equal(f.voice.totalSeconds, 4);
  await f.voice.toggle();
  assert.equal(f.connections.length, 2);
  assert.equal(f.connections[1].session.input[0].role, "user");
  assert.equal(f.connections[1].session.input[1].role, "assistant");
  assert.equal(f.calls.length, 0);
  await f.voice.shutdown();
});
test("shutdown drains no delegation into a replacement Pi session", async () => {
  const f = fixture();
  await f.voice.start();
  f.input("Do not submit after shutdown.");
  f.delegate();
  await f.voice.shutdown();
  await wait(20);
  assert.equal(f.calls.length, 0);
});
test("Pi results are spoken: commentary in-session, commentary after reopen", async () => {
  const f = fixture();
  f.voice.setResult("LONG RESULT");
  assert.equal(f.connections.length, 0);
  await f.voice.start();
  f.voice.setResult("Full answer: ".repeat(700));
  assert.equal(f.connections.length, 1);
  const spoken = f.connections[0].appends.filter((x) => x[0] === "commentary");
  assert.equal(spoken.length > 0, true);
  assert.equal(f.connections[0].appends.some((x) => x[0] === "thinking"), false);
  await f.voice.closeLive();
  f.voice.setResult("Second answer.");
  await f.voice.opening;
  assert.equal(f.voice.announcePending, false);
  assert.equal(f.connections.length, 2);
  const announced = f.connections[1].appends.filter(
    (x) => x[0] === "commentary",
  );
  assert.equal(announced.length > 0, true);
  assert.match(announced.map((x) => x[1]).join(""), /Second answer/);
  const seeded = f.connections[1].session.input.at(-1).content[0].text;
  assert.match(seeded, /Second answer/);
  await f.voice.shutdown();
});
test("new delegation only sends new conversation; original messages are not replayed", async () => {
  const f = fixture();
  await f.voice.start();
  f.input("First task.");
  f.delegate();
  await wait(20);
  f.input("Correction: use green.", 1500, 1900);
  f.delegate("d2", 2000);
  await wait(20);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1], "U: Correction: use green.");
  await f.voice.shutdown();
});
test("audio is forwarded immediately and remote speech reaches player", async () => {
  const f = fixture();
  await f.voice.start();
  f.media[0].opts.onInput(Buffer.from([1, 2]));
  assert.deepEqual(f.connections[0].sent[0], {
    type: "session.input_audio.append",
    audio: "AQI=",
  });
  f.event({ type: "session.output_audio.delta", delta: "AwQ=" });
  assert.deepEqual(f.media[0].played[0], Buffer.from([3, 4]));
  await f.voice.shutdown();
});
test("context is bounded for multilingual text and never changes literal fragments", () => {
  const c = new Conversation();
  for (let i = 0; i < 300; i++)
    c.add(
      {
        type: "session.input_transcript.delta",
        delta: "यह परीक्षण है ".repeat(80),
        start_ms: i * 100,
        end_ms: i * 100 + 99,
      },
      "s",
    );
  const h = c.history();
  assert.ok(h.length <= 60);
  assert.ok(
    Buffer.byteLength(h.map((x) => x.content[0].text).join("")) <= 6500,
  );
  assert.ok(
    contextChunks("🙂".repeat(600)).every((s) => Buffer.byteLength(s) <= 400),
  );
  const exact = new Conversation();
  exact.add({ type: "session.input_transcript.delta", delta: "hello " }, "s");
  exact.add({ type: "session.input_transcript.delta", delta: " world" }, "s");
  assert.equal(exact.rows()[0].text, "hello  world");
});
test("shutdown during pending connection leaves microphone off", async () => {
  let resolveStart;
  const conn = new FakeLive();
  conn.start = () => new Promise((r) => (resolveStart = r));
  const f = fixture({ connectionFactory: () => conn });
  f.voice.operation = f.voice.start();
  await wait(0);
  const stopping = f.voice.shutdown();
  resolveStart({ model: "gpt-live-1" });
  await stopping;
  assert.equal(f.voice.phase, "closed");
  assert.equal(f.media[0].closed, true);
  assert.equal(f.media[0].connected, undefined);
});

test("handoff includes a trailing restriction after its event offset", async () => {
  const f = fixture({ delegateDelay: 50 });
  await f.voice.start();
  f.input("Make the change.", 0, 100);
  f.delegate("d1", 100);
  await wait(20);
  f.input(" But do not deploy it.", 200, 600);
  await wait(30);
  assert.equal(f.calls.length, 0);
  await wait(45);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /do not deploy/);
  await f.voice.shutdown();
});

test("mute makes conversational-only U/A dialogue visible and persists its display watermark", async () => {
  const f = fixture();
  await f.voice.start();
  f.input("Let us think about it.");
  f.assistant("What matters most?", 200, 400);
  await f.voice.pause();
  const display = f.persisted.filter((x) => x[0] === "conversation");
  assert.equal(display.length, 1);
  assert.match(display[0][1].text, /U: Let us think/);
  assert.match(display[0][1].text, /A: What matters/);
  const restored = fixture({
    fragments: f.voice.conversation.fragments,
    lastDisplayed: display[0][1].lastDisplayed,
  });
  restored.voice.flushDisplay();
  assert.equal(restored.persisted.length, 0);
  await restored.voice.shutdown();
  await f.voice.shutdown();
});
