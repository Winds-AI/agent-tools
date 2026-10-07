# Pi Speed

Two readouts, one extension:

1. **Speed** — effective output throughput in the footer, updated after each assistant response. The window covers the last 15 measured assistant responses (tool-call responses included): total reported output tokens divided by total model-call time. It includes hidden reasoning and request latency but excludes tool execution. In-memory only, with O(1) work regardless of session length.
2. **Timer** — a live `⏱ 4m 21s` counter below the composer while the agent works, starting at each new prompt. When the run settles, a `⏱ worked for 4m 21s` line is appended to the transcript as a custom session entry — it is rendered by this extension on reload, `/resume`, and restart. Only the final duration is persisted (as a `custom` entry, which never enters LLM context); the live ticking is in-memory.

## Install

Requires Node.js 22.19+ and Pi with the `before_provider_request` extension event.

```bash
git clone https://github.com/Winds-AI/agent-tools.git
cd agent-tools
pi install ./pi/pi-extensions/pi-speed
```

Restart Pi after installation, or run `/reload` after updating an existing installation.

## Display

While the agent works, the timer ticks inside the working row, beside the
spinner:

```
── ⠇ Working · ⏱ 36s ──────────────────────────────────────────
```

The footer carries the rolling speed, refreshed after each response. While
the next response is streaming or tools are running, it keeps the last
completed measurement (or `-- tok/s` before the first one):

```
145 tok/s
```

When the turn settles, the working row returns to pi's default and a
transcript line is appended (persisted, re-rendered on every session load):

```
⏱ worked for 41s
```

- `tok/s` is **effective output throughput**, not pure token-decoding speed:
  total reported output tokens ÷ total model-call seconds over the last 15
  measured responses. Each call is timed from `before_provider_request` to
  the assistant's `message_end` using a monotonic clock. This includes
  network/provider latency, queueing, prefill, and hidden reasoning; tool
  execution and pauses between calls are excluded.
- Pi's reported output count already includes reasoning tokens; they are
  not added again. Responses without a positive finite output count or
  elapsed time are skipped, not estimated from text length. Failed/aborted
  responses contribute only if Pi reports actual output and valid timing.
- One assistant response is one sample, even when it contains parallel or
  nested tool calls. This is a response-count window, not a fixed-time
  window. It continues across model changes and is not a per-model metric.
- Speed is in-memory only — not persisted. The footer is not a live
  per-token estimate.
- The timer starts fresh with every user message and covers the whole turn
  (tool calls included). It lives beside the working indicator while the
  agent works, then only the transcript line remains.
- Runs shorter than 1 second (instant answers, immediate failures) are not
  persisted.

## Notes

- Renamed from `pi-tps-tracker`: it no longer tracks only TPS, and it dropped the TTFD readout in favor of the elapsed timer.
- Speed (`tok/s`) is **in-memory only** — the rolling window lives for the current session and is not persisted anywhere.
- The timer persists one `custom` entry per turn (`customType: "pi-speed:worked-for"`), excluded from model context and costing nothing token-wise:

```json
{ "seconds": 6 }
```

`seconds` is the total wall-clock duration of the turn (prompt → settled),
including tool execution. It is what the `⏱ worked for 6s` transcript line
renders on reload, `/resume`, and restart.

## Tests

Run the offline regression suite from this directory:

```bash
npm test
```

The tests execute the extension with mocked Pi events and clocks. No API
keys, network requests, or extra dependencies are needed.

## License

MIT
