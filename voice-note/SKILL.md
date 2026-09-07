---
name: voice-note
description: Live voice dictation that turns speech into a structured document. Use when the user wants to speak their thoughts and have them captured, organized, and maintained as a working document in real time.
---

# voice-note

Live dictation: the user speaks, the tool transcribes locally, and you maintain a
**structured working document** that stays useful as the user continues talking.
The document is external memory, not a transcript dump.

## Tool

Choose the command for the current environment:

```bash
# macOS, Linux, or WSL
python3 ~/.agents/skills/voice-note/scripts/vn.py <command>

# native Windows PowerShell
uv run --no-project --python 3.12 "$env:USERPROFILE\.agents\skills\voice-note\scripts\vn.py" <command>
```

The examples below use the POSIX form. Substitute the PowerShell form on
native Windows, and use that same form throughout the session.

Treat the runtime as a closed tool during a live session. Do not inspect or
modify its scripts while operating it.

If setup has not been completed, read [SETUP.md](SETUP.md) and perform only the
instructions for the current OS. Before every live session, read
[OPERATING.md](OPERATING.md).

## Workflow — two phases

### Phase 1 — setup

Do all session planning before the user starts speaking:

1. Choose an absolute transcript path and working-document path. Default to
   `transcript.txt` and `notes.md` in the current working directory.
2. Agree on a stop phrase. Default: `end voice note`.
3. Stop any stale session:
   ```bash
   python3 ~/.agents/skills/voice-note/scripts/vn.py stop
   ```
4. Start this session:
   ```bash
   python3 ~/.agents/skills/voice-note/scripts/vn.py start --transcript /absolute/path/transcript.txt
   ```
   The tool opens the local microphone page automatically.
5. Create the working document and tell the user the session is live and what
   stop phrase to say.

Enter Phase 2 immediately. Do not wait for another chat message.

### Phase 2 — live loop

Repeat this exact cycle:

```text
1. python3 ~/.agents/skills/voice-note/scripts/vn.py -p -t 15
2. Exit 1: no new speech; return to step 1 silently.
3. Exit 0: integrate every printed line into the working document.
4. After the document write succeeds:
   python3 ~/.agents/skills/voice-note/scripts/vn.py -c
5. Return to step 1.
```

If the stop phrase appears, integrate and commit that final batch first, then
follow the stop procedure in `OPERATING.md`.
