import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LiveConnection } from "../src/live.mjs";

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  constructor() {
    super();
    queueMicrotask(() => this.emit("open"));
  }
  send(raw) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    if (event.type === "session.start")
      queueMicrotask(() => {
        this.emit(
          "message",
          JSON.stringify({
            type: "session.started",
            session: { id: "s", model: "gpt-live-1" },
          }),
        );
      });
    if (event.type === "session.close")
      queueMicrotask(() => {
        this.emit(
          "message",
          JSON.stringify({ type: "session.closed", usage: { seconds: 7 } }),
        );
      });
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  terminate() {
    this.close();
  }
}

test("overlapping close callers share one protocol close and finalized usage", async () => {
  const connection = new LiveConnection({
    key: "placeholder",
    WebSocketClass: Socket,
  });
  await connection.start({ model: "gpt-live-1" });
  const first = connection.close();
  const second = connection.close();
  assert.equal(first, second);
  assert.deepEqual(await first, { finalized: true, seconds: 7 });
  assert.equal(
    connection.socket.sent.filter((event) => event.type === "session.close")
      .length,
    1,
  );
  assert.equal(connection.socket.readyState, 3);
});

test("unexpected disconnection never claims finalized usage", async () => {
  const connection = new LiveConnection({
    key: "placeholder",
    WebSocketClass: Socket,
  });
  await connection.start({ model: "gpt-live-1" });
  connection.socket.emit(
    "message",
    JSON.stringify({ type: "session.usage.updated", usage: { seconds: 3 } }),
  );
  connection.socket.close();
  assert.deepEqual(await connection.close(), { finalized: false, seconds: 3 });
});
