# OX-Alpha Continue

Keeps Pi's agent loop running when the **OX-Alpha** model (any provider) ends a
turn with an empty response: raw stop reason `"stop"` with no text and no tool
calls, typically right after tool results, as if the deployment dropped the
continuation.

Instead of queueing a synthetic "Continue." user message (which would pollute
the transcript and the model's context), this extension **reclassifies** the
empty response as a transient server error via Pi's `message_end` replacement
hook. Pi's built-in auto-retry machinery then takes over: it drops the bad
message from agent state, waits with exponential backoff, and re-enters the
agent loop with `agent.continue()` — the same no-user-message continuation path
OpenCode uses for unknown finish reasons. Bounded by the retry budget in Pi's
retry settings; no infinite loops.

## Install

Clone the collection, then install this package by local path:

```bash
git clone https://github.com/Winds-AI/pi-extensions.git
pi install ./pi-extensions/ox-alpha-continue
```

Restart Pi after installation.

Alternatively, copy `index.ts` into `~/.pi/agent/extensions/`.

## Behavior

- Only triggers when the active model matches **OX-Alpha** (`ox-alpha` in the
  model id or name — covers `stealth/ox-alpha` on OpenRouter, `ox-alpha-free`
  on OpenCode Go, and any other provider serving it). Other models are never
  touched.
- Only triggers on the pathological case: `stopReason: "stop"` +
  `rawStopReason: "stop"` with no text and no tool calls. Normal answers, tool
  calls, `length` stops, errors, and aborts pass through untouched.
- The empty response is persisted in session history as an
  `error` message (`server error: OX-Alpha returned an empty stop response;
  auto-continuing`), so the workaround is visible in the session file.
- Bounded by Pi's retry settings (default: 3 retries, 2s exponential backoff).
  Esc cancels the backoff. If retries are exhausted, Pi surfaces the error
  normally instead of silently stalling.

## How it works

```
OX-Alpha empty stop
        │
        ▼
message_end hook ──► reclassify to stopReason:"error" (in place)
        │
        ▼
Pi's _handlePostAgentRun ──► isRetryableAssistantError("server error: …") ✓
        │
        ▼
_prepareRetry: drop message from agent state, backoff, agent.continue()
        │
        ▼
loop re-enters with the same conversation — no user message added
```

The `errorMessage` is crafted to match Pi's retryable-error classifier
(`server.?error` pattern in `@earendil-works/pi-ai/utils/retry`), so the
built-in retry path treats it exactly like a transient provider failure.

## License

MIT
