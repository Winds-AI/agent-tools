# Pi Session MD

Convert a pi session file (`~/.pi/agent/sessions/**/*.jsonl`) into a compact, un-noisy markdown transcript in the OS temp dir, and print the path. Designed for one use: an agent (or you) points at a long session whose details were lost to compaction — this recovers them cheaply.

A 99 MB raw session (~73M tokens as JSONL) becomes a ~100 KB markdown file (~98K tokens) — the difference between "can't read it back" and "fits in context". The markdown keeps everything meaningful (user messages, assistant text, thinking, tool calls + results, durations, errors) and drops the JSONL envelope (repeated keys, usage/cost objects, escaping).

## Usage

Requires Python 3 (stdlib only — `json`, `sys`, `os`, `tempfile`, `uuid`, `datetime`). No dependencies.

```bash
python3 pi-session-md.py /path/to/session.jsonl
```

Prints the path of the written `.md` file (e.g. `/var/folders/.../T/pi-session-9158089d.md`). Read that file to inspect the transcript.

## Output format

```markdown
## meta (2026-08-19T06:13:17.016Z)
Model changed -> deepseek/deepseek-v4-flash

## user (2026-08-19T06:13:40.845Z)
remove the model favorite extension...

## assistant (2026-08-19T06:13:45.890Z)
### thinking
The user wants to remove a "model favorite" extension...

### tool_call: bash
```json
{"command": "ls ~/.pi/agent/"}
```

## tool_result: bash (2026-08-19T06:13:45.917Z)
auth.json
...
```

- Every user / assistant / tool-result message is preserved — nothing is skipped, empty ones are marked `(empty)` / `(no text)`.
- Tool results >2000 chars are wrapped in `<details>`; errors are marked `ERROR:`; tool duration is computed from the call/result timestamps.
- Images are counted, not dumped (`N image(s) hidden`).
- The temp dir is the same one pi uses: Node `os.tmpdir()` == Python `tempfile.gettempdir()` (`$TMPDIR` on macOS/Linux, `%TEMP%` on Windows).

## How it works

Reads the JSONL line-by-line, tolerating any malformed lines, and maps each line type:

| JSONL `type` | Markdown |
|---|---|
| `session` | skipped (header) |
| `model_change` | `## meta` |
| `thinking_level_change` | `## meta` |
| `summary` (compaction) | `## meta` |
| `message` role `system`/`developer` | `## system` |
| `message` role `user` | `## user` |
| `message` role `assistant` | `## assistant` (+ `### thinking`, `### tool_call: <name>`) |
| `message` role `toolResult` | `## tool_result: <name>` (+ duration, error) |

## What can break this (pi version 0.84.2)

This script depends on pi's **session file format** (JSONL schema). It was written against **pi v0.84.2**. If pi changes any of the following, the script will silently produce wrong/empty output (it never crashes — it skips unparseable lines):

1. **Line types** — `session`, `model_change`, `thinking_level_change`, `summary`, `message`. New entry types (hooks, custom) are currently ignored; if a new type carries meaningful content it would be dropped.
2. **Message roles** — `user`, `assistant`, `toolResult` (plus `system`/`developer` handled). A renamed role (e.g. `tool`) would vanish.
3. **Content block shapes** — assistant blocks are `{type: text|thinking|toolCall}`; tool results are `{type: text}`. A new block type (e.g. `image` inline) is only counted, not rendered; renamed keys (`arguments`, `text`, `thinking`) would be lost.
4. **Tool call linkage** — durations are derived by matching `toolCallId` on the assistant's `toolCall` block id to the `toolResult` message. If pi stops emitting `toolCallId`, durations silently disappear (everything else still works).
5. **Timestamp format** — durations parse `ISO 8601` timestamps (`2026-08-19T06:13:45.917Z`). A format change breaks only durations.
6. **Temp dir resolution** — `tempfile.gettempdir()` mirrors Node `os.tmpdir()` today; if pi switched to a custom temp root (e.g. `~/.pi/tmp`), the file would land in a different dir than pi's — the printed path is still absolute and readable, so this is cosmetic unless pi's tool runs sandboxed.
7. **Message key location** — timestamps may live at line level (`d.timestamp`) or message level (`m.timestamp`); both are checked. If pi moved them, timestamps in headers vanish (content unaffected).

**Symptom checklist:** if the output md is empty or missing sections, the schema changed — diff the first few JSONL lines against the table above.

## License

MIT
