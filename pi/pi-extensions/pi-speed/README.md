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
{ "seconds": 6, "outputTokens": 20, "model": "crofai/glm-5.3-flash" }
```

`seconds` is the turn duration (prompt → settled), `outputTokens` the total
provider-reported output tokens of the turn, `model` the provider/model that
served it. Because pi does not persist streaming durations anywhere, these
entries are what make historical per-model tok/s computable after the fact:
`outputTokens / seconds` gives a lower-bound estimate (it includes
tool-execution time inside the turn).

## License

MIT
