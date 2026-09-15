import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";

// Exercise the entrypoint with the same installed Pi TUI and TypeScript loader.
const piPath = execFileSync("bash", ["-c", "command -v pi"], {
  encoding: "utf8",
}).trim();
const piRequire = createRequire(realpathSync(piPath));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui"),
  },
});
const install = await jiti.import("../index.ts", { default: true });

async function fixture() {
  const handlers = new Map(),
    commands = new Map(),
    messages = [];
  let widget, callArgs, mediaOptions, sent;
  const theme = { fg: (_color, text) => text };
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    ui: {
      theme,
      setStatus() {},
      notify() {},
      setWidget(_name, content) {
        widget = typeof content === "function" ? content({}, theme) : undefined;
      },
    },
  };
  install(
    {
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerEntryRenderer() {},
      appendEntry() {},
      sendUserMessage: (text) => messages.push(text),
    },
    {
      getAuth: async () => ({ token: "test-token", accountId: "acct", source: "test" }),
      callFactory: async (args) => {
        callArgs = args;
        return { answer: "v=0", callId: "call-1" };
      },
      mediaFactory: (options) => {
        mediaOptions = options;
        sent = [];
        return {
          ready: Promise.resolve(),
          createOffer: async () => "offer-sdp",
          answer() {},
          waitConnected: async () => {},
          send: (event) => sent.push(event),
          mute() {},
          sleep() {},
          async close() {},
        };
      },
    },
  );
  await handlers.get("session_start")({}, ctx);
  return {
    handlers,
    commands,
    messages,
    callArgs: () => callArgs,
    mediaOptions: () => mediaOptions,
    sent: () => sent,
    start: async () => {
      await commands.get("m").handler("", ctx);
    },
    speak: (on) => mediaOptions.onSpeech(on),
    transcript: (text) => mediaOptions.onEvent({ type: "input_transcript.added", item: { text } }),
    lines: (width) => widget?.render(width).map((line) => line.trimEnd()) ?? [],
    shutdown: () => handlers.get("session_shutdown")({}, ctx),
  };
}

test("voice preview wraps by screen lines through the real Pi TUI", async () => {
  const f = await fixture();
  try {
    await f.start();
    assert.equal(f.callArgs(), undefined, "no call before speech");
    f.speak(true);
    await new Promise((r) => setTimeout(r, 30));
    f.speak(false);
    assert.ok(f.callArgs(), "speech opened the call");
    assert.equal(f.callArgs().sdp, "offer-sdp");
    f.transcript("one two three four five six seven eight nine ten eleven twelve");
    const before = f.lines(15);
    assert.deepEqual(before, [
      "U: one two",
      "three four five",
      "six seven eight",
      "nine ten eleven",
      "twelve",
    ]);
    f.transcript(" thirteen fourteen");
    assert.deepEqual(f.lines(15), [
      ...before.slice(1, 4),
      "twelve thirteen",
      "fourteen",
    ]);
    assert.equal(f.lines(100).length, 1);
  } finally {
    await f.shutdown();
  }
});

test("small streaming fragments do not prematurely evict visible text", async () => {
  const f = await fixture();
  try {
    await f.start();
    f.speak(true);
    await new Promise((r) => setTimeout(r, 30));
    f.speak(false);
    const text = "This sentence arrives one character at a time, beyond forty fragments.";
    for (const char of text) f.transcript(char);
    assert.deepEqual(f.lines(100), ["U: " + text]);
  } finally {
    await f.shutdown();
  }
});
