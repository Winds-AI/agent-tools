# Pi Session MD

Convert a pi session file (`~/.pi/agent/sessions/**/*.jsonl`) into a compact,
un-noisy markdown transcript in the OS temp dir, and print the path. Designed
for one use: an agent (or you) points at a long session whose details were
lost to compaction — this recovers them cheaply.

A 99 MB raw session (~73M tokens as JSONL) becomes a ~100 KB markdown file
(~98K tokens) — the difference between "can't read it back" and "fits in
context". The markdown keeps everything meaningful (user messages, assistant
text, thinking, tool calls + results, durations, errors) and drops the JSONL
envelope (repeated keys, usage/cost objects, escaping, base64 payloads).

## Usage

Requires Python 3 (stdlib only). No dependencies.

```bash
python3 pi-session-md.py /path/to/session.jsonl
```

Prints the path of the written `.md` file (e.g.
`/tmp/pi-session-9158089d.md`). Read that file to inspect the transcript.

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

## tool_result: bash (+0.53s) (2026-08-19T06:13:45.917Z)
auth.json
...
```

## Behavior notes

- **Branch order, not file order.** Entries are emitted along the session's
  current branch (walked from the leaf to the root via `parentId`), matching
  what pi would send back to a model — abandoned branch lines never interleave
  into the transcript.
- Preserved: user/assistant/system messages, thinking, tool calls with
  arguments, tool results (with duration from call→result timestamps), error
  and abort stop reasons, compaction and branch summaries, model/thinking
  changes, extension `custom`/`custom_message` entries, user `!` bash runs.
- Tool results >2000 chars go into `<details>`; code fences are widened past
  any backtick run inside the content so nothing breaks out.
- Images are counted, not dumped (`N image(s) hidden`).
- The temp dir is the same one pi uses: Node `os.tmpdir()` ==
  Python `tempfile.gettempdir()` (`$TMPDIR` on macOS/Linux, `%TEMP%` on
  Windows).

Written against the pi v0.84.4 session format. The script never crashes on
schema drift — unknown entry types and roles are skipped, malformed JSONL
lines are tolerated, and it prints a warning if nothing renderable is found.

## License

MIT
