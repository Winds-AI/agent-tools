import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VoiceSession } from "../src/voice.mjs";

function fixture() {
  const connections = [],
    media = [],
    submitted = [],
    persisted = [];
  const voice = new VoiceSession({
    key: "placeholder",
    status() {},
    notify() {},
    persist: (...args) => persisted.push(args),
    submit: (text) => submitted.push(text),
    connectionFactory() {
      const connection = new EventEmitter();
      Object.assign(connection, {
        sessionId: "s" + connections.length,
        socket: { bufferedAmount: 0 },
        appends: [],
        async start(session) {
          this.session = session;
        },
        send() {},
        append(kind, content) {
          this.appends.push([kind, content]);
        },
        async close() {
          this.closed = true;
          return { finalized: true, seconds: 4 };
        },
      });
      connections.push(connection);
      return connection;
    },
    mediaFactory(callbacks) {
      const local = {
        callbacks,
        backlogMs: 0,
        playbackUntil: 0,
        connect() {
          this.connected = true;
        },
        sleep() {
          this.asleep = true;
        },
        play() {},
        async close() {
          this.closed = true;
        },
      };
      media.push(local);
      return local;
    },
  });
  return {
    voice,
    connections,
    media,
    submitted,
    persisted,
    async start() {
      await voice.start();
      voice.wake();
      await voice.opening;
    },
    caption(role, delta) {
      connections.at(-1).emit("event", {
        type:
          role === "U"
            ? "session.input_transcript.delta"
            : "session.output_transcript.delta",
        delta,
      });
    },
  };
}

test("missing credentials leave the microphone off and point to native login", async () => {
  const f = fixture();
  const notices = [];
  f.voice.getKey = async () => undefined;
  f.voice.notify = (text) => notices.push(text);
  await f.voice.start();
  assert.equal(f.voice.phase, "muted");
  assert.equal(f.media.length, 0);
  assert.equal(f.connections.length, 0);
  assert.match(notices[0], /\/login/);
  await f.voice.shutdown();
});

test("each wake resolves fresh Pi credentials and respects logout", async () => {
  const f = fixture();
  let stored = "first-placeholder";
  const used = [];
  f.voice.getKey = async () => stored;
  const factory = f.voice.connectionFactory;
  f.voice.connectionFactory = (options) => {
    used.push(options.key);
    return factory();
  };
  await f.start();
  await f.voice.closeLive();
  stored = "replacement-placeholder";
  f.voice.wake();
  await f.voice.opening;
  await f.voice.closeLive();
  stored = undefined;
  f.voice.wake();
  await f.voice.opening;
  assert.deepEqual(used, ["first-placeholder", "replacement-placeholder"]);
  assert.equal(f.voice.phase, "muted");
  assert.equal(f.media[0].closed, true);
  await f.voice.shutdown();
});

test("mute during credential lookup cannot create a late connection", async () => {
  const f = fixture();
  await f.voice.start();
  let finishLookup;
  f.voice.getKey = () =>
    new Promise((resolve) => {
      finishLookup = resolve;
    });
  f.voice.wake();
  await f.voice.pause();
  finishLookup("qa-placeholder");
  await f.voice.opening;
  assert.equal(f.connections.length, 0);
  assert.equal(f.media[0].closed, true);
  assert.equal(f.voice.phase, "muted");
  await f.voice.shutdown();
});

test("enable opens only local audio, and explicit mute disables automatic wake", async () => {
  const f = fixture();
  await f.voice.toggle();
  assert.equal(f.voice.phase, "armed");
  assert.equal(f.connections.length, 0);
  await f.voice.toggle();
  assert.equal(f.media[0].closed, true);
  f.media[0].callbacks.onWake();
  assert.equal(f.connections.length, 0);
  assert.equal(f.voice.phase, "muted");
  await f.voice.shutdown();
});

test("automatic idle closes billing but retains local capture and conversation", async () => {
  const f = fixture();
  await f.start();
  f.caption("U", "Remember the blue button.");
  f.caption("A", "Understood.");
  f.voice.checkIdle(performance.now() + 6000);
  await f.voice.closingLive;
  assert.equal(f.voice.phase, "armed");
  assert.equal(f.connections[0].closed, true);
  assert.equal(f.media[0].closed, undefined);
  assert.equal(f.voice.totalSeconds, 4);
  // Pi finishing after the close reopens briefly; the seeded history carries
  // the result, which is what the assistant then voices.
  f.voice.setResult("The code is ready.");
  assert.equal(f.voice.phase, "connecting");
  await f.voice.opening;
  assert.equal(f.connections.length, 2);
  const seeded = f.connections[1].session.input.at(-1).content[0].text;
  assert.match(seeded, /Pi's most recent result/);
  assert.match(seeded, /The code is ready\./);
  assert.equal(f.submitted.length, 0);
  await f.voice.shutdown();
});

test("idle grace waits for speech, backlog, and playback, then closes after five seconds", async () => {
  const f = fixture();
  await f.start();
  const now = performance.now();
  f.media[0].callbacks.onSpeech(true);
  f.voice.checkIdle(now + 40000);
  assert.equal(f.voice.phase, "live");
  f.media[0].callbacks.onSpeech(false);
  f.voice.checkIdle(now + 4000);
  assert.equal(f.voice.phase, "live");
  f.media[0].backlogMs = 900;
  f.voice.checkIdle(now + 40000);
  assert.equal(f.voice.phase, "live");
  f.media[0].backlogMs = 0;
  f.media[0].playbackUntil = now + 39000;
  f.voice.checkIdle(now + 40000);
  assert.equal(f.voice.phase, "live");
  f.media[0].playbackUntil = 0;
  f.voice.checkIdle(now + 6000);
  await f.voice.closingLive;
  assert.equal(f.voice.phase, "armed");
  await f.voice.shutdown();
});

test("continuous silent output packets do not keep a paid session alive", async () => {
  const f = fixture();
  await f.start();
  const before = f.voice.lastAssistantActivity;
  f.connections[0].emit("event", {
    type: "session.output_audio.delta",
    delta: Buffer.alloc(960).toString("base64"),
  });
  assert.equal(f.voice.lastAssistantActivity, before);
  f.voice.checkIdle(performance.now() + 11000);
  await f.voice.closingLive;
  assert.equal(f.voice.phase, "armed");
  await f.voice.shutdown();
});

test("normal small audio buffering cannot prevent sleep indefinitely", async () => {
  const f = fixture();
  await f.start();
  f.media[0].backlogMs = 260;
  f.voice.checkIdle(performance.now() + 11000);
  await f.voice.closingLive;
  assert.equal(f.voice.phase, "armed");
  await f.voice.shutdown();
});

test("failed Pi submission preserves the transcript without repeated retries", async () => {
  const f = fixture();
  await f.start();
  let attempts = 0;
  f.voice.submit = () => {
    attempts++;
    throw new Error("Pi unavailable");
  };
  f.caption("U", "Keep this request.");
  f.connections[0].emit("event", {
    type: "session.delegation.created",
    delegation: { id: "d", target: "client" },
  });
  await f.voice.pause();
  assert.equal(attempts, 1);
  assert.equal(f.voice.lastDelegated, 0);
  assert.match(
    f.persisted.find((entry) => entry[0] === "conversation")[1].text,
    /Keep this request/,
  );
  await f.voice.shutdown();
});

test("speech during close waits for final usage and includes late captions on reconnect", async () => {
  const f = fixture();
  await f.start();
  let finishClose;
  f.connections[0].close = () =>
    new Promise((resolve) => {
      finishClose = resolve;
    });
  const closing = f.voice.closeLive();
  f.media[0].callbacks.onWake();
  assert.equal(f.connections.length, 1);
  f.caption("U", "A late caption.");
  finishClose({ finalized: true, seconds: 7 });
  await closing;
  await f.voice.opening;
  assert.equal(f.connections.length, 2);
  assert.match(
    f.connections[1].session.input[0].content[0].text,
    /late caption/,
  );
  assert.equal(f.voice.totalSeconds, 7);
  await f.voice.shutdown();
});

test("mute during startup closes capture immediately and cannot turn itself back on", async () => {
  const f = fixture();
  let finishStart;
  const originalFactory = f.voice.connectionFactory;
  f.voice.connectionFactory = () => {
    const connection = originalFactory();
    connection.start = () =>
      new Promise((resolve) => {
        finishStart = resolve;
      });
    return connection;
  };
  await f.voice.start();
  f.voice.wake();
  await new Promise((resolve) => setImmediate(resolve));
  await f.voice.pause();
  assert.equal(f.media[0].closed, true);
  assert.equal(f.connections[0].closed, true);
  finishStart();
  await f.voice.opening;
  assert.equal(f.voice.phase, "muted");
  assert.equal(f.media[0].connected, undefined);
  await f.voice.shutdown();
});

test("an old worker finishing warmup cannot replace a newer listener", async () => {
  const f = fixture();
  let finishReady;
  const originalFactory = f.voice.mediaFactory;
  f.voice.mediaFactory = (callbacks) => {
    const local = originalFactory(callbacks);
    if (f.media.length === 1)
      local.ready = new Promise((resolve) => {
        finishReady = resolve;
      });
    return local;
  };
  const first = f.voice.start();
  await new Promise((resolve) => setImmediate(resolve));
  await f.voice.pause();
  await f.voice.start();
  finishReady();
  await first;
  f.media[0].callbacks.onWake();
  assert.equal(f.connections.length, 0);
  assert.equal(f.voice.media, f.media[1]);
  assert.equal(f.voice.phase, "armed");
  await f.voice.shutdown();
});

test("shutdown persists late captions without dispatching them into a new Pi session", async () => {
  const f = fixture();
  await f.start();
  f.caption("U", "Do not submit after shutdown.");
  f.connections[0].emit("event", {
    type: "session.delegation.created",
    delegation: { id: "d", target: "client" },
  });
  f.connections[0].close = async () => {
    f.caption("U", " Late caption.");
    return { finalized: true, seconds: 4 };
  };
  await f.voice.shutdown();
  assert.equal(f.submitted.length, 0);
  assert.equal(f.voice.phase, "closed");
  assert.match(
    f.persisted.find((entry) => entry[0] === "conversation")[1].text,
    /Late caption/,
  );
});
