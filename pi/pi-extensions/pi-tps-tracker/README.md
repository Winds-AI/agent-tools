# TPS Tracker

Minimal extension for pi: shows time-to-first-delta (TTFD) and tokens/sec (TPS) live in the footer while the AI responds, so you can see real-time generation speed for any pi model.

Updates during streaming (on every output delta), not just after the turn completes. Averages are computed over the last 15 assistant responses (tool calls included) via a sliding window, so long sessions stay responsive and cheap. All stats are in-memory only — no files, no persistence.

## Install

Requires Node.js 22+.

```bash
pi install git:github.com/Winds-AI/agent-tools
```

To install only this extension from a local clone, use `pi install ./pi/pi-extensions/pi-tps-tracker` from the repository root. Restart Pi after installation.

## Display

```
ttfd 0.8s  87 tok/s (117 tok / 1.3s, last 1)
```

| Part | Meaning |
|------|---------|
| `ttfd` | Time to first delta for the most recent response |
| `tok/s` | Average generation speed over the sliding window |
| `tok / s` | Tokens and streaming time in the window |
| `last N` | Number of responses in the window (max 15) |

Shows zeros (`ttfd -- 0 tok/s (0 tok / 0.0s, last 0)`) before the first response; `…` suffix while streaming.

## License

MIT
