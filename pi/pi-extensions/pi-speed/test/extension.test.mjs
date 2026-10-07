import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

// Exercise the real extension with fake Pi events, UI, timers, and clocks.
// No Pi dependencies, credentials, or network access are needed.
const path = new URL("../index.ts", import.meta.url);
const source = stripTypeScriptTypes(readFileSync(path, "utf8"))
  .replace('import { Text } from "@earendil-works/pi-tui";', "")
  .replace("export default function", "globalThis.createExtension = function");

function harness(hasUI = true) {
  let now = 0;
  let wallNow = 100000;
  let nextTimer = 0;
  const handlers = new Map();
  const renderers = new Map();
  const intervals = new Map();
  const statuses = [];
  const working = [];
  const entries = [];
  const sandbox = {
    performance: { now: () => now },
    Date: { now: () => wallNow },
    Text: class { constructor(...args) { this.args = args; } },
    setInterval: (fn) => { const id = ++nextTimer; intervals.set(id, fn); return id; },
    clearInterval: (id) => intervals.delete(id),
  };
  vm.runInNewContext(source, sandbox, { filename: path.pathname });
  const pi = {
    on: (type, handler) => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
    appendEntry: (type, data) => entries.push({ type, data }),
  };
  const ctx = {
    hasUI,
    ui: {
      setStatus: (key, text) => statuses.push({ key, text }),
      setWorkingMessage: (text) => working.push(text),
    },
  };
  sandbox.createExtension(pi);
  return {
    ctx, statuses, working, entries, intervals, renderers,
    at(value) { now = value; },
    wallAt(value) { wallNow = value; },
    tick() { for (const fn of intervals.values()) fn(); },
    speed() { return statuses.at(-1)?.text; },
    async emit(type, event = {}) {
      for (const fn of handlers.get(type) ?? []) await fn(event, ctx);
    },
    async request(start) {
      this.at(start);
      await this.emit("before_provider_request", { payload: {} });
    },
    async end(end, output, extra = {}) {
      this.at(end);
      await this.emit("message_end", { message: { role: "assistant", usage: { output }, stopReason: "stop", ...extra } });
    },
    async response(start, end, tokens, extra = {}) {
      await this.request(start);
      await this.end(end, tokens, extra);
    },
  };
}

test("uses a time-weighted pooled rate, with a valid request start at zero", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.response(0, 1000, 100);
  assert.equal(h.speed(), "100 tok/s");
  await h.response(5000, 8000, 900);
  assert.equal(h.speed(), "250 tok/s"); // 1000 tokens / 4s, not mean(100, 300)
});

test("includes hidden reasoning and the wait before headers/first delta", async () => {
  const h = harness();
  await h.request(0);
  h.at(3000);
  await h.emit("message_start", { message: { role: "assistant" } });
  h.at(10000);
  await h.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "toolcall_delta", delta: '{"command":"pwd"}' } });
  await h.end(11000, 1100, { usage: { output: 1100, reasoning: 1000 }, stopReason: "toolUse" });
  assert.equal(h.speed(), "100 tok/s"); // output includes reasoning exactly once
});

test("buffered single-chunk output is measured over the complete request", async () => {
  const h = harness();
  await h.request(0);
  h.at(10000);
  await h.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) } });
  await h.end(10000, 100);
  assert.equal(h.speed(), "10 tok/s");
});

test("zero-duration positive-token samples cannot contaminate an existing window", async () => {
  const h = harness();
  await h.response(0, 1000, 100);
  await h.response(2000, 2000, 900);
  assert.equal(h.speed(), "100 tok/s");
});

test("rejects invalid token counts without estimating from characters", async () => {
  for (const output of [undefined, 0, -1, NaN, Infinity, "100"]) {
    const h = harness();
    await h.emit("session_start");
    await h.request(0);
    h.at(500);
    await h.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4000) } });
    await h.end(1000, output);
    assert.equal(h.speed(), "-- tok/s");
    await h.response(10000, 11000, 100);
    assert.equal(h.speed(), "100 tok/s");
  }
});

test("rejects negative/nonfinite elapsed time rather than clamping it", async () => {
  for (const end of [-1, NaN, Infinity]) {
    const h = harness();
    await h.response(0, 1000, 100);
    await h.response(2000, end, 900);
    assert.equal(h.speed(), "100 tok/s");
    await h.response(3000, 4000, 100);
    assert.equal(h.speed(), "100 tok/s");
  }
});

test("requires a matching provider request, not message_start alone", async () => {
  const h = harness();
  await h.emit("session_start");
  h.at(0);
  await h.emit("message_start", { message: { role: "assistant" } });
  await h.end(1000, 100);
  assert.equal(h.speed(), "-- tok/s");
});

test("does not reuse timing on duplicate message_end events", async () => {
  const h = harness();
  await h.response(0, 1000, 100);
  await h.end(2000, 900);
  assert.equal(h.speed(), "100 tok/s");
});

test("parallel and nested tool executions/results add neither tokens nor time", async () => {
  const h = harness();
  await h.response(0, 1000, 100, { stopReason: "toolUse", content: [{ type: "toolCall" }, { type: "toolCall" }, { type: "toolCall" }] });
  for (const toolCallId of ["a", "b", "c", "a/1", "a/2"]) {
    await h.emit("tool_execution_start", { toolCallId, toolName: "bash" });
    h.at(10000);
    await h.emit("tool_execution_end", { toolCallId, toolName: "bash" });
    await h.emit("message_end", { message: { role: "toolResult", toolCallId, usage: { output: 99999 } } });
  }
  await h.response(11000, 12000, 100);
  assert.equal(h.speed(), "100 tok/s");
});

test("non-assistant messages cannot consume an active request timestamp", async () => {
  const h = harness();
  await h.request(0);
  h.at(500);
  for (const role of ["user", "toolResult", "custom", "system"]) {
    await h.emit("message_end", { message: { role, usage: { output: 99999 } } });
  }
  await h.end(1000, 100);
  assert.equal(h.speed(), "100 tok/s");
});

test("an unreported failed/aborted response and retry backoff do not leak into the next sample", async () => {
  for (const stopReason of ["error", "aborted"]) {
    const h = harness();
    await h.response(0, 1000, 0, { stopReason });
    await h.response(10000, 11000, 100);
    assert.equal(h.speed(), "100 tok/s");
  }
});

test("reported partial output uses its own elapsed time", async () => {
  const h = harness();
  await h.response(0, 1000, 100, { stopReason: "aborted" });
  assert.equal(h.speed(), "100 tok/s");
});

test("retains exactly the last 15 measured assistant responses", async () => {
  const h = harness();
  for (let i = 0; i < 15; i++) await h.response(i * 2000, i * 2000 + 1000, 100);
  // An invalid sample must neither contribute nor evict a valid sample.
  await h.response(30000, 30000, 99999);
  await h.response(32000, 33000, 1600);
  assert.equal(h.speed(), "200 tok/s"); // (14*100 + 1600) / 15s
});

test("the documented session window continues across model changes", async () => {
  const h = harness();
  await h.response(0, 1000, 100, { model: "slow" });
  await h.emit("model_select", { model: { id: "fast" } });
  await h.response(2000, 3000, 1000, { model: "fast" });
  assert.equal(h.speed(), "550 tok/s");
});

test("speed remains the last completed measurement while a response streams", async () => {
  const h = harness();
  await h.response(0, 1000, 100);
  const count = h.statuses.length;
  await h.request(2000);
  for (let i = 1; i <= 10; i++) {
    h.at(2000 + i * 100);
    await h.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "hello" } });
  }
  assert.equal(h.statuses.length, count);
  await h.end(4000, 500);
  assert.equal(h.speed(), "200 tok/s");
});

test("wall-clock jumps affect neither throughput nor the worked-for timer", async () => {
  const h = harness();
  await h.emit("before_agent_start");
  await h.request(0);
  h.wallAt(-1000000);
  await h.end(2000, 100);
  assert.equal(h.speed(), "50 tok/s");
  h.at(5000);
  h.wallAt(9999999999);
  h.tick();
  assert.equal(h.working.at(-1), "Working · ⏱ 5s");
  await h.emit("agent_settled");
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].type, "pi-speed:worked-for");
  assert.equal(h.entries[0].data.seconds, 5);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.working.at(-1), undefined);
});

test("session_start clears the window, outstanding request, and ticker", async () => {
  const h = harness();
  await h.emit("before_agent_start");
  await h.response(0, 1000, 100);
  await h.request(2000);
  await h.emit("session_start");
  assert.equal(h.speed(), "-- tok/s");
  assert.equal(h.intervals.size, 0);
  await h.end(3000, 900);
  assert.equal(h.speed(), "-- tok/s");
  await h.emit("agent_settled");
  assert.equal(h.entries.length, 0);
});

test("settling/shutdown clears unfinished requests, and settling is idempotent", async () => {
  for (const boundary of ["agent_settled", "session_shutdown"]) {
    const h = harness();
    await h.emit("session_start");
    await h.emit("before_agent_start");
    await h.request(0);
    h.at(2000);
    await h.emit(boundary);
    assert.equal(h.intervals.size, 0);
    await h.end(3000, 900);
    assert.equal(h.speed(), "-- tok/s");
    if (boundary === "agent_settled") {
      await h.emit(boundary);
      assert.equal(h.entries.length, 1);
    }
  }
});

test("a fresh prompt clears stale request timing", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.request(0);
  h.at(2000);
  await h.emit("before_agent_start");
  await h.end(3000, 900);
  assert.equal(h.speed(), "-- tok/s");
});

test("instant runs are not persisted and persisted timer entries still render", async () => {
  const h = harness();
  await h.emit("before_agent_start");
  h.at(999);
  await h.emit("agent_settled");
  assert.equal(h.entries.length, 0);
  const renderer = h.renderers.get("pi-speed:worked-for");
  const rendered = renderer({ data: { seconds: 261 } }, {}, { fg: (_color, text) => text });
  assert.equal(rendered.args[0], "⏱ worked for 4m 21s");
  assert.equal(renderer({ data: {} }, {}, {}), undefined);
});

test("noninteractive modes do not create UI timers or call UI methods", async () => {
  const h = harness(false);
  await h.emit("session_start");
  await h.emit("before_agent_start");
  await h.response(0, 1000, 100);
  h.at(5000);
  await h.emit("agent_settled");
  await h.emit("session_shutdown");
  assert.equal(h.statuses.length, 0);
  assert.equal(h.working.length, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.entries.length, 1);
});
