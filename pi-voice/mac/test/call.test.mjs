import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveCall, LIVE_ENDPOINT, LIVE_MODEL } from "../src/call.mjs";

const auth = { token: "token-1", accountId: "acct-1", source: "test" };
const SDP_ANSWER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

function mockFetch({ status = 201, body = SDP_ANSWER, location = "/v1/realtime/calls/rtc_1" } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      status,
      headers: { get: (name) => (name.toLowerCase() === "location" ? location : undefined) },
      text: async () => body,
    };
  };
  return { calls, impl };
}

test("creates a call with the Codex identity headers and session shape", async () => {
  const { calls, impl } = mockFetch();
  const result = await createLiveCall({
    sdp: "v=0 offer",
    instructions: "instructions",
    voice: "cove",
    version: "9.9.9",
    auth,
    fetchImpl: impl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, LIVE_ENDPOINT);
  const headers = calls[0].options.headers;
  assert.equal(headers.Authorization, "Bearer token-1");
  assert.equal(headers["ChatGPT-Account-Id"], "acct-1");
  assert.equal(headers.originator, "codex_cli_rs");
  assert.equal(headers.version, "9.9.9");
  assert.equal(headers["OpenAI-Alpha"], "quicksilver=v2");
  assert.equal(headers["User-Agent"], "codex_cli_rs/9.9.9");
  const session = calls[0].body.session;
  assert.equal(calls[0].body.sdp, "v=0 offer");
  assert.equal(session.model, LIVE_MODEL);
  assert.deepEqual(session.audio, { output: { voice: "cove" } });
  assert.deepEqual(session.delegation, { type: "client", ack_filler: false });
  assert.equal("initial_items" in session, false);
  assert.equal(result.answer, SDP_ANSWER);
  assert.equal(result.callId, "/v1/realtime/calls/rtc_1");
});

test("seeds spoken history when available", async () => {
  const { calls, impl } = mockFetch();
  const initialItems = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
  await createLiveCall({ sdp: "v=0 offer", instructions: "i", version: "9.9.9", auth, initialItems, fetchImpl: impl });
  assert.deepEqual(calls[0].body.session.initial_items, initialItems);
});

test("reports rejected credentials clearly", async () => {
  const { impl } = mockFetch({ status: 403, body: '{"detail":"forbidden"}' });
  await assert.rejects(
    createLiveCall({ sdp: "v=0 offer", instructions: "i", version: "9.9.9", auth, fetchImpl: impl }),
    /rejected the voice credential/,
  );
});

test("rejects an empty SDP answer", async () => {
  const { impl } = mockFetch({ status: 201, body: "" });
  await assert.rejects(
    createLiveCall({ sdp: "v=0 offer", instructions: "i", version: "9.9.9", auth, fetchImpl: impl }),
    /SDP answer/,
  );
});
