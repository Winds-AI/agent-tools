import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceSession } from "../src/voice.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function harness({ delegateDelay = 10, graceMs = 20, getAuth, callFactory } = {}) {
  const state = {
    options: undefined,
    media: undefined,
    sent: [],
    mutes: [],
    submitted: [],
    notifications: [],
    persisted: [],
    statuses: [],
    callArgs: [],
  };
  const session = new VoiceSession({
    voice: "cove",
    submit: (text) => state.submitted.push(text),
    notify: (message, level) => state.notifications.push([message, level]),
    persist: (kind, data) => state.persisted.push([kind, data]),
    status: (value) => state.statuses.push(value),
    getAuth: getAuth ?? (async () => ({ token: "t", accountId: "a", source: "test" })),
    callFactory:
      callFactory ??
      (async (args) => {
        state.callArgs.push(args);
        return { answer: "answer-sdp", callId: "call-1" };
      }),
    mediaFactory: (options) => {
      state.options = options;
      state.media = {
        assistantActive: false,
        slept: 0,
        closed: false,
        ready: Promise.resolve(),
        createOffer: async () => "offer-sdp",
        answer() {},
        waitConnected: async () => {},
        send: (event) => state.sent.push(event),
        mute: (value) => state.mutes.push(value),
        sleep() {
          this.slept++;
        },
        async close() {
          this.closed = true;
        },
      };
      return state.media;
    },
    delegateDelay,
    graceMs,
  });
  return { session, state };
}

async function live(h) {
  await h.session.start();
  assert.equal(h.session.phase, "armed");
  h.state.options.onSpeech(true);
  await delay(30);
  h.state.options.onSpeech(false);
  assert.equal(h.session.phase, "live");
}

test("arms locally, then opens the session when speech is detected", async () => {
  const h = harness({ graceMs: 1000 });
  await live(h);
  assert.equal(h.state.callArgs.length, 1);
  assert.equal(h.state.callArgs[0].sdp, "offer-sdp");
  assert.deepEqual(h.state.callArgs[0].auth, { token: "t", accountId: "a", source: "test" });
});

test("hands the voice transcript to Pi on delegation", async () => {
  const h = harness({ graceMs: 1000 });
  await live(h);
  h.state.options.onEvent({ type: "input_transcript.added", item: { text: " Fix the login page" } });
  h.state.options.onEvent({
    type: "delegation.created",
    item: { id: "d1", target: "client", content: [{ type: "input_text", text: "Fix the login page" }] },
  });
  await delay(40);
  assert.deepEqual(h.state.submitted, ["U: Fix the login page"]);
  assert.ok(h.state.persisted.some(([kind]) => kind === "delegation"));
  assert.ok(h.state.notifications.some(([message]) => /sent to Pi/.test(message)));
});

test("speaks a Pi result through the delegation channel while live", async () => {
  const h = harness({ graceMs: 1000 });
  await live(h);
  h.state.options.onEvent({ type: "input_transcript.added", item: { text: " count files" } });
  h.state.options.onEvent({ type: "delegation.created", item: { id: "d1", target: "client", content: [] } });
  await delay(40);
  h.session.setResult("The project contains 42 source files.");
  const append = h.state.sent.find((event) => event.type === "delegation.context.append");
  assert.ok(append, "expected a delegation context append");
  assert.equal(append.delegation_item_id, "d1");
  assert.equal(append.channel, "speakable");
});

test("closes the session after quiet and reopens to speak a late result", async () => {
  const h = harness({ graceMs: 20 });
  await live(h);
  await delay(500);
  assert.ok(h.state.media.slept >= 1, "expected the metered session to close while quiet");
  assert.equal(h.session.phase, "armed");
  h.state.media.assistantActive = false;
  h.session.setResult("Late result from Pi.");
  await delay(60);
  assert.ok(h.state.sent.some((event) => event.type === "session.context.append"));
});

test("muting keeps Pi results audible and never re-enables the microphone", async () => {
  const h = harness({ graceMs: 1000 });
  await live(h);
  await h.session.toggleMute();
  assert.equal(h.session.phase, "muted");
  assert.equal(h.state.mutes.at(-1), true);

  h.session.setResult("Pi finished the work.");
  await delay(60);
  const append = h.state.sent.find((event) => event.type === "session.context.append");
  assert.ok(append, "expected the result to be spoken while muted");
  assert.equal(h.state.mutes.at(-1), true, "microphone must stay muted while speaking the result");

  await h.session.toggleMute();
  assert.equal(h.state.mutes.at(-1), false, "unmute re-enables the microphone");
  assert.ok(["armed", "live"].includes(h.session.phase));
});

test("does not reuse a delegation from a closed session", async () => {
  const h = harness({ graceMs: 1000 });
  await live(h);
  h.state.options.onEvent({ type: "session.started", session: { id: "s1" } });
  h.state.options.onEvent({ type: "input_transcript.added", item: { text: " do the thing" } });
  h.state.options.onEvent({ type: "delegation.created", item: { id: "d1", target: "client", content: [] } });
  await delay(40);

  await h.session.closeLive();
  assert.equal(h.session.phase, "armed");
  h.state.options.onSpeech(true);
  await delay(30);
  assert.equal(h.session.phase, "live");
  h.state.options.onSpeech(false);
  h.state.options.onEvent({ type: "session.started", session: { id: "s2" } });

  h.session.setResult("Done in a later session.");
  assert.ok(
    h.state.sent.some((event) => event.type === "session.context.append"),
    "expected the context channel for a delegation from a previous session",
  );
  assert.equal(
    h.state.sent.some((event) => event.type === "delegation.context.append"),
    false,
  );
});

test("surfaces the VAD level for tuning", async () => {
  const h = harness({ graceMs: 1000 });
  await h.session.start();
  h.state.options.onLevel({ vad: 0.42, db: -37.5 });
  const status = h.state.statuses.at(-1);
  assert.equal(status.level.vad, 0.42);
  assert.equal(status.level.db, -37.5);
  assert.equal(typeof status.level.at, "number");
});

test("reports a missing Codex login and mutes", async () => {
  const h = harness({
    getAuth: async () => {
      throw new Error("No ChatGPT/Codex login found for voice. Run `codex login`.");
    },
  });
  await h.session.start();
  h.state.options.onSpeech(true);
  await delay(40);
  assert.equal(h.session.phase, "muted");
  assert.ok(h.state.notifications.some(([, level]) => level === "error"));
});
