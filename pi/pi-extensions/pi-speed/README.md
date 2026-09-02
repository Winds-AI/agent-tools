# Pi Speed

Two readouts, one extension:

1. **Speed** — rolling-window tokens/sec, live in the footer while the model streams and static after each response. The window covers the last 15 assistant responses (tool-call turns included), so it reacts to model/provider changes quickly and stays O(1) regardless of session length. In-memory only.
2. **Timer** — a live `⏱ 4m 21s` counter below the composer while the agent works, starting at each new prompt. When the run settles, a `⏱ worked for 4m 21s` line is appended to the transcript as a custom session entry — it is rendered by this extension on reload, `/resume`, and restart. Only the final duration is persisted (as a `custom` entry, which never enters LLM context); the live ticking is in-memory.

## Install

Requires Node.js 22+.

```bash
git clone https://github.com/Winds-AI/agent-tools.git
cd agent-tools
pi install ./pi/pi-extensions/pi-speed
```

Restart Pi after installation.

## Display

Footer while streaming (live):

```
87 tok/s (last 15)  ⏱ 1m 03s…
```

Footer after the run settles:

```
74 tok/s (last 15)  worked for 4m 21s
```

Transcript line, persisted and re-rendered on every session load:

```
⏱ worked for 4m 21s
```

- `tok/s` is the rolling average over the last 15 responses: total output tokens ÷ total streaming milliseconds.
- The live ticker ticks once per second and disappears when the run ends; the final number takes its place.
- Runs shorter than 1 second (instant answers, immediate failures) are not persisted.

## Notes

- Renamed from `pi-tps-tracker`: it no longer tracks only TPS, and it dropped the TTFD readout in favor of the elapsed timer.
- The persisted entry uses pi's `custom` entry type (`customType: "pi-speed:worked-for"`), so it is excluded from model context and costs nothing token-wise. Shape:

```json
{
  "seconds": 6,
  "outputTokens": 20,
  "streamMs": 4200,
  "model": "crofai/glm-5.3-flash"
}
```

| Field | Meaning |
|---|---|
| `seconds` | Total wall-clock duration of the turn (prompt → settled), including tool execution |
| `outputTokens` | Provider-reported output tokens of the turn (all assistant responses summed) |
| `streamMs` | Pure generation time: first token → end for every assistant response in the turn, summed. Excludes tool execution and between-turn latency |
| `model` | `provider/model-id` that served the turn |

For a near-accurate generation speed, compute `outputTokens / (streamMs / 1000)` —
this is the same measure pi's live `tok/s` footer shows. pi itself persists
neither duration; without these entries the data is lost after the session.

## License

MIT
