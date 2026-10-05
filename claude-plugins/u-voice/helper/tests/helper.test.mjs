import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createHelperServer } from "../server.mjs";

const TOKEN = "test-bridge-token-0123456789abcdef0123456789abcdef";

async function withBridge(run, callFactoryOverride, options = {}) {
  const stdout = [];
  const liveSends = [];
  const calls = [];
  const bridge = createHelperServer({
    token: TOKEN,
    port: 0,
    delegationDelayMs: 0,
    ...options,
    stdout: (line) => stdout.push(JSON.parse(line)),
    onLiveSend: (record) => liveSends.push(record),
    callFactory: callFactoryOverride ?? (async (args) => {
      calls.push(args);
      return { answer: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n" };
    }),
  });
  await bridge.listen();
  const base = "http://127.0.0.1:" + bridge.server.address().port;
  try {
    await run({ bridge, base, stdout, liveSends, calls });
  } finally {
    await bridge.close();
  }
}

async function post(base, path, body, token = TOKEN, extraHeaders = {}) {
  return fetch(base + path, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

async function startLive(base, callId) {
  const response = await post(base, "/live/call", { callId, sdp: "v=0\r\no=- offer\r\n", voice: "cove" });
  assert.equal(response.status, 200);
  return response.json();
}

async function stream(base) {
  const controller = new AbortController();
  const response = await fetch(base + "/stream", {
    headers: { Authorization: "Bearer " + TOKEN }, signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(type) {
      for (;;) {
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block.split("\n").find((line) => line.startsWith("data: "));
          if (data) {
            const event = JSON.parse(data.slice(6));
            if (event.type === type) return event;
          }
        }
        const { value, done } = await reader.read();
        assert.equal(done, false, "event stream closed before requested event");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async close() { controller.abort(); await reader.cancel().catch(() => {}); },
  };
}

test("terminal connect is authenticated, queued until a browser attaches, and cannot reuse stale controls", { timeout: 5000 }, async () => {
  await withBridge(async ({ bridge, base, calls }) => {
    assert.equal((await post(base, "/control", { action: "connect" }, "")).status, 401);
    assert.equal((await post(base, "/control", { action: "connect" }, "wrong-token")).status, 401);
    assert.equal((await post(base, "/control", { action: "arbitrary-action" })).status, 400);
    assert.equal((await post(base, "/control", { action: "toggle-mute" })).status, 409);
    const connectResponse = await post(base, "/control", { action: "connect" });
    assert.equal(connectResponse.status, 202);
    const connect = await connectResponse.json();
    assert.equal(connect.pending, true);
    assert.equal(connect.phase, "connecting");
    assert.equal(calls.length, 0, "terminal intent alone must not create a provider call");
    assert.equal((await (await post(base, "/control", { action: "connect" })).json()).controlId, connect.controlId);

    const browser = await stream(base);
    try {
      const control = await browser.next("control");
      assert.equal(control.action, "connect");
      assert.equal(control.controlId, connect.controlId);
      assert.equal((await post(base, "/live/call", {
        controlId: "stale-control", callId: "stale-call", sdp: "v=0\r\n",
      })).status, 409);
      const call = await post(base, "/live/call", {
        controlId: connect.controlId, callId: "controlled-call", sdp: "v=0\r\n",
      });
      assert.equal(call.status, 200);
      const live = await call.json();
      assert.equal(calls.length, 1);
      assert.equal(bridge.state.pendingConnect, undefined);
      assert.equal((await (await post(base, "/control", { action: "connect" })).json()).alreadyActive, true);
      assert.equal((await post(base, "/control", { action: "toggle-mute" })).status, 409, "SDP answer is not mic readiness");
      await post(base, "/live/cancel", { sessionId: live.sessionId });
      const nextConnect = await (await post(base, "/control", { action: "connect" })).json();
      assert.notEqual(nextConnect.controlId, connect.controlId);
      assert.equal((await post(base, "/live/call", {
        controlId: connect.controlId, callId: "old-control-new-call", sdp: "v=0\r\n",
      })).status, 409);
      assert.equal(calls.length, 1);
    } finally { await browser.close(); }
  });
});

test('debounce keeps trailing constraints but cannot regain speech after typed input', async () => {
  await withBridge(async ({ base, stdout, liveSends }) => {
    const live = await startLive(base, 'debounced');
    const send = event => post(base, '/live/event', { sessionId: live.sessionId, event });
    await send({ type: 'bridge.datachannel.open' });
    await send({ type: 'input_transcript.added', event_id: 'first', item: { text: 'Fix the parser' } });
    await send({ type: 'delegation.created', item: { id: 'old-task', target: 'client', task: 'Fix parser' } });
    await send({ type: 'input_transcript.added', event_id: 'last', item: { text: ' and preserve the API' } });
    await send({ type: 'input_transcript.added', event_id: 'last', item: { text: ' and preserve the API' } });
    assert.equal(stdout.filter(e => e.type === 'delegate').length, 0);
    await post(base, '/agent-events', { events: [{ kind: 'input', origin: 'typed', text: 'Use my typed direction now' }] });
    await new Promise(resolve => setTimeout(resolve, 70));
    const request = stdout.find(e => e.type === 'delegate');
    assert.equal(request.watermark, 2);
    assert.equal(request.maySpeak, false);
    assert.equal(stdout.filter(e => e.type === 'transcript' && e.final).length, 1);
    await post(base, '/agent-events', { events: [
      { kind: 'delivery', requestId: request.id, state: 'accepted' },
      { kind: 'final', text: 'Old result', requestIds: [request.id], speak: true },
    ] });
    assert.equal(liveSends.at(-1).event.channel, 'commentary');
  }, undefined, { delegationDelayMs: 30, captionDelayMs: 1000 });
});

test('final speech targets the newest observed delegation and buffered old speech is discarded', async () => {
  await withBridge(async ({ base, stdout, liveSends, calls }) => {
    const live = await startLive(base, 'routing');
    const send = event => post(base, '/live/event', { sessionId: live.sessionId, event });
    for (const [id, text] of [['older', 'First task'], ['newer', 'Changed task']]) {
      await send({ type: 'input_transcript.added', item: { text } });
      await send({ type: 'turn.done' });
      await send({ type: 'delegation.created', item: { id, target: 'client', task: text } });
    }
    const requests = stdout.filter(e => e.type === 'delegate');
    await post(base, '/agent-events', { events: [
      ...requests.map(r => ({ kind: 'delivery', requestId: r.id, state: 'accepted' })),
      { kind: 'final', text: 'Current answer', requestIds: requests.map(r => r.id), speak: true },
    ] });
    await send({ type: 'bridge.datachannel.open' });
    assert.equal(liveSends.at(-1).event.delegation_item_id, 'newer');
    assert.equal(liveSends.at(-1).event.channel, 'speakable');
    assert.ok(calls[0].initialItems.some(item => item.content?.some(block => block.text === 'Existing typed task')));
  }, undefined, { initialItems: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Existing typed task' }] }] });
  await withBridge(async ({ base, stdout, liveSends }) => {
    const live = await startLive(base, 'buffered');
    const send = event => post(base, '/live/event', { sessionId: live.sessionId, event });
    await send({ type: 'input_transcript.added', item: { text: 'Do work' } });
    await send({ type: 'delegation.created', item: { id: 'buffered-request', target: 'client', task: 'Do work' } });
    const request = stdout.find(e => e.type === 'delegate');
    await post(base, '/agent-events', { events: [
      { kind: 'delivery', requestId: request.id, state: 'accepted' },
      { kind: 'final', text: 'Buffered obsolete answer', requestIds: [request.id], speak: true },
      { kind: 'input', origin: 'typed', text: 'Do something else' },
    ] });
    await send({ type: 'bridge.datachannel.open' });
    assert.equal(liveSends.some(r => r.event.channel === 'speakable'), false);
    assert.ok(liveSends.some(r => r.event.content[0].text.includes('Do something else')));
  });
});

test("mute controls carry desired state, reject stale acknowledgements, and replay idempotently", { timeout: 5000 }, async () => {
  await withBridge(async ({ bridge, base }) => {
    const live = await startLive(base, "mute-live");
    const event = (value, sessionId = live.sessionId) => post(base, "/live/event", { sessionId, event: value });
    await event({ type: "bridge.datachannel.open" });
    await event({ type: "bridge.mic.ready" });
    const browser = await stream(base);
    try {
      assert.equal((await post(base, "/control", { action: "toggle-mute", sessionId: "old-session" })).status, 409);
      const muteResponse = await post(base, "/control", { action: "toggle-mute", sessionId: live.sessionId });
      assert.equal(muteResponse.status, 202);
      const mute = await muteResponse.json();
      assert.equal(mute.muted, true);
      const control = await browser.next("control");
      assert.equal(control.action, "set-mute");
      assert.equal(control.muted, true);
      assert.equal(control.liveSessionId, live.sessionId);
      assert.equal(bridge.snapshot().status.microphoneMuted, false, "terminal intent is not microphone acknowledgement");
      assert.equal(bridge.snapshot().status.desiredMicrophoneMuted, true);
      assert.equal((await event({ type: "bridge.mic.muted", controlId: mute.controlId })).status, 200);
      assert.equal(bridge.snapshot().status.microphoneMuted, true);
      assert.equal(bridge.snapshot().status.phase, "muted");
      await event({ type: "bridge.mic.ready" });
      assert.equal(bridge.snapshot().status.microphoneMuted, true, "duplicate readiness does not unmute");

      const replayBrowser = await stream(base);
      try {
        const replay = await replayBrowser.next("control");
        assert.equal(replay.controlId, control.controlId);
        assert.equal(replay.revision, control.revision);
        assert.equal(replay.muted, true);
      } finally { await replayBrowser.close(); }

      const unmute = await (await post(base, "/control", { action: "toggle-mute" })).json();
      assert.equal(unmute.muted, false);
      const next = await browser.next("control");
      assert.equal(next.muted, false);
      assert.ok(next.revision > control.revision);
      assert.equal((await event({ type: "bridge.mic.muted", controlId: mute.controlId })).status, 409);
      assert.equal((await event({ type: "bridge.mic.muted", controlId: unmute.controlId })).status, 409);
      assert.equal(bridge.snapshot().status.phase, "muted", "superseded or inconsistent acks do not change status");
      assert.equal((await event({ type: "bridge.mic.unmuted", controlId: unmute.controlId })).status, 200);
      assert.equal(bridge.snapshot().status.microphoneMuted, false);
      assert.equal(bridge.snapshot().status.phase, "listening");

      await post(base, "/live/cancel", { sessionId: live.sessionId });
      assert.equal((await post(base, "/control", { action: "toggle-mute" })).status, 409);
      const newer = await startLive(base, "new-live");
      assert.equal((await event({ type: "bridge.mic.unmuted", controlId: unmute.controlId })).status, 409);
      assert.notEqual(newer.sessionId, live.sessionId);
    } finally { await browser.close(); }
  });
});

test("browser responds to terminal controls without clicks, muting only microphone tracks", { timeout: 5000 }, async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  await withBridge(async ({ bridge, base, calls }) => {
    await post(base, "/control", { action: "connect" });
    const controllers = [];
    class BrowserAbortController extends AbortController {
      constructor() { super(); controllers.push(this); }
    }
    const elements = new Map();
    function element() {
      return {
        textContent: "", disabled: false, className: "", dataset: {}, listeners: {},
        classList: { add() {} }, addEventListener(name, handler) { this.listeners[name] = handler; },
        play: async () => {}, srcObject: null,
      };
    }
    for (const id of ["connect", "mute", "disconnect", "state-label", "state-dot", "detail", "captions", "remote-audio"]) {
      elements.set("#" + id, element());
    }
    const microphoneTrack = { enabled: false, stopped: false, stop() { this.stopped = true; } };
    let captureCount = 0;
    let microphoneError;
    let currentPeer;
    class BrowserPeer {
      constructor() { this.iceGatheringState = "complete"; currentPeer = this; }
      createDataChannel() { return { readyState: "open", close() {}, send() {} }; }
      addTransceiver() { return { sender: { async replaceTrack() {} } }; }
      async createOffer() { return { type: "offer", sdp: "v=0\r\n" }; }
      async setLocalDescription(offer) { this.localDescription = offer; }
      async setRemoteDescription() {}
      close() {}
    }
    const storage = new Map();
    runInNewContext(source, {
      location: { origin: base, pathname: "/", search: "", hash: "#token=" + TOKEN },
      sessionStorage: { setItem: (key, value) => storage.set(key, value), getItem: (key) => storage.get(key) },
      history: { replaceState() {} },
      document: { querySelector: (selector) => elements.get(selector) },
      window: { RTCPeerConnection: BrowserPeer, addEventListener() {} },
      RTCPeerConnection: BrowserPeer,
      navigator: { mediaDevices: { async getUserMedia() {
        captureCount++;
        if (microphoneError) throw microphoneError;
        return { getAudioTracks: () => [microphoneTrack], getTracks: () => [microphoneTrack] };
      } } },
      fetch, URL, URLSearchParams, TextDecoder, crypto: globalThis.crypto,
      AbortController: BrowserAbortController,
      setTimeout, clearTimeout,
    });
    async function until(predicate) {
      const deadline = Date.now() + 2500;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(predicate(), "browser did not acknowledge the requested control");
    }
    try {
      await until(() => bridge.snapshot().status.microphoneReady && microphoneTrack.enabled);
      assert.equal(calls.length, 1);
      assert.equal(captureCount, 1);
      assert.equal(elements.get("#state-label").textContent, "Listening");
      const mute = await (await post(base, "/control", { action: "toggle-mute" })).json();
      await until(() => bridge.snapshot().status.microphoneMuted && !microphoneTrack.enabled);
      assert.equal(elements.get("#state-label").textContent, "Muted");
      assert.equal(microphoneTrack.stopped, false, "mute should preserve capture for unmute");

      const oldControl = bridge.state.currentSession.muteControl;
      await post(base, "/control", { action: "toggle-mute" });
      await until(() => !bridge.snapshot().status.microphoneMuted && microphoneTrack.enabled);
      for (const response of bridge.state.streamClients) {
        response.write("data: " + JSON.stringify(oldControl) + "\n\n");
        response.write("data: " + JSON.stringify({ ...oldControl, revision: oldControl.revision + 100, liveSessionId: "ended-session" }) + "\n\n");
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(microphoneTrack.enabled, true, "replayed or stale controls must not re-mute");
      assert.notEqual(bridge.state.currentSession.muteControl.controlId, mute.controlId);

      elements.get("#mute").listeners.click();
      await until(() => bridge.snapshot().status.microphoneMuted && !microphoneTrack.enabled);
      elements.get("#disconnect").listeners.click();
      await until(() => microphoneTrack.stopped && !bridge.state.currentSession);
      assert.equal(elements.get("#remote-audio").srcObject, null);

      for (const [name, expected] of [
        ["NotAllowedError", "permission denied"],
        ["NotFoundError", "unavailable"],
        ["NotReadableError", "unavailable"],
      ]) {
        microphoneError = Object.assign(new Error("private browser device text must not escape"), { name });
        await post(base, "/control", { action: "connect" });
        await until(() => bridge.snapshot().status.phase === "error" && !bridge.state.currentSession);
        assert.match(bridge.snapshot().status.message, new RegExp(expected, "i"));
        assert.equal(bridge.snapshot().status.message.includes("private browser"), false);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(bridge.snapshot().status.phase, "error", "disconnect after browser failure must preserve terminal Error");
      }

      microphoneError = undefined;
      await post(base, "/control", { action: "connect" });
      await until(() => bridge.snapshot().status.microphoneReady);
      elements.get("#remote-audio").play = async () => { throw new Error("private playback text"); };
      currentPeer.ontrack({ streams: [{}] });
      await until(() => bridge.snapshot().status.phase === "error" && !bridge.state.currentSession);
      assert.match(bridge.snapshot().status.message, /playback failed/i);
      assert.equal(bridge.snapshot().status.message.includes("private playback"), false);
    } finally {
      for (const controller of controllers) controller.abort();
    }
  });
});

test("frontend failures require current ownership and preserve sanitized terminal Error after cancellation", async () => {
  await withBridge(async ({ base, bridge, stdout }) => {
    assert.equal((await post(base, "/live/failure", { callId: "x", code: "microphone_denied" }, "")).status, 401);
    assert.equal((await post(base, "/live/failure", { callId: "x", code: "raw exception text" })).status, 400);
    assert.equal((await post(base, "/live/failure", { callId: "unowned-call", code: "connection_failed" })).status, 409);
    const connect = await (await post(base, "/control", { action: "connect" })).json();
    assert.equal((await post(base, "/live/failure", {
      callId: "pre-call", controlId: "stale-control", code: "connection_failed",
    })).status, 409);
    assert.equal((await post(base, "/live/failure", {
      callId: "pre-call", controlId: connect.controlId, code: "microphone_unavailable", message: "raw-secret-text",
    })).status, 202);
    assert.equal(bridge.state.pendingConnect, undefined);
    assert.equal(bridge.snapshot().status.phase, "error");
    assert.match(bridge.snapshot().status.message, /microphone unavailable/i);
    await post(base, "/live/cancel", { callId: "pre-call" });
    assert.equal(bridge.snapshot().status.phase, "error");

    const live = await startLive(base, "owned-call");
    assert.equal((await post(base, "/live/failure", {
      callId: "another-call", sessionId: live.sessionId, code: "playback_failed",
    })).status, 409);
    assert.equal((await post(base, "/live/failure", {
      callId: "owned-call", sessionId: "old-session", code: "playback_failed",
    })).status, 409);
    assert.equal((await post(base, "/live/failure", {
      callId: "owned-call", sessionId: live.sessionId, code: "playback_failed", error: "private SDP and token",
    })).status, 202);
    assert.equal(bridge.state.currentSession, undefined);
    assert.match(bridge.snapshot().status.message, /playback failed/i);
    await post(base, "/live/cancel", { callId: "owned-call", sessionId: live.sessionId });
    assert.equal(bridge.snapshot().status.phase, "error");
    assert.equal(JSON.stringify(stdout).includes("private SDP"), false);
    assert.equal(JSON.stringify(stdout).includes("raw-secret-text"), false);
    assert.equal((await post(base, "/live/call", { callId: "owned-call", sdp: "v=0\r\n" })).status, 409);
  });
});

test("loopback routes authenticate controls, reject hostile origins, and bound request bodies", async () => {
  await withBridge(async ({ base }) => {
    const health = await fetch(base + "/health");
    assert.equal(health.status, 200);
    const publicState = await health.json();
    assert.deepEqual(Object.keys(publicState).sort(), ["live", "phase", "status"]);

    const noAuth = await fetch(base + "/state");
    assert.equal(noAuth.status, 401);
    const wrongToken = await post(base, "/agent-events", { events: [] }, "wrong-token");
    assert.equal(wrongToken.status, 401);

    const hostileOrigin = await post(base, "/agent-events", { events: [] }, TOKEN, {
      Origin: "https://evil.example",
    });
    assert.equal(hostileOrigin.status, 403);

    const oversized = await post(base, "/agent-events", { filler: "x".repeat(530_000) });
    assert.equal(oversized.status, 413);
  });
});

test("delegations deduplicate, retry after denial, and advance watermark only after acceptance", async () => {
  await withBridge(async ({ base, stdout }) => {
    const live = await startLive(base);
    const sendLive = (event) => post(base, "/live/event", { sessionId: live.sessionId, event });
    await sendLive({ type: "input_transcript.added", item: { text: " Fix the parser" } });
    await sendLive({ type: "output_transcript.added", item: { text: " I can handle that" } });
    await sendLive({ type: "input_transcript.added", item: { text: " and preserve the API" } });

    const delegation = {
      type: "delegation.created",
      item: { id: "live-delegation-1", target: "client", content: [] },
    };
    await sendLive(delegation);
    await sendLive(delegation);
    let emitted = stdout.filter((event) => event.type === "delegate");
    assert.equal(emitted.length, 1, "duplicate Live event must not enqueue twice");
    assert.match(emitted[0].text, /Fix the parser/);
    assert.ok(stdout.some(event => event.type === 'transcript' && event.role === 'A' && event.text.includes('I can handle that')));
    assert.match(emitted[0].text, /and preserve the API/);

    await post(base, "/agent-events", {
      events: [{ kind: "delivery", requestId: emitted[0].id, state: "waiting", mode: "steer" }],
    });
    let state = await (await fetch(base + "/state", { headers: { Authorization: "Bearer " + TOKEN } })).json();
    assert.equal(state.lastDelegatedWatermark, 0, "submitting or waiting does not commit the watermark");

    await post(base, "/agent-events", {
      events: [{ kind: "delivery", requestId: emitted[0].id, state: "denied", mode: "submit" }],
    });
    await sendLive(delegation);
    emitted = stdout.filter((event) => event.type === "delegate");
    assert.equal(emitted.length, 1, "a denied request ID stays deduplicated");

    await sendLive({
      type: "delegation.created",
      item: { id: "live-delegation-1-retry", target: "client", content: [{ type: "input_text", text: "Fix the parser and preserve the API" }] },
    });
    emitted = stdout.filter((event) => event.type === "delegate");
    assert.equal(emitted.length, 2, "a new Live delegation ID can retry the user's request");
    assert.notEqual(emitted[1].id, emitted[0].id);

    await post(base, "/agent-events", {
      events: [{ kind: "delivery", requestId: emitted[1].id, state: "accepted", mode: "submit", watermark: emitted[1].watermark }],
    });
    state = await (await fetch(base + "/state", { headers: { Authorization: "Bearer " + TOKEN } })).json();
    assert.equal(state.lastDelegatedWatermark, 3);
    assert.equal(state.delegations.find((item) => item.id === emitted[1].id).attempts, 1);
    assert.equal(state.receipts.at(-1).state, "accepted");

    await sendLive({ type: "input_transcript.added", item: { text: " Also keep the observed request" } });
    await sendLive({ type: "delegation.created", item: { id: "live-delegation-2", target: "client", task: "Keep this request" } });
    const second = stdout.filter((event) => event.type === "delegate").at(-1);
    await post(base, "/agent-events", {
      events: [{ kind: "delivery", requestId: second.id, state: "observed", mode: "steer", watermark: second.watermark }],
    });
    state = await (await fetch(base + "/state", { headers: { Authorization: "Bearer " + TOKEN } })).json();
    assert.equal(state.lastDelegatedWatermark, 4, "observed means the terminal accepted the request");
  });
});

test("finals use same-session delegation IDs and fall back to session context after reconnect", async () => {
  await withBridge(async ({ base, liveSends, calls }) => {
    const first = await startLive(base);
    await post(base, "/live/event", {
      sessionId: first.sessionId,
      event: { type: "input_transcript.added", item: { text: " Count the files" } },
    });
    await post(base, "/live/event", {
      sessionId: first.sessionId,
      event: { type: "delegation.created", item: { id: "first-live-id", target: "client", task: "Count the files" } },
    });
    const delegate = (await fetch(base + "/state", { headers: { Authorization: "Bearer " + TOKEN } })).json();
    const pending = (await delegate).delegations[0];
    await post(base, "/agent-events", {
      events: [{ kind: "delivery", requestId: pending.id, state: "accepted", mode: "submit" }],
    });
    await post(base, "/live/event", { sessionId: first.sessionId, event: { type: "bridge.datachannel.open" } });
    await post(base, "/agent-events", {
      events: [
        { kind: "delivery", requestId: pending.id, state: "complete", mode: "submit" },
        { kind: "tool", tool: "Read", status: "completed" },
        { kind: "final", text: "There are 12 files.", reason: "answer", isAborted: false, requestIds: [pending.id], speak: true },
      ],
    });
    assert.equal(liveSends.at(-1).event.type, "delegation.context.append");
    assert.equal(liveSends.at(-1).event.delegation_item_id, "first-live-id");

    await post(base, "/live/event", { sessionId: first.sessionId, event: { type: "bridge.closed" } });
    const second = await startLive(base);
    assert.ok(calls.at(-1).initialItems.some((item) =>
      item.content?.[0]?.text?.includes("There are 12 files."),
    ));
    await post(base, "/live/event", { sessionId: second.sessionId, event: { type: "bridge.datachannel.open" } });
    await post(base, "/agent-events", {
      events: [{ kind: "final", text: "The earlier result still has 12 files.", requestIds: [pending.id] }],
    });
    assert.equal(liveSends.at(-1).event.type, "session.context.append");
    assert.equal("delegation_item_id" in liveSends.at(-1).event, false);
    assert.equal(liveSends.at(-1).liveSessionId, second.sessionId);
    const state = await (await fetch(base + "/state", { headers: { Authorization: "Bearer " + TOKEN } })).json();
    assert.equal(state.latestFinal.reason, "answer");
    assert.match(state.latestFinal.text, /earlier result still has 12 files/);
    assert.equal(state.agentEvents.find((event) => event.kind === "tool").tool, "Read");
    assert.ok(state.outboundEvents.some((event) => event.type === "session.context.append"));
  });
});

test("empty aborted and error finals are announced without claiming success", async () => {
  await withBridge(async ({ base, liveSends }) => {
    const live = await startLive(base);
    await post(base, "/live/event", { sessionId: live.sessionId, event: { type: "bridge.datachannel.open" } });
    await post(base, "/agent-events", {
      events: [
        { kind: "final", text: "", reason: "aborted", isAborted: true },
        { kind: "final", text: "", reason: "error", isAborted: false },
      ],
    });
    const spoken = liveSends.map((item) => item.event.content?.[0]?.text).filter(Boolean);
    assert.ok(spoken.some((text) => text.includes("task was stopped")));
    assert.ok(spoken.some((text) => text.includes("reported an error")));
    assert.equal(spoken.some((text) => text.includes("completed successfully")), false);
    const state = await (await fetch(base + "/state", { headers: { Authorization: "Bearer " + TOKEN } })).json();
    assert.equal(state.latestFinal.reason, "error");
    assert.equal(state.latestFinal.isAborted, false);
    assert.ok(state.agentEvents.some((event) => event.reason === "aborted" && event.isAborted));
  });
});

test("offline delegate smoke route shares dedupe and acknowledgement behavior", async () => {
  await withBridge(async ({ base, stdout }) => {
    const first = await post(base, "/delegate", { id: "smoke-1", text: "Inspect this request." });
    assert.equal(first.status, 202);
    const duplicate = await post(base, "/delegate", { id: "smoke-1", text: "Inspect this request." });
    assert.equal((await duplicate.json()).duplicate, true);
    assert.equal(stdout.filter((event) => event.type === "delegate").length, 1);

    await post(base, "/agent-events", {
      events: [{ kind: "delivery", requestId: "smoke-1", state: "denied", mode: "submit" }],
    });
    const deniedDuplicate = await post(base, "/delegate", { id: "smoke-1", text: "Inspect this request." });
    assert.equal((await deniedDuplicate.json()).retried, false);
    assert.equal(stdout.filter((event) => event.type === "delegate").length, 1);
    await post(base, "/delegate", { id: "smoke-2", text: "Inspect this request again." });
    assert.equal(stdout.filter((event) => event.type === "delegate").length, 2);
    await post(base, "/agent-events", {
      events: [{ kind: "delivery", requestId: "smoke-2", state: "accepted", mode: "submit" }],
    });
    const state = await (await fetch(base + "/state", { headers: { Authorization: "Bearer " + TOKEN } })).json();
    assert.equal(state.delegations.find((item) => item.id === "smoke-2").state, "accepted");
    assert.equal(state.delegations.find((item) => item.id === "smoke-2").attempts, 1);
  });
});

test("call cancellation clears active sessions and tombstones pending call IDs", async () => {
  await withBridge(async ({ base }) => {
    const active = await startLive(base, "active-call-1");
    const disconnected = await post(base, "/live/cancel", {
      callId: "active-call-1",
      sessionId: active.sessionId,
    });
    assert.equal((await disconnected.json()).cancelled, true);
    assert.equal((await post(base, "/live/call", { callId: "active-call-1", sdp: "v=0\r\no=- stale\r\n" })).status, 409);
    assert.equal((await startLive(base, "active-call-2")).sessionId.length > 0, true);
  });

  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const callFactory = async ({ signal }) => {
    signalStarted();
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  };
  await withBridge(async ({ base, calls }) => {
    const pendingCall = post(base, "/live/call", { callId: "pending-call-1", sdp: "v=0\r\no=- offer\r\n" });
    await started;
    const cancelled = await post(base, "/live/cancel", { callId: "pending-call-1" });
    assert.equal((await cancelled.json()).cancelled, true);
    assert.equal((await pendingCall).status, 409);
    const lateRetry = await post(base, "/live/call", { callId: "pending-call-1", sdp: "v=0\r\no=- offer\r\n" });
    assert.equal(lateRetry.status, 409);
    assert.equal(calls.length, 0);
  }, callFactory);
});
