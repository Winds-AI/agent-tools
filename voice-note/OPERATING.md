# Operating guidelines

Read this file before starting each live session.

## Live-loop rules

- Trust the running pipeline. A poll timeout means silence; poll again without
  checking the server, browser, microphone, or transcript.
- Never re-read or reprocess the raw transcript. `vn -p` returns the complete
  uncommitted delta until `vn -c` commits it.
- Integrate; do not dump. Add, edit, move, or remove content so the document
  reflects the user's current meaning.
- Correct high-confidence ASR mistakes from context, including product names,
  abbreviations, and sentences split at chunk boundaries. Mark genuine
  uncertainty as `[?word?]` instead of inventing an answer.
- Preserve important qualifications, decisions, corrections, numbers, names,
  and unresolved questions. Remove filler and stale statements superseded by a
  later correction.
- Keep the document lean and scannable. The document is the live output; do not
  send routine progress messages in chat.
- Spend reasoning on the content, not the plumbing.

## Commit rule

Commit the transcript cursor only after the document write succeeds:

```bash
python3 ~/.agents/skills/voice-note/scripts/vn.py -c
```

If the write fails or is interrupted, do not commit. The next poll must return
the same delta so it cannot be lost.

## Stop

When the stop phrase appears, or the user stops the session in chat:

- Treat an obvious standalone ASR near-match for the agreed stop phrase as the
  stop phrase; for example, `and voice note` may be `end voice note`. Do not
  require letter-perfect transcription.

1. Integrate and commit any printed transcript lines.
2. Run:
   ```bash
   python3 ~/.agents/skills/voice-note/scripts/vn.py stop
   ```
3. Do one final document pass: reconcile the last lines, remove artifacts, and
   leave unresolved items visible.
4. Tell the user the session ended and give the document path.
